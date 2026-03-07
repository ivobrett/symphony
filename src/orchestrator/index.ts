import { Issue, LiveSession, OrchestratorState, RunningEntry, ServiceConfig } from '../domain';
import { loadWorkflow } from '../workflow/loader';
import { buildServiceConfig, validateDispatchConfig } from '../workflow/config';
import { watchWorkflow } from '../workflow/watcher';
import { LinearClient } from '../tracker/linear';
import { TrackerClient } from '../tracker/client';
import { prepareWorkspace, removeWorkspace } from '../workspace/manager';
import { runHook } from '../workspace/hooks';
import { runAgent } from '../agent/runner';
import { createInitialState, addRunning, removeRunning, unclaim, claim, updateLiveSession, removeRetry, accumulateRuntime } from './state';
import { isEligible, sortForDispatch } from './dispatch';
import { reconcileStalls, reconcileTrackerStates } from './reconcile';
import { scheduleRetry, computeBackoffMs } from './retry';
import { logger, issueLogger } from '../observability/logger';
import { RuntimeSnapshot, buildSnapshot } from '../observability/snapshot';

export type DispatchFn = (issue: Issue, attempt: number | null) => void;

export interface OrchestratorOptions {
  workflowPath: string;
  serverPort?: number;
  onSnapshot?: (snapshot: RuntimeSnapshot) => void;
}

export class Orchestrator {
  private state!: OrchestratorState;
  private config!: ServiceConfig;
  private tracker!: TrackerClient;
  private workflowPath: string;
  private promptTemplate!: string;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private stopWatcher: (() => void) | null = null;
  private serverPort: number | null;
  private onSnapshot?: (snapshot: RuntimeSnapshot) => void;
  private shutdownRequested = false;

  constructor(opts: OrchestratorOptions) {
    this.workflowPath = opts.workflowPath;
    this.serverPort = opts.serverPort ?? null;
    this.onSnapshot = opts.onSnapshot;
  }

  async start(): Promise<void> {
    const workflow = loadWorkflow(this.workflowPath);
    this.config = buildServiceConfig(workflow);
    this.promptTemplate = workflow.prompt_template;

    const errors = validateDispatchConfig(this.config);
    if (errors.length > 0) {
      logger.error({ errors }, `startup validation failed: ${errors.join('; ')}`);
      throw new Error(`Startup validation failed: ${errors.join('; ')}`);
    }

    this.tracker = new LinearClient(this.config.tracker);

    this.state = createInitialState(
      this.config.polling.interval_ms,
      this.config.agent.max_concurrent_agents,
    );

    this.stopWatcher = watchWorkflow(this.workflowPath, () => this.reloadWorkflow());

    await this.startupTerminalCleanup();

    this.scheduleTick(0);

    logger.info({ workflow_path: this.workflowPath }, 'symphony orchestrator started');
  }

