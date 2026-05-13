import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Issue, LiveSession, OrchestratorState, Project, RunningEntry, ServiceConfig, TrackerConfig } from '../domain';
import { loadWorkflow } from '../workflow/loader';
import { buildServiceConfig, validateDispatchConfig } from '../workflow/config';
import { watchWorkflow } from '../workflow/watcher';
import { LinearClient } from '../tracker/linear';
import { TrackerClient } from '../tracker/client';
import { removeWorkspace } from '../workspace/manager';
import { runHook } from '../workspace/hooks';
import { runGeminiAgent } from '../agent/gemini-runner';
import { runAgent as runClaudeAgent } from '../agent/runner';
import { createInitialState, addRunning, removeRunning, unclaim, claim, updateLiveSession, removeRetry, accumulateRuntime } from './state';
import { isEligible, sortForDispatch } from './dispatch';
import { reconcileStalls, reconcileTrackerStates } from './reconcile';
import { scheduleRetry, computeBackoffMs } from './retry';
import { logger, issueLogger } from '../observability/logger';
import { RuntimeSnapshot, buildSnapshot } from '../observability/snapshot';

// Filters raw agent notification messages down to a clean human-readable summary.
// Strips stderr noise, startup banners, rate-limit warnings, and raw JSON stat blobs.
// For Gemini JSON output, extracts the top-level `response` field if present.
function cleanSummary(notifications: string[]): string {
  const NOISE = [
    '[stderr]',
    'YOLO mode',
    'Ripgrep is not available',
    'IDEClient',
    'DeprecationWarning',
    'Attempt 1 failed',
    'Attempt 2 failed',
    'Attempt 3 failed',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
  ];

  const lines: string[] = [];
  for (const msg of notifications) {
    const trimmed = msg.trim();
    if (!trimmed) continue;
    if (NOISE.some(n => trimmed.includes(n))) continue;

    // Try to extract just the `response` field from Gemini's final JSON stats blob
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof parsed['response'] === 'string') {
          lines.push(parsed['response'].trim());
        }
        // Skip the raw JSON blob either way
        continue;
      } catch {
        // Not valid JSON — fall through and include as-is
      }
    }

    lines.push(trimmed);
  }
  return lines.join('\n').trim();
}

