/**
 * Freebuff / Codebuff agent runner
 *
 * Two modes depending on what is available:
 *
 * 1. **SDK mode** (recommended, requires CODEBUFF_API_KEY):
 *    Uses @codebuff/sdk — `CodebuffClient.run()` — which is fully
 *    programmatic and headless. Works with both codebuff (paid) and
 *    freebuff (the free tier uses the same SDK entry point).
 *    Install: npm install @codebuff/sdk
 *
 * 2. **CLI stdin mode** (fallback, no API key needed):
 *    Spawns `freebuff --cwd <workspace>` and writes the prompt to its
 *    stdin, then closes stdin to signal end-of-input. This works because
 *    freebuff reads from stdin when it is not a TTY (CI=true).
 *    The process exit code determines success/failure.
 *
 * Configure in WORKFLOW.md:
 *   freebuff:
 *     use_sdk: true              # true = SDK mode, false = CLI stdin mode
 *     api_key: $CODEBUFF_API_KEY # required for SDK mode
 *     agent: codebuff/base@latest
 *     command: freebuff          # only used in CLI mode
 */
import * as path from 'path';
import { FreebuffConfig, Issue } from '../domain';
import { renderPrompt } from './prompt';
import { logger } from '../observability/logger';
import type { AgentEvent } from '../domain';

export interface RunnerCallbacks {
  onEvent: (event: AgentEvent) => void;
}

export async function runFreebuffAgent(
  issue: Issue,
  attempt: number | null,
  workspacePath: string,
  config: FreebuffConfig,
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

  if (config.use_sdk && config.api_key) {
    await runWithSdk(issue, renderedPrompt, resolvedWs, config, callbacks, cancelSignal);
  } else {
    await runWithCli(issue, renderedPrompt, resolvedWs, config, callbacks, cancelSignal);
  }
}

// ─── SDK mode ───────────────────────────────────────────────────────────────

async function runWithSdk(
  issue: Issue,
  prompt: string,
  workspacePath: string,
  config: FreebuffConfig,
  callbacks: RunnerCallbacks,
  cancelSignal: AbortSignal,
): Promise<void> {
  // Dynamically import so the SDK is optional — only needed in SDK mode
  let CodebuffClient: new (opts: { apiKey: string; cwd: string }) => {
    run(opts: {
      agent: string;
      prompt: string;
      handleEvent?: (event: { type: string; content?: string }) => void;
    }): Promise<{ output: string }>;
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@codebuff/sdk') as { CodebuffClient: typeof CodebuffClient };
    CodebuffClient = mod.CodebuffClient;
  } catch {
    callbacks.onEvent({
      event: 'startup_failed',
      timestamp: new Date(),
      claude_pid: null,
      error: 'freebuff_sdk_not_found: run `npm install @codebuff/sdk` in the symphony directory',
    });
    return;
  }

  const sessionId = `freebuff-sdk-${issue.identifier}`;
  callbacks.onEvent({ event: 'session_started', timestamp: new Date(), claude_pid: null, session_id: sessionId });

  logger.info(
    { issue_identifier: issue.identifier, agent: config.agent, cwd: workspacePath },
    `launching freebuff via SDK issue_identifier=${issue.identifier}`,
  );

  // Turn timeout via AbortSignal race
  const timeoutHandle = setTimeout(() => {
    if (!cancelSignal.aborted) {
      callbacks.onEvent({
        event: 'turn_failed',
        timestamp: new Date(),
        claude_pid: null,
        session_id: sessionId,
        error: 'turn_timeout',
      });
    }
  }, config.turn_timeout_ms);

  try {
    const client = new CodebuffClient({ apiKey: config.api_key!, cwd: workspacePath });

    const runPromise = client.run({
      agent: config.agent,
      prompt,
      handleEvent: (event) => {
        logger.debug({ issue_identifier: issue.identifier, event_type: event.type }, 'freebuff sdk event');
        if (event.type === 'text' && event.content) {
          callbacks.onEvent({
            event: 'notification',
            timestamp: new Date(),
            claude_pid: null,
            session_id: sessionId,
            message: String(event.content).slice(0, 200),
          });
        }
        if (event.type === 'tool_call' || event.type === 'tool_result') {
          callbacks.onEvent({
            event: 'other_message',
            timestamp: new Date(),
            claude_pid: null,
            session_id: sessionId,
            message: event.type,
          });
        }
      },
    });

    // Race against cancel signal
    await Promise.race([
      runPromise,
      new Promise<never>((_, reject) =>
        cancelSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      ),
    ]);

    callbacks.onEvent({
      event: 'turn_completed',
      timestamp: new Date(),
      claude_pid: null,
      session_id: sessionId,
      stop_reason: 'end_turn',
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'cancelled') return; // cancelled by orchestrator — no event needed
    callbacks.onEvent({
      event: 'turn_failed',
      timestamp: new Date(),
      claude_pid: null,
      session_id: sessionId,
      error: msg,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ─── CLI stdin mode ──────────────────────────────────────────────────────────

async function runWithCli(
  issue: Issue,
  prompt: string,
  workspacePath: string,
  config: FreebuffConfig,
  callbacks: RunnerCallbacks,
  cancelSignal: AbortSignal,
): Promise<void> {
  const { spawn } = await import('child_process');
  const { createInterface } = await import('readline');

  const sessionId = `freebuff-cli-${issue.identifier}`;
  callbacks.onEvent({ event: 'session_started', timestamp: new Date(), claude_pid: null, session_id: sessionId });

  logger.info(
    { issue_identifier: issue.identifier, cwd: workspacePath },
    `launching freebuff via CLI stdin issue_identifier=${issue.identifier}`,
  );

  // freebuff reads from stdin when not a TTY — we close stdin after writing the prompt
  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true', NO_COLOR: '1' };

  const child = spawn(config.command, ['--cwd', workspacePath], {
    cwd: workspacePath,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pid = child.pid ?? null;
  let done = false;

  // Write prompt to stdin then close it to signal EOF
  child.stdin.write(prompt + '\n');
  child.stdin.end();

  const turnTimer = setTimeout(() => {
    if (!done) {
      done = true;
      child.kill('SIGKILL');
      callbacks.onEvent({ event: 'turn_failed', timestamp: new Date(), claude_pid: pid, session_id: sessionId, error: 'turn_timeout' });
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

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    logger.debug({ issue_identifier: issue.identifier }, `freebuff stdout: ${line.slice(0, 500)}`);
    callbacks.onEvent({ event: 'notification', timestamp: new Date(), claude_pid: pid, session_id: sessionId, message: line.slice(0, 200) });
  });

  child.stderr.on('data', (chunk: Buffer) => {
    logger.debug({ issue_identifier: issue.identifier }, `freebuff stderr: ${chunk.toString()}`);
  });

  await new Promise<void>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(turnTimer);
      cancelSignal.removeEventListener('abort', onCancel);
      rl.close();
      if (done) { resolve(); return; }
      done = true;
      if (code === 0) {
        callbacks.onEvent({ event: 'turn_completed', timestamp: new Date(), claude_pid: pid, session_id: sessionId, stop_reason: 'end_turn' });
      } else {
        const msg = signal ? `killed by ${signal}` : `exit code ${code}`;
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
        error: isMissing ? `freebuff_not_found: run \`npm install -g freebuff\`` : `spawn error: ${err.message}`,
      });
      resolve();
    });
  });
}
