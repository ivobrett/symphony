import * as os from 'os';
import * as path from 'path';
import { ServiceConfig, WorkflowDefinition } from '../domain';

function resolveEnv(value: string | undefined | null): string {
  if (!value) return '';
  if (value.startsWith('$')) {
    return process.env[value.slice(1)] ?? '';
  }
  return value;
}

function resolvePath(value: string | undefined | null): string {
  if (!value) return '';
  const resolved = resolveEnv(value);
  if (!resolved) return '';
  if (resolved.startsWith('~')) {
    return path.join(os.homedir(), resolved.slice(1));
  }
  if (resolved.includes(path.sep) || resolved.startsWith('/')) {
    return path.resolve(resolved);
  }
  return resolved; // bare relative root allowed
}

function toStringList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function toPositiveInt(value: unknown, defaultVal: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return defaultVal;
  return Math.floor(n);
}

function toInt(value: unknown, defaultVal: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.floor(n);
}

function section(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const s = config[key];
  if (s && typeof s === 'object' && !Array.isArray(s)) return s as Record<string, unknown>;
  return {};
}

export function buildServiceConfig(workflow: WorkflowDefinition): ServiceConfig {
  const cfg = workflow.config;
  const tracker = section(cfg, 'tracker');
  const polling = section(cfg, 'polling');
  const workspace = section(cfg, 'workspace');
  const hooks = section(cfg, 'hooks');
  const agent = section(cfg, 'agent');
  const claude = section(cfg, 'claude');
  const server = section(cfg, 'server');

  const trackerKind = String(tracker['kind'] ?? '');
  const isLinear = trackerKind === 'linear';

  const activeStates = toStringList(tracker['active_states']);
  const terminalStates = toStringList(tracker['terminal_states']);

  const byStateRaw = section(agent, 'max_concurrent_agents_by_state');
  const byState: Record<string, number> = {};
  for (const [k, v] of Object.entries(byStateRaw)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) byState[k.trim().toLowerCase()] = Math.floor(n);
  }

  const workspaceRoot = resolvePath(String(workspace['root'] ?? '')) ||
    path.join(os.tmpdir(), 'symphony_workspaces');

  const hookTimeout = toPositiveInt(hooks['timeout_ms'], 60000);

  const claudeApiKey = resolveEnv(String(claude['api_key'] ?? '$ANTHROPIC_API_KEY'));
  const trackerApiKey = resolveEnv(String(tracker['api_key'] ?? (isLinear ? '$LINEAR_API_KEY' : '')));

  return {
    tracker: {
      kind: trackerKind,
      endpoint: String(tracker['endpoint'] ?? (isLinear ? 'https://api.linear.app/graphql' : '')),
      api_key: trackerApiKey,
      project_slug: String(tracker['project_slug'] ?? ''),
      active_states: activeStates.length > 0 ? activeStates : ['Todo', 'In Progress'],
      terminal_states: terminalStates.length > 0 ? terminalStates : ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],
    },
    polling: {
      interval_ms: toPositiveInt(polling['interval_ms'], 30000),
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      after_create: (hooks['after_create'] as string) ?? null,
      before_run: (hooks['before_run'] as string) ?? null,
      after_run: (hooks['after_run'] as string) ?? null,
      before_remove: (hooks['before_remove'] as string) ?? null,
      timeout_ms: hookTimeout,
    },
    agent: {
      max_concurrent_agents: toPositiveInt(agent['max_concurrent_agents'], 10),
      max_retry_backoff_ms: toPositiveInt(agent['max_retry_backoff_ms'], 300000),
      max_concurrent_agents_by_state: byState,
    },
    claude: {
      command: String(claude['command'] ?? 'claude'),
      model: (claude['model'] as string) ?? null,
      permission_mode: (claude['permission_mode'] as string) ?? 'bypassPermissions',
      allowed_tools: toStringList(claude['allowed_tools']),
      disallowed_tools: toStringList(claude['disallowed_tools']),
      max_turns: toPositiveInt(claude['max_turns'], 20),
      api_key: claudeApiKey,
      system_prompt: (claude['system_prompt'] as string) ?? null,
      turn_timeout_ms: toPositiveInt(claude['turn_timeout_ms'], 3600000),
      stall_timeout_ms: toInt(claude['stall_timeout_ms'], 300000),
    },
    server: {
      port: server['port'] != null ? toPositiveInt(server['port'], 0) || null : null,
    },
  };
}

export function validateDispatchConfig(config: ServiceConfig): string[] {
  const errors: string[] = [];
  if (!config.tracker.kind) errors.push('tracker.kind is required');
  if (config.tracker.kind !== 'linear') errors.push(`tracker.kind "${config.tracker.kind}" is not supported`);
  if (!config.tracker.api_key) errors.push('tracker.api_key is missing or empty after $VAR resolution');
  if (!config.tracker.project_slug) errors.push('tracker.project_slug is required for linear');
  if (!config.claude.command) errors.push('claude.command is required');
  if (!config.claude.api_key) errors.push('claude.api_key (ANTHROPIC_API_KEY) is missing or empty');
  return errors;
}