export type DispatchFn = (issue: Issue, project: Project, attempt: number | null) => void;

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

    this.tracker = new LinearClient({
      backend: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      api_key: this.config.tracker.linear.api_key,
      project_slugs: this.config.projects.map(p => p.linear_project_slug),
      active_states: this.config.tracker.linear.active_states,
      terminal_states: [this.config.tracker.linear.done_state],
    });

    logger.info(
      { agent_backend: this.config.agent.backend },
      `agent backend: ${this.config.agent.backend}`,
    );

    this.state = createInitialState(
      this.config.orchestrator.polling_interval_ms,
      this.config.orchestrator.max_concurrent_agents,
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
      this.state.poll_interval_ms = newConfig.orchestrator.polling_interval_ms;
      this.state.max_concurrent_agents = newConfig.orchestrator.max_concurrent_agents;
      this.tracker = new LinearClient({
        backend: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        api_key: newConfig.tracker.linear.api_key,
        project_slugs: newConfig.projects.map(p => p.linear_project_slug),
        active_states: newConfig.tracker.linear.active_states,
        terminal_states: [newConfig.tracker.linear.done_state],
      });
      logger.info(
        { workflow_path: this.workflowPath, agent_backend: newConfig.agent.backend },
        'workflow reloaded and applied',
      );
    } catch (err) {
      logger.error({ err }, 'workflow reload failed, keeping last good config');
    }
  }

  private async startupTerminalCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.tracker.fetchIssuesByStates(this.config.tracker.linear.done_state === 'Done' ? ['Done'] : [this.config.tracker.linear.done_state]);
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

    reconcileStalls(this.state, this.config, this.dispatch, this.tracker);
    await reconcileTrackerStates(this.state, this.config, this.tracker, this.dispatch);

    const errors = validateDispatchConfig(this.config);
    if (errors.length > 0) {
      logger.error({ errors }, `dispatch validation failed, skipping dispatch: ${errors.join('; ')}`);
      this.notifyObservers();
      this.scheduleTick(this.state.poll_interval_ms);
      return;
    }

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch (err) {
      logger.warn({ err }, 'candidate fetch failed, skipping dispatch for this tick');
      this.notifyObservers();
      this.scheduleTick(this.state.poll_interval_ms);
      return;
    }

    const sorted = sortForDispatch(candidates);
    for (const issue of sorted) {
      const slots = this.config.orchestrator.max_concurrent_agents - this.state.running.size;
      if (slots <= 0) break;
      if (isEligible(issue, this.state, this.config)) {
        const project = this.config.projects.find(p => p.linear_project_slug === issue.project_slug);
        if (project) {
          this.dispatch(issue, project, null);
        } else {
          logger.warn({ issue_identifier: issue.identifier, project_slug: issue.project_slug }, 'no project config found for issue');
        }
      }
    }

    this.notifyObservers();
    this.scheduleTick(this.state.poll_interval_ms);
  }

  private dispatch: DispatchFn = (issue: Issue, project: Project, attempt: number | null) => {
    if (this.state.claimed.has(issue.id) || this.state.running.has(issue.id)) return;

    claim(this.state, issue.id);
    removeRetry(this.state, issue.id);

    const abortController = new AbortController();
    const startedAt = new Date();
    const workspacePath = path.join(this.config.workspace.root, issue.identifier);

    const entry: RunningEntry = {
      issue,
      attempt,
      workspace_path: workspacePath,
      started_at: startedAt,
      live_session: {
        session_id: null,
        claude_pid: null,
        last_event_type: null,
        last_event_timestamp: null,
        last_message: null,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        turn_count: 0,
      },
      cancel: () => abortController.abort(),
    };

    addRunning(this.state, issue.id, entry);

    const ilog = issueLogger(issue.id, issue.identifier);
    ilog.info({ attempt, project: project.name }, `dispatching issue issue_identifier=${issue.identifier} project=${project.name} attempt=${attempt ?? 'first'}`);

    void this.runWorker(issue, project, attempt, entry, abortController.signal, startedAt);
  };

  private async runWorker(
    issue: Issue,
    project: Project,
    attempt: number | null,
    entry: RunningEntry,
    cancelSignal: AbortSignal,
    startedAt: Date,
  ): Promise<void> {
    const ilog = issueLogger(issue.id, issue.identifier);
    let lastUsage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
    let workerSucceeded = false;
    let workerError: string | null = null;
    const notifications: string[] = [];

    const hookContext = {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      issue_title: issue.title,
      repo_url: project.repo_url,
      target_branch: project.target_branch,
      repo_name: project.repo_url.split('/').pop()?.replace('.git', '') || '',
    };

    try {
      if (fs.existsSync(entry.workspace_path)) {
        fs.rmSync(entry.workspace_path, { recursive: true, force: true });
      }
      fs.mkdirSync(entry.workspace_path, { recursive: true });

      if (cancelSignal.aborted) return;

      if (this.config.hooks.before_run) {
        await runHook('before_run', this.config.hooks.before_run, entry.workspace_path, this.config.hooks.timeout_ms, hookContext);
      }

      if (cancelSignal.aborted) return;

      const onEvent = (event: any) => {
        updateLiveSession(this.state, issue.id, event);
        if (event.event === 'notification' && event.message) {
          notifications.push(event.message);
          ilog.info({ message: event.message }, `agent notification: ${event.message}`);
        }
        if (event.usage) lastUsage = event.usage;
        if (event.event === 'turn_completed') workerSucceeded = true;
        if (event.event === 'turn_failed' || event.event === 'startup_failed') {
          workerError = event.error ?? 'unknown error';
        }
      };

      const backend = this.config.agent.backend;
      if (backend === 'gemini' && this.config.agent.gemini) {
        await runGeminiAgent(issue, attempt, entry.workspace_path, this.config.agent.gemini, this.promptTemplate, { onEvent }, cancelSignal);
      } else if (backend === 'claude' && this.config.agent.claude) {
        await runClaudeAgent(issue, attempt, entry.workspace_path, this.config.agent.claude, this.promptTemplate, { onEvent }, cancelSignal);
      } else {
        throw new Error(`Unsupported backend or missing config: ${backend}`);
      }
    } catch (err) {
      workerError = (err as Error).message;
      ilog.error({ err }, `worker error issue_identifier=${issue.identifier}`);
    } finally {
      if (entry.workspace_path && this.config.hooks.after_run) {
        const finalContext = { ...hookContext, agent_summary: cleanSummary(notifications) };
        runHook('after_run', this.config.hooks.after_run, entry.workspace_path, this.config.hooks.timeout_ms, finalContext).catch(
          (err) => ilog.warn({ err }, 'after_run hook failed (ignored)'),
        );
      }

      const durationSeconds = (Date.now() - startedAt.getTime()) / 1000;
      if (lastUsage) {
        accumulateRuntime(this.state.claude_totals, { event: 'turn_completed' as any, timestamp: new Date(), claude_pid: null, usage: lastUsage }, durationSeconds);
      } else {
        this.state.claude_totals.seconds_running += durationSeconds;
      }
      removeRunning(this.state, issue.id);
    }

    if (cancelSignal.aborted) {
      unclaim(this.state, issue.id);
      return;
    }

    if (workerSucceeded || !workerError) {
      const summary = cleanSummary(notifications);
      if (summary) {
        this.tracker.addComment(issue.id, `Agent Summary:\n\n${summary}`).catch(err => ilog.warn({ err }, 'failed to add linear comment'));
      }

      const doneStateId = await this.tracker.fetchStateIdByName(this.config.tracker.linear.done_state).catch(() => null);
      if (doneStateId) {
        this.tracker.updateIssue(issue.id, { stateId: doneStateId }).catch(err => ilog.warn({ err }, 'failed to move linear issue to Done'));
      }

      ilog.info({ issue_identifier: issue.identifier }, `worker succeeded, issue moved to ${this.config.tracker.linear.done_state}`);
      this.state.completed.add(issue.id);
    } else {
      const nextAttempt = (attempt ?? 0) + 1;
      const delay = computeBackoffMs(nextAttempt, this.config.orchestrator.max_retry_backoff_ms);
      ilog.warn({ error: workerError, next_attempt: nextAttempt, delay_ms: delay }, `worker failed, scheduling retry issue_identifier=${issue.identifier}`);
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
