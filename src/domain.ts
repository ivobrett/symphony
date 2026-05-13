// Core domain types for Symphony

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

export class WorkflowError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  project_slug: string; // To route to correct repo
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: Array<{ id: string | null; identifier: string | null; state: string | null }>;
  created_at: Date | null;
  updated_at: Date | null;
}

export interface Project {
  name: string;
  linear_project_slug: string;
  repo_url: string;
  target_branch: string;
}

export interface ServiceConfig {
  orchestrator: {
    polling_interval_ms: number;
    max_concurrent_agents: number;
    max_attempts: number;
    max_retry_backoff_ms: number;
  };
  tracker: {
    backend: 'linear';
    linear: {
      api_key: string;
      active_states: string[];
      terminal_states: string[];
      done_state: string;
    };
  };
  projects: Project[];
  workspace: {
    root: string;
  };
  hooks: {
    before_run: string;
    after_run: string;
    timeout_ms: number;
  };
  agent: {
    backend: 'gemini' | 'claude';
    gemini?: GeminiConfig;

    claude?: ClaudeConfig;
  };
  server: {
    port: number | null;
  };
}

export interface GeminiKeyPool {
  api_keys: string[];
  current_index: number;
}

export interface GeminiConfig {
  model: string | null;
  max_turns: number;
  api_key: string;
  key_pool: GeminiKeyPool | null;
  system_prompt: string | null;
  turn_timeout_ms: number;
  stall_timeout_ms: number;
  temperature?: number;
  sandbox?: string | null;
  output_format: string;
}

export interface ClaudeConfig {
  command: string;
  model: string | null;
  max_turns: number;
  api_key: string;
  permission_mode: string | null;
  allowed_tools: string[];
  disallowed_tools: string[];
  system_prompt: string | null;
  turn_timeout_ms: number;
  stall_timeout_ms: number;
}



export interface LiveSession {
  session_id: string | null;
  claude_pid: number | null;
  last_event_type: string | null;
  last_event_timestamp: Date | null;
  last_message: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  turn_count: number;
}

export interface RunningEntry {
  issue: Issue;
  attempt: number | null;
  workspace_path: string;
  started_at: Date;
  live_session: LiveSession;
  cancel: () => void;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: ReturnType<typeof setTimeout>;
  error: string | null;
}

export interface ClaudeTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface RateLimitInfo {
  requests_limit: number | null;
  requests_remaining: number | null;
  tokens_limit: number | null;
  tokens_remaining: number | null;
}

export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  claude_totals: ClaudeTotals;
  claude_rate_limits: RateLimitInfo | null;
}

export interface AgentEvent {
  event: 'session_started' | 'startup_failed' | 'turn_completed' | 'turn_failed' | 'turn_stalled' | 'notification' | 'other_message' | 'malformed';
  timestamp: Date;
  claude_pid: number | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd?: number;
  };
  session_id?: string;
  message?: string;
  error?: string;
  stop_reason?: string;
  rate_limits?: RateLimitInfo;
}

export interface TrackerConfig {
  backend: 'linear';
  endpoint: string;
  api_key: string;
  project_slugs: string[];
  active_states: string[];
  terminal_states: string[];
}

export class TrackerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
