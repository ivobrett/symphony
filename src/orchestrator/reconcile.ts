import { OrchestratorState, ServiceConfig } from '../domain';
import { isTerminal } from './dispatch';
import { removeRunning, unclaim, updateIssueSnapshot } from './state';
import { scheduleRetry, computeBackoffMs } from './retry';
import { removeWorkspace } from '../workspace/manager';
import { logger } from '../observability/logger';
import { TrackerClient } from '../tracker/client';
import type { DispatchFn } from './index';

export function reconcileStalls(
  state: OrchestratorState,
  config: ServiceConfig,
  dispatchFn: DispatchFn,
  tracker: TrackerClient,
): void {
  // Use stall timeout from whichever backend is active
  const stallMs =
    config.agent_backend === 'gemini' ? config.gemini.stall_timeout_ms
    : config.agent_backend === 'freebuff' ? config.freebuff.stall_timeout_ms
    : config.claude.stall_timeout_ms;
  if (stallMs <= 0) return;

  const now = Date.now();

  for (const [issueId, entry] of state.running) {
    const ls = entry.live_session;
    const lastSeen = ls.last_event_timestamp?.getTime() ?? entry.started_at.getTime();
    const elapsed = now - lastSeen;

    if (elapsed > stallMs) {
      logger.warn(
        { issue_id: issueId, issue_identifier: entry.issue.identifier, elapsed_ms: elapsed },
        `stall detected issue_identifier=${entry.issue.identifier} elapsed_ms=${elapsed}`,
      );
      entry.cancel();
      removeRunning(state, issueId);

      const nextAttempt = (entry.attempt ?? 0) + 1;
      scheduleRetry(
        state,
        issueId,
        entry.issue.identifier,
        nextAttempt,
        'stall_timeout',
        computeBackoffMs(nextAttempt, config.agent.max_retry_backoff_ms),
        config,
        tracker,
        dispatchFn,
      );
    }
  }
}

export async function reconcileTrackerStates(
  state: OrchestratorState,
  config: ServiceConfig,
  tracker: TrackerClient,
  dispatchFn: DispatchFn,
): Promise<void> {
  const runningIds = [...state.running.keys()];
  if (runningIds.length === 0) return;

  let refreshed: Array<{ id: string; state: string }>;
  try {
    refreshed = await tracker.fetchIssueStatesByIds(runningIds);
  } catch (err) {
    logger.warn({ err }, 'tracker state refresh failed, keeping active workers running');
    return;
  }

  const terminalStates = config.tracker.terminal_states;
  const activeStates = config.tracker.active_states;

  const normalize = (s: string) => s.trim().toLowerCase();
  const activeNorm = activeStates.map(normalize);

  for (const { id: issueId, state: trackerState } of refreshed) {
    const entry = state.running.get(issueId);
    if (!entry) continue;

    if (isTerminal(trackerState, terminalStates)) {
      logger.info(
        { issue_id: issueId, issue_identifier: entry.issue.identifier, tracker_state: trackerState },
        `issue reached terminal state, stopping worker issue_identifier=${entry.issue.identifier} tracker_state=${trackerState}`,
      );
      entry.cancel();
      removeRunning(state, issueId);
      unclaim(state, issueId);

      removeWorkspace(entry.issue.identifier, config.workspace.root, config.hooks).catch((err) =>
        logger.warn({ err, issue_identifier: entry.issue.identifier }, 'workspace cleanup failed'),
      );
    } else if (activeNorm.includes(normalize(trackerState))) {
      // Update snapshot
      updateIssueSnapshot(state, issueId, { ...entry.issue, state: trackerState });
    } else {
      // Neither active nor terminal - stop without cleanup
      logger.info(
        { issue_id: issueId, issue_identifier: entry.issue.identifier, tracker_state: trackerState },
        `issue state is no longer active, stopping worker issue_identifier=${entry.issue.identifier} tracker_state=${trackerState}`,
      );
      entry.cancel();
      removeRunning(state, issueId);
      unclaim(state, issueId);
    }
  }
}
