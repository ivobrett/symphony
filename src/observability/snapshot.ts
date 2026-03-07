import { OrchestratorState } from '../domain';

export interface RunningRow {
  issue_id: string;
  issue_identifier: string;
  state: string;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface RetryRow {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface ClaudeTotalsSnapshot {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface RuntimeSnapshot {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: RunningRow[];
  retrying: RetryRow[];
  claude_totals: ClaudeTotalsSnapshot;
  rate_limits: unknown;
}

export function buildSnapshot(state: OrchestratorState): RuntimeSnapshot {
  const running: RunningRow[] = [];
  for (const [issueId, entry] of state.running) {
    const ls = entry.live_session;
    running.push({
      issue_id: issueId,
      issue_identifier: entry.issue.identifier,
      state: entry.issue.state,
      session_id: ls.session_id,
      turn_count: ls.turn_count,
      last_event: ls.last_event_type,
      last_message: ls.last_message,
      started_at: entry.started_at.toISOString(),
      last_event_at: ls.last_event_timestamp?.toISOString() ?? null,
      tokens: {
        input_tokens: ls.input_tokens,
        output_tokens: ls.output_tokens,
        total_tokens: ls.total_tokens,
      },
    });
  }

  const retrying: RetryRow[] = [];
  for (const [, entry] of state.retry_attempts) {
    retrying.push({
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: new Date(entry.due_at_ms).toISOString(),
      error: entry.error,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    counts: { running: running.length, retrying: retrying.length },
    running,
    retrying,
    claude_totals: { ...state.claude_totals },
    rate_limits: state.claude_rate_limits,
  };
}
