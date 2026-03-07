import { spawn } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { AgentEvent, ClaudeConfig, Issue, RateLimitInfo } from '../domain';
import { renderPrompt } from './prompt';
import { logger, sessionLogger } from '../observability/logger';

const MAX_LINE_BYTES = 10 * 1024 * 1024; // 10 MB

function buildClaudeCommand(config: ClaudeConfig, promptFile: string): string {
  const parts: string[] = [config.command, '--print', '--verbose', '--output-format', 'stream-json'];

  parts.push('--max-turns', String(config.max_turns));

  if (config.model) parts.push('--model', config.model);
  if (config.permission_mode) parts.push('--permission-mode', config.permission_mode);
  if (config.allowed_tools.length > 0) parts.push('--allowedTools', config.allowed_tools.join(','));
  if (config.disallowed_tools.length > 0) parts.push('--disallowedTools', config.disallowed_tools.join(','));
  if (config.system_prompt) parts.push('--system-prompt', shellEscape(config.system_prompt));

  // Prompt delivered via stdin redirect from temp file — avoids all quoting/env issues
  parts.push(`< ${shellEscape(promptFile)}`);

  return parts.join(' ');
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RunnerCallbacks {
  onEvent: (event: AgentEvent) => void;
}

export async function runAgent(
  issue: Issue,
  attempt: number | null,
  workspacePath: string,
  config: ClaudeConfig,
  promptTemplate: string,
  callbacks: RunnerCallbacks,
  cancelSignal: AbortSignal,
): Promise<void> {
  // Validate cwd
  const resolvedWs = path.resolve(workspacePath);

  // Render prompt
  let renderedPrompt: string;
  try {
    renderedPrompt = await renderPrompt(promptTemplate, issue, attempt);
  } catch (err) {
    callbacks.onEvent({
      event: 'startup_failed',
      timestamp: new Date(),
      claude_pid: null,
      error: `prompt_render_failed: ${(err as Error).message}`,
    });
    return;
  }

  // Write prompt to a temp file; bash will redirect it as stdin to claude
  const promptFile = path.join(os.tmpdir(), `symphony-prompt-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(promptFile, renderedPrompt, 'utf8');

  const command = buildClaudeCommand(config, promptFile);

  logger.info(
    { issue_id: issue.id, issue_identifier: issue.identifier, cwd: resolvedWs, command },
    `launching claude code issue_id=${issue.id} issue_identifier=${issue.identifier}`,
  );

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['CLAUDECODE']; // prevent "nested session" rejection
  if (config.api_key) env['ANTHROPIC_API_KEY'] = config.api_key;

  const child = spawn('bash', ['-lc', command], {
    cwd: resolvedWs,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pid = child.pid ?? null;
  let sessionId: string | null = null;
  let done = false;

  // Turn timeout
  const turnTimer = setTimeout(() => {
    if (!done) {
      done = true;
      child.kill('SIGKILL');
      callbacks.onEvent({
        event: 'turn_failed',
        timestamp: new Date(),
        claude_pid: pid,
        session_id: sessionId ?? undefined,
        error: 'turn_timeout',
      });
    }
  }, config.turn_timeout_ms);

  // Cancel handler
  const onCancel = () => {
    if (!done) {
      done = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    }
  };
  cancelSignal.addEventListener('abort', onCancel);

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  rl.on('line', (line) => {
    logger.debug({ issue_identifier: issue.identifier }, `claude stdout: ${line.slice(0, 500)}`);

    if (line.length > MAX_LINE_BYTES) {
      callbacks.onEvent({ event: 'malformed', timestamp: new Date(), claude_pid: pid, message: 'line too large' });
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      callbacks.onEvent({ event: 'malformed', timestamp: new Date(), claude_pid: pid, message: line.slice(0, 200) });
      return;
    }

    const type = String(parsed['type'] ?? '');

    if (type === 'system') {
      const sid = parsed['session_id'] as string | undefined;
      if (sid && !sessionId) {
        sessionId = sid;
        callbacks.onEvent({ event: 'session_started', timestamp: new Date(), claude_pid: pid, session_id: sid });
      }
      return;
    }

    if (type === 'result') {
      const stopReason = String(parsed['stop_reason'] ?? '');
      const usage = extractUsage(parsed);
      const rateLimits = extractRateLimits(parsed);
      logger.debug({ issue_identifier: issue.identifier, result_event: parsed }, `claude result event issue_identifier=${issue.identifier}`);

      const log = sessionId
        ? sessionLogger(issue.id, issue.identifier, sessionId)
        : logger;

      if (stopReason === 'end_turn' || stopReason === 'max_turns') {
        log.info(
          { stop_reason: stopReason, ...usage },
          `turn completed issue_identifier=${issue.identifier} stop_reason=${stopReason}`,
        );
        callbacks.onEvent({
          event: 'turn_completed',
          timestamp: new Date(),
          claude_pid: pid,
          session_id: sessionId ?? undefined,
          stop_reason: stopReason,
          usage,
          rate_limits: rateLimits ?? undefined,
        });
      } else {
        log.warn(
          { stop_reason: stopReason, ...usage },
          `turn failed issue_identifier=${issue.identifier} stop_reason=${stopReason}`,
        );
        callbacks.onEvent({
          event: 'turn_failed',
          timestamp: new Date(),
          claude_pid: pid,
          session_id: sessionId ?? undefined,
          stop_reason: stopReason,
          error: `stop_reason=${stopReason}`,
          usage,
          rate_limits: rateLimits ?? undefined,
        });
      }
      return;
    }

    if (type === 'assistant') {
      const text = extractAssistantText(parsed);
      callbacks.onEvent({
        event: 'notification',
        timestamp: new Date(),
        claude_pid: pid,
        session_id: sessionId ?? undefined,
        message: text ?? undefined,
      });
      return;
    }

    callbacks.onEvent({
      event: 'other_message',
      timestamp: new Date(),
      claude_pid: pid,
      session_id: sessionId ?? undefined,
      message: type,
    });
  });

  child.stderr.on('data', (chunk: Buffer) => {
    logger.debug({ issue_identifier: issue.identifier }, `claude stderr: ${chunk.toString()}`);
  });

  await new Promise<void>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(turnTimer);
      cancelSignal.removeEventListener('abort', onCancel);
      rl.close();
      fs.unlink(promptFile, () => {});

      if (done) {
        resolve();
        return;
      }
      done = true;

      if (code !== 0 || signal) {
        const msg = signal ? `killed by ${signal}` : `exit code ${code}`;
        logger.warn({ issue_identifier: issue.identifier, code, signal }, `claude process exited unexpectedly: ${msg}`);
        callbacks.onEvent({
          event: 'turn_failed',
          timestamp: new Date(),
          claude_pid: pid,
          session_id: sessionId ?? undefined,
          error: `subprocess_exit: ${msg}`,
        });
      }

      resolve();
    });

    child.on('error', (err) => {
      clearTimeout(turnTimer);
      cancelSignal.removeEventListener('abort', onCancel);
      done = true;

      const isMissing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      callbacks.onEvent({
        event: 'startup_failed',
        timestamp: new Date(),
        claude_pid: null,
        error: isMissing ? 'claude_not_found' : `spawn error: ${err.message}`,
      });

      resolve();
    });
  });
}

function extractUsage(parsed: Record<string, unknown>) {
  const usage = parsed['usage'] as Record<string, number> | undefined;
  if (!usage) return undefined;
  return {
    input_tokens: Number(usage['input_tokens'] ?? 0),
    output_tokens: Number(usage['output_tokens'] ?? 0),
    total_tokens: Number(usage['total_tokens'] ?? 0),
    cost_usd: usage['cost_usd'] != null ? Number(usage['cost_usd']) : undefined,
  };
}

function extractRateLimits(parsed: Record<string, unknown>): RateLimitInfo | null {
  const rl = parsed['rate_limits'] as Record<string, unknown> | undefined;
  if (!rl) return null;
  return {
    requests_limit: rl['requests_limit'] != null ? Number(rl['requests_limit']) : null,
    requests_remaining: rl['requests_remaining'] != null ? Number(rl['requests_remaining']) : null,
    tokens_limit: rl['tokens_limit'] != null ? Number(rl['tokens_limit']) : null,
    tokens_remaining: rl['tokens_remaining'] != null ? Number(rl['tokens_remaining']) : null,
  };
}

function extractAssistantText(parsed: Record<string, unknown>): string | null {
  const message = parsed['message'] as Record<string, unknown> | undefined;
  if (!message) return null;
  const content = message['content'];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block !== null && (block as Record<string, unknown>)['type'] === 'text') {
        return String((block as Record<string, unknown>)['text'] ?? '').slice(0, 200);
      }
    }
  }
  return null;
}

// Expose for fullCommand diagnostics
export { buildClaudeCommand, shellEscape };
