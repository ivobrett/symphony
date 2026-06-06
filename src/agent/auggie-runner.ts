/**
 * Auggie CLI agent runner (Augment Code, print/headless mode)
 *
 * Invokes `auggie --print --output-format json --instruction-file <prompt>`
 * inside the per-issue workspace. Authentication relies on the user having
 * run `auggie login` previously; no API key is injected here.
 *
 * Emits the same AgentEvent shape as the Claude/Gemini runners so the
 * orchestrator treats all backends identically.
 */
import { spawn } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as crypto from 'crypto';
import { AgentEvent, AuggieConfig, Issue } from '../domain';
import { renderPrompt } from './prompt';
import { logger } from '../observability/logger';

const MAX_LINE_BYTES = 10 * 1024 * 1024;

function buildAuggieCommand(config: AuggieConfig, prompt: string, workspaceRoot: string): string[] {
  const parts: string[] = [config.command, '--print', '--allow-indexing'];

  parts.push('--output-format', 'json');
  parts.push('--max-turns', String(config.max_turns));
  parts.push('--workspace-root', workspaceRoot);

  if (config.model) parts.push('--model', config.model);
  if (config.rules_file) parts.push('--rules', config.rules_file);

  // --instruction-file is silently ignored in --print --output-format json mode
  // in auggie 0.29.x, so we pass the prompt via --instruction instead.
  parts.push('--instruction', prompt);

  return parts;
}

export interface RunnerCallbacks {
  onEvent: (event: AgentEvent) => void;
}

export async function runAuggieAgent(
  issue: Issue,
  attempt: number | null,
  workspacePath: string,
  config: AuggieConfig,
  promptTemplate: string,
  callbacks: RunnerCallbacks,
  cancelSignal: AbortSignal,
): Promise<void> {
  const resolvedWs = path.resolve(workspacePath);

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

  if (config.system_prompt) {
    renderedPrompt = `${config.system_prompt}\n\n${renderedPrompt}`;
  }

  const command = buildAuggieCommand(config, renderedPrompt, resolvedWs);

  logger.info(
    { issue_id: issue.id, issue_identifier: issue.identifier, cwd: resolvedWs, model: config.model },
    `launching auggie cli issue_identifier=${issue.identifier}`,
  );

  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true', AUGMENT_DISABLE_AUTO_UPDATE: '1' };

  const [bin, ...args] = command;
  const child = spawn(bin, args, { cwd: resolvedWs, env, stdio: ['ignore', 'pipe', 'pipe'] });

  const pid = child.pid ?? null;
  const sessionId = `auggie-${issue.identifier}-${crypto.randomUUID().slice(0, 8)}`;
  let done = false;

  callbacks.onEvent({ event: 'session_started', timestamp: new Date(), claude_pid: pid, session_id: sessionId });

  const turnTimer = setTimeout(() => {
    if (!done) {
      done = true;
      child.kill('SIGKILL');
      callbacks.onEvent({
        event: 'turn_failed', timestamp: new Date(), claude_pid: pid,
        session_id: sessionId, error: 'turn_timeout',
      });
    }
  }, config.turn_timeout_ms);

  const onCancel = () => {
    if (!done) {
      done = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    }
  };
  cancelSignal.addEventListener('abort', onCancel);

  const stdoutLines: string[] = [];
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  rl.on('line', (line) => {
    if (line.length > MAX_LINE_BYTES) {
      callbacks.onEvent({ event: 'malformed', timestamp: new Date(), claude_pid: pid, message: 'line too large' });
      return;
    }
    logger.debug({ issue_identifier: issue.identifier }, `auggie stdout: ${line.slice(0, 500)}`);
    stdoutLines.push(line);
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    logger.debug({ issue_identifier: issue.identifier }, `auggie stderr: ${text}`);
    callbacks.onEvent({
      event: 'notification', timestamp: new Date(), claude_pid: pid,
      session_id: sessionId, message: `[stderr] ${text.slice(0, 200)}`,
    });
  });

  await new Promise<void>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(turnTimer);
      cancelSignal.removeEventListener('abort', onCancel);
      rl.close();

      // Auggie --output-format json emits NDJSON; the final result line is
      // {"type":"result","result":"<text>","is_error":bool,"num_turns":N,...}
      let response: string | null = null;
      let auggieIsError = false;
      let numTurns: number | undefined;
      for (const line of stdoutLines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (parsed['type'] === 'result') {
            if (typeof parsed['result'] === 'string') response = (parsed['result'] as string).trim();
            if (typeof parsed['is_error'] === 'boolean') auggieIsError = parsed['is_error'] as boolean;
            if (typeof parsed['num_turns'] === 'number') numTurns = parsed['num_turns'] as number;
          }
        } catch {
          // not JSON — ignore (e.g., "Applying --max-turns override" banner)
        }
      }
      if (response) {
        callbacks.onEvent({ event: 'notification', timestamp: new Date(), claude_pid: pid, session_id: sessionId, message: response });
      }

      if (done) { resolve(); return; }
      done = true;

      if (code === 0 && !auggieIsError) {
        callbacks.onEvent({
          event: 'turn_completed', timestamp: new Date(), claude_pid: pid,
          session_id: sessionId, stop_reason: numTurns != null ? `end_turn:${numTurns}` : 'end_turn',
        });
      } else {
        const msg = auggieIsError
          ? `auggie reported is_error=true${response ? `: ${response.slice(0, 200)}` : ''}`
          : signal ? `killed by ${signal}` : `exit code ${code}`;
        callbacks.onEvent({ event: 'turn_failed', timestamp: new Date(), claude_pid: pid, session_id: sessionId, error: `subprocess_exit: ${msg}` });
      }
      resolve();
    });

    child.on('error', (err) => {
      clearTimeout(turnTimer);
      cancelSignal.removeEventListener('abort', onCancel);
      done = true;
      const isMissing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      callbacks.onEvent({
        event: 'startup_failed', timestamp: new Date(), claude_pid: null,
        error: isMissing ? 'auggie_not_found: install Auggie CLI and run `auggie login`' : `spawn error: ${err.message}`,
      });
      resolve();
    });
  });
}

export { buildAuggieCommand };
