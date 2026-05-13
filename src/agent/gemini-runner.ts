/**
 * Gemini CLI agent runner (headless mode)
 *
 * Invokes `gemini -p "<prompt>"` inside the workspace directory.
 * Supports:
 *   - JSON structured output (--output-format json)
 *   - Plain text fallback
 *   - Multi-account key rotation via GeminiKeyPool (see gemini-key-rotation.ts)
 *
 * The runner emits the same AgentEvent types as the Claude Code runner so the
 * orchestrator can treat all backends identically.
 */
import { spawn } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { AgentEvent, GeminiConfig, Issue } from '../domain';
import { renderPrompt } from './prompt';
import { logger } from '../observability/logger';
import { activeKey, isRateLimitError, rotateKey } from './gemini-key-rotation';

const MAX_LINE_BYTES = 10 * 1024 * 1024;

function buildGeminiCommand(config: GeminiConfig): string[] {
  const parts: string[] = ['/opt/homebrew/bin/npx', '@google/gemini-cli'];

  // Headless mode
  parts.push('--approval-mode', 'yolo');
  parts.push('--skip-trust');

  if (config.model) {
    parts.push('--model', config.model);
  }
  if (config.system_prompt) parts.push('--system-instruction', config.system_prompt);
  if (config.sandbox) parts.push('--sandbox', config.sandbox);
  parts.push('--output-format', config.output_format);

  return parts;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RunnerCallbacks {
  onEvent: (event: AgentEvent) => void;
}

export async function runGeminiAgent(
  issue: Issue,
  attempt: number | null,
  workspacePath: string,
  config: GeminiConfig,
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

  const promptFile = path.join(os.tmpdir(), `symphony-gemini-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(promptFile, renderedPrompt, 'utf8');

  const command = buildGeminiCommand(config);
  // Pass prompt via -p flag only (not also via stdin to avoid duplication)
  command.push('-p', renderedPrompt);

  // Use the currently active key from the pool (or the primary key)
  const apiKey = activeKey(config);

  logger.info(
    { issue_id: issue.id, issue_identifier: issue.identifier, cwd: resolvedWs },
    `launching gemini cli issue_identifier=${issue.identifier}`,
  );

  // Use a per-run temp HOME so the CLI cannot find cached OAuth credentials.
  // Without this, the CLI prefers OAuth over GOOGLE_API_KEY (OAuth quota is tiny
  // and doesn't appear in the Google AI Studio dashboard).
  const tmpHome = path.join(os.tmpdir(), `symphony-gemini-home-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpHome, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env };
  env['HOME'] = tmpHome;
  env['GOOGLE_API_KEY'] = apiKey;
  env['GEMINI_API_KEY'] = apiKey;
  // Remove any cached OAuth tokens from the inherited env
  delete env['GOOGLE_OAUTH_ACCESS_TOKEN'];
  delete env['GOOGLE_APPLICATION_CREDENTIALS'];
  env['GEMINI_CLI_TRUST_WORKSPACE'] = 'true';
  env['CI'] = 'true';

  const [bin, ...args] = command;
  const child = spawn(bin, args, {
    cwd: resolvedWs,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // stdin is ignored — prompt is passed via -p flag

  const pid = child.pid ?? null;
  const sessionId = `gemini-${issue.identifier}-${crypto.randomUUID().slice(0, 8)}`;
  let done = false;
  let rateLimitDetected = false;

  callbacks.onEvent({ event: 'session_started', timestamp: new Date(), claude_pid: pid, session_id: sessionId });

  const turnTimer = setTimeout(() => {
    if (!done) {
      done = true;
      child.kill('SIGKILL');
      callbacks.onEvent({
        event: 'turn_failed',
        timestamp: new Date(),
        claude_pid: pid,
        session_id: sessionId,
        error: 'turn_timeout',
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

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  rl.on('line', (line) => {
    if (line.length > MAX_LINE_BYTES) {
      callbacks.onEvent({ event: 'malformed', timestamp: new Date(), claude_pid: pid, message: 'line too large' });
      return;
    }

    logger.debug({ issue_identifier: issue.identifier }, `gemini stdout: ${line.slice(0, 500)}`);

    // Check for rate limit signals in output
    if (isRateLimitError(line)) {
      rateLimitDetected = true;
      logger.warn({ issue_identifier: issue.identifier }, `gemini rate limit detected, will rotate key on next attempt`);
    }

    if (config.output_format === 'json') {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
        handleJsonEvent(parsed, pid, sessionId, callbacks);
        return;
      } catch {
        // fall through to plain text
      }
    }

    callbacks.onEvent({
      event: 'notification',
      timestamp: new Date(),
      claude_pid: pid,
      session_id: sessionId,
      message: line.slice(0, 200),
    });
  });

  // Also watch stderr for rate limit signals and log as notifications
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    logger.debug({ issue_identifier: issue.identifier }, `gemini stderr: ${text}`);
    
    // Show errors in the terminal
    callbacks.onEvent({ 
      event: 'notification', 
      timestamp: new Date(), 
      claude_pid: pid, 
      session_id: sessionId, 
      message: `[stderr] ${text.slice(0, 200)}` 
    });

    if (isRateLimitError(text)) {
      rateLimitDetected = true;
      logger.warn({ issue_identifier: issue.identifier }, 'gemini rate limit in stderr, will rotate key');
    }
  });

  await new Promise<void>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(turnTimer);
      cancelSignal.removeEventListener('abort', onCancel);
      rl.close();
      fs.unlink(promptFile, () => {});

      fs.rm(tmpHome, { recursive: true, force: true }, () => {});

      if (done) { resolve(); return; }
      done = true;

      // Rotate key if rate-limited, so next attempt uses a fresh account
      if (rateLimitDetected) {
        const nextKey = rotateKey(config);
        if (nextKey) {
          logger.info({ issue_identifier: issue.identifier }, 'gemini key rotated for next attempt');
        }
      }

      // If exit code is 0, it's a success regardless of transient rate limits in stderr
      if (code === 0) {
        callbacks.onEvent({
          event: 'turn_completed',
          timestamp: new Date(),
          claude_pid: pid,
          session_id: sessionId,
          stop_reason: 'end_turn',
        });
      } else {
        const msg = rateLimitDetected
          ? 'rate_limit: key rotated, retrying on next attempt'
          : signal ? `killed by ${signal}` : `exit code ${code}`;
        callbacks.onEvent({
          event: 'turn_failed',
          timestamp: new Date(),
          claude_pid: pid,
          session_id: sessionId,
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
        error: isMissing
          ? 'gemini_not_found: run `npm install -g @google/gemini-cli`'
          : `spawn error: ${err.message}`,
      });
      resolve();
    });
  });
}

function handleJsonEvent(
  parsed: Record<string, unknown>,
  pid: number | null,
  sessionId: string,
  callbacks: RunnerCallbacks,
): void {
  const content = parsed['content'] as string | undefined;
  const usage = parsed['usageMetadata'] as Record<string, number> | undefined;
  const usageInfo = usage ? {
    input_tokens: Number(usage['promptTokenCount'] ?? 0),
    output_tokens: Number(usage['candidatesTokenCount'] ?? 0),
    total_tokens: Number(usage['totalTokenCount'] ?? 0),
  } : undefined;

  if (content) {
    callbacks.onEvent({
      event: 'notification',
      timestamp: new Date(),
      claude_pid: pid,
      session_id: sessionId,
      message: String(content).slice(0, 200),
      usage: usageInfo,
    });
  }
}

export { buildGeminiCommand, shellEscape as geminiShellEscape };