  stop(): void {
    this.shutdownRequested = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.stopWatcher) {
      this.stopWatcher();
      this.stopWatcher = null;
    }
    for (const entry of this.state.running.values()) {
      entry.cancel();
    }
    logger.info('symphony orchestrator stopped');
  }

  getConfig(): ServiceConfig {
    return this.config;
  }

  getSnapshot(): RuntimeSnapshot {
    return buildSnapshot(this.state);
  }

  triggerRefresh(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    this.scheduleTick(0);
  }

  private reloadWorkflow(): void {
    try {
      const workflow = loadWorkflow(this.workflowPath);
      const newConfig = buildServiceConfig(workflow);
      this.config = newConfig;
      this.promptTemplate = workflow.prompt_template;
      this.state.poll_interval_ms = newConfig.polling.interval_ms;
      this.state.max_concurrent_agents = newConfig.agent.max_concurrent_agents;
      this.tracker = new LinearClient(newConfig.tracker);
      logger.info({ workflow_path: this.workflowPath }, 'workflow reloaded and applied');
    } catch (err) {
      logger.error({ err }, 'workflow reload failed, keeping last good config');
    }
  }

  private async startupTerminalCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.tracker.fetchIssuesByStates(this.config.tracker.terminal_states);
      for (const issue of terminalIssues) {
        try {
          await removeWorkspace(issue.identifier, this.config.workspace.root, this.config.hooks);
        } catch (err) {
          logger.warn({ err, issue_identifier: issue.identifier }, 'startup cleanup failed for workspace');
        }
      }
      logger.info({ count: terminalIssues.length }, `startup terminal cleanup completed count=${terminalIssues.length}`);
    } catch (err) {
      logger.warn({ err }, 'startup terminal cleanup fetch failed, continuing startup');
    }
  }

  private scheduleTick(delayMs: number): void {
    if (this.shutdownRequested) return;
    this.tickTimer = setTimeout(() => { void this.tick(); }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.shutdownRequested) return;

    // Reconcile stalls first (sync)
    reconcileStalls(this.state, this.config, this.dispatch, this.tracker);

    // Reconcile tracker states
    await reconcileTrackerStates(this.state, this.config, this.tracker, this.dispatch);

    // Dispatch preflight
    const errors = validateDispatchConfig(this.config);
    if (errors.length > 0) {
      logger.error({ errors }, `dispatch validation failed, skipping dispatch: ${errors.join('; ')}`);
      this.notifyObservers();
      this.scheduleTick(this.state.poll_interval_ms);
      return;
    }

    // Fetch candidates
    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch (err) {
      logger.warn({ err }, 'candidate fetch failed, skipping dispatch for this tick');
      this.notifyObservers();
      this.scheduleTick(this.state.poll_interval_ms);
      return;
    }

    // Sort and dispatch
    const sorted = sortForDispatch(candidates);
    for (const issue of sorted) {
      const slots = this.config.agent.max_concurrent_agents - this.state.running.size;
      if (slots <= 0) break;
      if (isEligible(issue, this.state, this.config)) {
        this.dispatch(issue, null);
      }
    }

    this.notifyObservers();
    this.scheduleTick(this.state.poll_interval_ms);
  }

  private dispatch: DispatchFn = (issue: Issue, attempt: number | null) => {
    if (this.state.claimed.has(issue.id) || this.state.running.has(issue.id)) return;

    claim(this.state, issue.id);
    removeRetry(this.state, issue.id);

    const abortController = new AbortController();
    const startedAt = new Date();

    const liveSession: LiveSession = {
      session_id: null,
      claude_pid: null,
      last_event_type: null,
      last_event_timestamp: null,
      last_message: null,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      turn_count: 0,
    };

    const entry: RunningEntry = {
      issue,
      attempt,
      workspace_path: '',
      started_at: startedAt,
      live_session: liveSession,
      cancel: () => abortController.abort(),
    };

    addRunning(this.state, issue.id, entry);

    const ilog = issueLogger(issue.id, issue.identifier);
    ilog.info({ attempt }, `dispatching issue issue_identifier=${issue.identifier} attempt=${attempt ?? 'first'}`);

    void this.runWorker(issue, attempt, entry, abortController.signal, startedAt);
  };

  private async runWorker(
    issue: Issue,
    attempt: number | null,
    entry: RunningEntry,
    cancelSignal: AbortSignal,
    startedAt: Date,
  ): Promise<void> {
    const ilog = issueLogger(issue.id, issue.identifier);
    let lastUsage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
    let workerSucceeded = false;
    let workerError: string | null = null;

    try {
      // Prepare workspace
      const workspace = await prepareWorkspace(issue.identifier, this.config.workspace.root, this.config.hooks);
      entry.workspace_path = workspace.path;

      if (cancelSignal.aborted) return;

      // before_run hook
      if (this.config.hooks.before_run) {
        await runHook('before_run', this.config.hooks.before_run, workspace.path, this.config.hooks.timeout_ms);
      }

      if (cancelSignal.aborted) return;

      // Run agent
      await runAgent(
        issue,
        attempt,
        workspace.path,
        this.config.claude,
        this.promptTemplate,
        {
          onEvent: (event) => {
            updateLiveSession(this.state, issue.id, event);
            if (event.usage) lastUsage = event.usage;
            if (event.event === 'turn_completed') workerSucceeded = true;
            if (event.event === 'turn_failed' || event.event === 'startup_failed') {
              workerError = event.error ?? 'unknown error';
            }
          },
        },
        cancelSignal,
      );
    } catch (err) {
      workerError = (err as Error).message;
      ilog.error({ err }, `worker error issue_identifier=${issue.identifier}`);
    } finally {
      // after_run hook (best effort)
      if (entry.workspace_path && this.config.hooks.after_run) {
        runHook('after_run', this.config.hooks.after_run, entry.workspace_path, this.config.hooks.timeout_ms).catch(
          (err) => ilog.warn({ err }, 'after_run hook failed (ignored)'),
        );
      }

      const durationSeconds = (Date.now() - startedAt.getTime()) / 1000;
      if (lastUsage) {
        accumulateRuntime(this.state.claude_totals, { event: 'turn_completed', timestamp: new Date(), claude_pid: null, usage: lastUsage }, durationSeconds);
      } else {
        this.state.claude_totals.seconds_running += durationSeconds;
      }

      removeRunning(this.state, issue.id);
    }

    if (cancelSignal.aborted) {
      unclaim(this.state, issue.id);
      return;
    }

    if (workerSucceeded || (!workerError)) {
      // Normal exit: schedule a short continuation retry
      const nextAttempt = (attempt ?? 0) + 1;
      ilog.info({ next_attempt: nextAttempt }, `worker completed normally, scheduling continuation issue_identifier=${issue.identifier}`);
      scheduleRetry(this.state, issue.id, issue.identifier, nextAttempt, null, 1000, this.config, this.tracker, this.dispatch);
    } else {
      // Failure: exponential backoff
      const nextAttempt = (attempt ?? 0) + 1;
      const delay = computeBackoffMs(nextAttempt, this.config.agent.max_retry_backoff_ms);
      ilog.warn({ error: workerError, next_attempt: nextAttempt, delay_ms: delay }, `worker failed, scheduling retry issue_identifier=${issue.identifier} error=${workerError}`);
      scheduleRetry(this.state, issue.id, issue.identifier, nextAttempt, workerError, delay, this.config, this.tracker, this.dispatch);
    }

    this.notifyObservers();
  }

  private notifyObservers(): void {
    if (this.onSnapshot) {
      try {
        this.onSnapshot(this.getSnapshot());
      } catch {
        // ignore observer errors
      }
    }
  }
}
