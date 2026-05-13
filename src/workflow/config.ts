import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import { ServiceConfig, WorkflowDefinition } from '../domain';
import { buildKeyPool } from '../agent/gemini-key-rotation';

function resolveEnv(val: any): string {
  if (typeof val !== 'string') return '';
  if (val.startsWith('$')) {
    const key = val.substring(1);
    return process.env[key] || '';
  }
  return val;
}

function toStringList(val: any): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(v => String(v));
  return [String(val)];
}

export function buildServiceConfig(workflow: WorkflowDefinition): ServiceConfig {
  const cfg = workflow.config || {};
  const orchCfg = (cfg.orchestrator as any) || {};
  const trackerCfg = (cfg.tracker as any) || {};
  const linearCfg = (trackerCfg.linear as any) || {};
  const agentCfg = (cfg.agent as any) || {};
  const geminiCfg = (cfg.gemini as any) || {};
const claudeCfg = (cfg.claude as any) || {};
  const projects = (cfg.projects as any[]) || [];
  const hooksCfg = (cfg.hooks as any) || {};
  const workspaceCfg = (cfg.workspace as any) || {};

  const primaryGeminiKey = resolveEnv(geminiCfg.api_key);
  const additionalGeminiKeys = toStringList(geminiCfg.key_pool).map(resolveEnv);

  return {
    orchestrator: {
      polling_interval_ms: Number(orchCfg.polling_interval_ms) || 30000,
      max_concurrent_agents: Number(orchCfg.max_concurrent_agents) || 1,
      max_attempts: Number(orchCfg.max_attempts) || 3,
      max_retry_backoff_ms: Number(orchCfg.max_retry_backoff_ms) || 300000,
    },
    tracker: {
      backend: trackerCfg.backend || 'linear',
      linear: {
        api_key: resolveEnv(linearCfg.api_key),
        active_states: toStringList(linearCfg.active_states).length > 0 ? toStringList(linearCfg.active_states) : ['Todo', 'To Do', 'In Progress', 'Triage'],
        terminal_states: toStringList(linearCfg.terminal_states).length > 0 ? toStringList(linearCfg.terminal_states) : ['Done', 'Cancelled', 'Canceled', 'Duplicate', 'Closed'],
        done_state: String(linearCfg.done_state || 'Done'),
      },
    },
    projects: projects.map(p => ({
      name: p.name || 'Unnamed Project',
      linear_project_slug: p.linear_project_slug || '',
      repo_url: resolveEnv(p.repo_url),
      target_branch: p.target_branch || 'main'
    })),
    workspace: {
      root: workspaceCfg.root || path.join(process.cwd(), 'workspaces'),
    },
    hooks: {
      before_run: hooksCfg.before_run || '',
      after_run: hooksCfg.after_run || '',
      timeout_ms: Number(hooksCfg.timeout_ms) || 300000,
    },
    agent: {
      backend: agentCfg.backend || 'gemini',
      gemini: {
        model: geminiCfg.model || null,
        max_turns: Number(geminiCfg.max_turns) || 20,
        api_key: primaryGeminiKey,
        key_pool: buildKeyPool(primaryGeminiKey, additionalGeminiKeys),
        system_prompt: geminiCfg.system_prompt || null,
        turn_timeout_ms: Number(geminiCfg.turn_timeout_ms) || 3600000,
        stall_timeout_ms: Number(geminiCfg.stall_timeout_ms) || 300000,
        sandbox: geminiCfg.sandbox || null,
        output_format: geminiCfg.output_format || 'json',
      },
      claude: {
        command: String(claudeCfg.command ?? 'claude'),
        model: claudeCfg.model || null,
        max_turns: Number(claudeCfg.max_turns) || 20,
        api_key: resolveEnv(claudeCfg.api_key || '$ANTHROPIC_API_KEY'),
        permission_mode: String(claudeCfg.permission_mode ?? 'bypassPermissions'),
        allowed_tools: toStringList(claudeCfg.allowed_tools),
        disallowed_tools: toStringList(claudeCfg.disallowed_tools),
        system_prompt: claudeCfg.system_prompt || null,
        turn_timeout_ms: Number(claudeCfg.turn_timeout_ms) || 3600000,
        stall_timeout_ms: Number(claudeCfg.stall_timeout_ms) || 300000,
      },
    },
    server: {
      port: Number((cfg.server as any)?.port) || 3000,
    }
  };
}

export function validateDispatchConfig(config: ServiceConfig): string[] {
  const errors: string[] = [];
  if (!config.tracker.linear.api_key) errors.push('Missing tracker API key');
  if (config.projects.length === 0) errors.push('No projects configured');
  return errors;
}
