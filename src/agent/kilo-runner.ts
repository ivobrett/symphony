/**
 * KiloCode CLI agent runner (kilo run --auto --format json)
 *
 * Invokes `kilo run --auto --format json [--model <model>] [--agent <mode>]`
 * inside the per-issue workspace and pipes the rendered prompt via stdin.
 * Authentication is handled by the user's existing `kilo auth` / `kilo connect`
 * credentials — no API key is injected here.
 *
 * Exit codes: 0 = success, 1 = error, 124 = timeout (per kilo docs).
 *
 * With --format json, kilo emits NDJSON events on stdout:
 *   {type:"text", part:{text:"..."}, sessionID:"...", timestamp:...}
 *   {type:"tool_use", part:{...}, ...}
 *   {type:"step_start"|"step_finish", ...}
 *   {type:"error", error:{...}, ...}
 */
import { spawn } from 'child_process';
import * as readline from 'readline';
import * as crypto from 'crypto';
import * as path from 'path';
import { AgentEvent, KiloConfig, Issue } from '../domain';
import { renderPrompt } from './prompt';
import { logger } from '../observability/logger';

const MAX_LINE_BYTES = 10 * 1024 * 1024;

function buildKiloCommand(config: KiloConfig): string[] {
  const parts: string[] = [config.command, 'run', '--auto', '--format', 'json'];
  if (config.model) parts.push('--model', config.model);
  if (config.agent_mode) parts.push('--agent', config.agent_mode);
  return parts;
}

export interface RunnerCallbacks {
  onEvent: (event: AgentEvent) => void;
}

export async function runKiloAgent(
  issue: Issue,
  attempt: number | null,
  workspacePath: string,
  config: KiloConfig,
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

  const command = buildKiloCommand(config);

  logger.info(
    { issue_id: issue.id, issue_identifier: issue.identifier, cwd: resolvedWs, model: config.model },
    `launching kilo cli issue_identifier=${issue.identifier}`,
  );

  const [bin, ...args] = command;
  // Prompt is passed via stdin; kilo appends non-TTY stdin to the message.
  const child = spawn(bin, args, { cwd: resolvedWs, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });

  const pid = child.pid ?? null;
  const sessionId = `kilo-${issue.identifier}-${crypto.randomUUID().slice(0, 8)}`;
  let done = false;

  callbacks.onEvent({ event: 'session_started', timestamp: new Date(), claude_pid: pid, session_id: sessionId });

  // Write prompt to stdin then close it so kilo starts processing.
  child.stdin.write(renderedPrompt, 'utf8');
  child.stdin.end();

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

  const textChunks: string[] = [];
  let kiloError: string | undefined;

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.length > MAX_LINE_BYTES) return;
    logger.debug({ issue_identifier: issue.identifier }, `kilo stdout: ${line.slice(0, 500)}`);
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    try {
      const evt = JSON.parse(trimmed) as Record<string, unknown>;
      if (evt['type'] === 'text') {
        const part = evt['part'] as Record<string, unknown> | undefined;
        const text = typeof part?.['text'] === 'string' ? (part['text'] as string).trim() : '';
        if (text) {
          textChunks.push(text);
          callbacks.onEvent({ event: 'notification', timestamp: new Date(), claude_pid: pid, session_id: sessionId, message: text.slice(0, 500) });
        }
      } else if (evt['type'] === 'error') {
        const errObj = evt['error'] as Record<string, unknown> | undefined;
        kiloError = String(errObj?.['message'] ?? errObj?.['name'] ?? 'kilo_error');
        logger.warn({ issue_identifier: issue.identifier, kiloError }, 'kilo error event');
      }
    } catch {
      // non-JSON line — ignore
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    logger.debug({ issue_identifier: issue.identifier }, `kilo stderr: ${text.slice(0, 300)}`);
  });

  await new Promise<void>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(turnTimer);
      cancelSignal.removeEventListener('abort', onCancel);
      rl.close();

      if (done) { resolve(); return; }
      done = true;

      // Exit 124 = kilo's built-in timeout; 0 = success; anything else = error.
      if (code === 0 && !kiloError) {
        callbacks.onEvent({
          event: 'turn_completed', timestamp: new Date(), claude_pid: pid,
          session_id: sessionId, stop_reason: 'end_turn',
        });
      } else {
        const msg = code === 124
          ? 'kilo_timeout: task exceeded time limit'
          : kiloError
          ? `kilo_error: ${kiloError}`
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
        error: isMissing ? 'kilo_not_found: install with `npm install -g @kilocode/cli` and run `kilo auth`' : `spawn error: ${err.message}`,
      });
      resolve();
    });
  });
}
