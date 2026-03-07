import { AgentEvent, ClaudeTotals, Issue, LiveSession, OrchestratorState, RetryEntry, RunningEntry } from '../domain';

export function createInitialState(pollIntervalMs: number, maxConcurrentAgents: number): OrchestratorState {
  return {
    poll_interval_ms: pollIntervalMs,
    max_concurrent_agents: maxConcurrentAgents,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    completed: new Set(),
    claude_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    claude_rate_limits: null,
  };
}

export function claim(state: OrchestratorState, issueId: string): OrchestratorState {
  state.claimed.add(issueId);
  return state;
}

export function unclaim(state: OrchestratorState, issueId: string): OrchestratorState {
  state.claimed.delete(issueId);
  state.retry_attempts.delete(issueId);
  return state;
}

export function addRunning(
  state: OrchestratorState,
  issueId: string,
  entry: RunningEntry,
): OrchestratorState {
  state.running.set(issueId, entry);
  return state;
}

export function removeRunning(state: OrchestratorState, issueId: string): RunningEntry | undefined {
  const entry = state.running.get(issueId);
  state.running.delete(issueId);
  return entry;
}

export function updateLiveSession(
  state: OrchestratorState,
  issueId: string,
  event: AgentEvent,
): void {
  const entry = state.running.get(issueId);
  if (!entry) return;

  const ls = entry.live_session;
  ls.last_event_type = event.event;
  ls.last_event_timestamp = event.timestamp;

  if (event.session_id && !ls.session_id) ls.session_id = event.session_id;
  if (event.claude_pid != null) ls.claude_pid = event.claude_pid;
  if (event.message) ls.last_message = event.message;

  if (event.usage) {
    ls.input_tokens += event.usage.input_tokens;
    ls.output_tokens += event.usage.output_tokens;
    ls.total_tokens += event.usage.total_tokens;
  }

  if (event.event === 'turn_completed') ls.turn_count += 1;
  if (event.rate_limits) state.claude_rate_limits = event.rate_limits;
}

export function addRetry(state: OrchestratorState, entry: RetryEntry): OrchestratorState {
  const existing = state.retry_attempts.get(entry.issue_id);
  if (existing) clearTimeout(existing.timer_handle);
  state.retry_attempts.set(entry.issue_id, entry);
  return state;
}

export function removeRetry(state: OrchestratorState, issueId: string): void {
  const existing = state.retry_attempts.get(issueId);
  if (existing) clearTimeout(existing.timer_handle);
  state.retry_attempts.delete(issueId);
}

export function accumulateRuntime(totals: ClaudeTotals, event: AgentEvent, durationSeconds: number): ClaudeTotals {
  if (event.usage) {
    totals.input_tokens += event.usage.input_tokens;
    totals.output_tokens += event.usage.output_tokens;
    totals.total_tokens += event.usage.total_tokens;
  }
  totals.seconds_running += durationSeconds;
  return totals;
}

export function updateIssueSnapshot(state: OrchestratorState, issueId: string, updatedIssue: Issue): void {
  const entry = state.running.get(issueId);
  if (entry) entry.issue = updatedIssue;
}
