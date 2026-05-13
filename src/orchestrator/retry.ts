import { OrchestratorState, ServiceConfig } from '../domain';
import { isEligible, sortForDispatch } from './dispatch';
import { addRetry, removeRetry, unclaim } from './state';
import { logger } from '../observability/logger';
import { TrackerClient } from '../tracker/client';
import type { DispatchFn } from './index';

export function computeBackoffMs(attempt: number, maxMs: number): number {
  const delay = 10000 * Math.pow(2, attempt - 1);
  return Math.min(delay, maxMs);
}

export function scheduleRetry(
  state: OrchestratorState,
  issueId: string,
  identifier: string,
  attempt: number,
  errorMsg: string | null,
  delayMs: number,
  config: ServiceConfig,
  tracker: TrackerClient,
  dispatchFn: DispatchFn,
): void {
  const dueAtMs = Date.now() + delayMs;

  const handle = setTimeout(async () => {
    removeRetry(state, issueId);

    logger.info({ issue_id: issueId, issue_identifier: identifier, attempt }, `retry timer fired issue_identifier=${identifier} attempt=${attempt}`);

    let candidates;
    try {
      candidates = await tracker.fetchCandidateIssues();
    } catch (err) {
      logger.warn({ err, issue_identifier: identifier }, `retry fetch failed for issue_identifier=${identifier}, requeuing`);
      scheduleRetry(state, issueId, identifier, attempt + 1, `fetch_failed: ${(err as Error).message}`, computeBackoffMs(attempt + 1, config.orchestrator.max_retry_backoff_ms), config, tracker, dispatchFn);
      return;
    }

    const issue = candidates.find((i) => i.id === issueId) ?? null;

    if (!issue) {
      logger.info({ issue_id: issueId, issue_identifier: identifier }, `issue no longer found in active candidates, releasing claim issue_identifier=${identifier}`);
      unclaim(state, issueId);
      return;
    }

    if (!isEligible(issue, state, config, { skipClaimedCheck: true })) {
      logger.info({ issue_identifier: identifier }, `issue no longer eligible, releasing claim issue_identifier=${identifier}`);
      unclaim(state, issueId);
      return;
    }

    const slots = config.orchestrator.max_concurrent_agents - state.running.size;
    if (slots <= 0) {
      logger.info({ issue_identifier: identifier }, `no available orchestrator slots, requeuing issue_identifier=${identifier}`);
      scheduleRetry(state, issueId, identifier, attempt, 'no available orchestrator slots', computeBackoffMs(attempt, config.orchestrator.max_retry_backoff_ms), config, tracker, dispatchFn);
      return;
    }

    const project = config.projects.find(p => p.linear_project_slug === issue.project_slug);
    if (!project) {
      logger.warn({ issue_identifier: identifier, project_slug: issue.project_slug }, 'no project config found during retry');
      unclaim(state, issueId);
      return;
    }

    // Unclaim so dispatch() won't skip this issue (it re-claims immediately)
    unclaim(state, issueId);
    dispatchFn(issue, project, attempt);
  }, delayMs);

  addRetry(state, { issue_id: issueId, identifier, attempt, due_at_ms: dueAtMs, timer_handle: handle, error: errorMsg });

  logger.info(
    { issue_id: issueId, issue_identifier: identifier, attempt, delay_ms: delayMs, error: errorMsg },
    `retry scheduled issue_identifier=${identifier} attempt=${attempt} delay_ms=${delayMs}`,
  );
}
