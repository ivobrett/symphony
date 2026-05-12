// Core domain types for Symphony

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  project_slug: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: Date | null;
  updated_at: Date | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  api_key: string;
  projects: Record<string, string>;
  active_states: string[];
  terminal_states: string[];
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
}

export interface AgentConfig {
  max_concurrent_agents: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
}

export interface ClaudeConfig {
  command: string;
  model: string | null;
  permission_mode: string | null;
  allowed_tools: string[];
  disallowed_tools: string[];
  max_turns: number;
  api_key: string;
  system_prompt: string | null;
  turn_timeout_ms: number;
  stall_timeout_ms: number;
}

export interface GeminiKeyPool {
  /** List of GOOGLE_API_KEY values to rotate through on rate-limit errors */
  api_keys: string[];
  /** Index of the currently active key (managed at runtime) */
  current_index: number;
}

export interface GeminiConfig {
  command: string;
  model: string | null;
  max_turns: number;
  /** Primary API key — also used as api_keys[0] if key_pool is empty */
  api_key: string;
  /** Optional pool of additional keys to rotate through on rate limits */
  key_pool: GeminiKeyPool | null;
  system_prompt: string | null;
  turn_timeout_ms: number;
  stall_timeout_ms: number;
  sandbox: string | null;
  output_format: string;
}

export interface FreebuffConfig {
  command: string;
  model: string | null;
  max_turns: number;
  turn_timeout_ms: number;
  stall_timeout_ms: number;
  /** true = use @codebuff/sdk (headless, requires api_key); false = CLI stdin mode */
  use_sdk: boolean;
  /** Codebuff API key — required when use_sdk is true */
  api_key: string | null;
  /** SDK agent identifier, e.g. 'codebuff/base@latest' */
  agent: string;
}

export interface ServerConfig {
  port: number | null;
}

export type AgentBackend = 'claude' | 'gemini' | 'freebuff';

export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  agent_backend: AgentBackend;
  claude: ClaudeConfig;
  gemini: GeminiConfig;
  freebuff: FreebuffConfig;
  server: ServerConfig;
}

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

export type RunAttemptStatus =
  | 'PreparingWorkspace'
  | 'BuildingPrompt'
  | 'LaunchingAgentProcess'
  | 'StreamingOutput'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation';

export interface RunAttempt {
  issue_id: string;
  issue_identifier: string;
  attempt: number | null;
  workspace_path: string;
  started_at: Date;
  status: RunAttemptStatus;
  error?: string;
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

// Agent runner upstream events
export type AgentEventType =
  | 'session_started'
  | 'startup_failed'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_stalled'
  | 'notification'
  | 'other_message'
  | 'malformed';

export interface AgentEvent {
  event: AgentEventType;
  timestamp: Date;
  claude_pid: number | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd?: number;
  };
  session_id?: string;
  stop_reason?: string;
  message?: string;
  error?: string;
  rate_limits?: RateLimitInfo;
}

// Workflow error codes
export type WorkflowErrorCode =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_parse_error'
  | 'template_render_error';

export class WorkflowError extends Error {
  constructor(
    public readonly code: WorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

// Tracker error codes
export type TrackerErrorCode =
  | 'unsupported_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'linear_api_request'
  | 'linear_api_status'
  | 'linear_graphql_errors'
  | 'linear_unknown_payload'
  | 'linear_missing_end_cursor';

export class TrackerError extends Error {
  constructor(
    public readonly code: TrackerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TrackerError';
  }
}

// Agent runner error codes
export type AgentErrorCode =
  | 'claude_not_found'
  | 'invalid_workspace_cwd'
  | 'turn_timeout'
  | 'stall_timeout'
  | 'subprocess_exit'
  | 'turn_failed'
  | 'prompt_render_failed';
