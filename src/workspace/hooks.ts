import { spawn } from 'child_process';
import { logger } from '../observability/logger';

const MAX_LOG_OUTPUT = 4096;

export async function runHook(
  hookName: string,
  script: string,
  cwd: string,
  timeoutMs: number,
  context: Record<string, string> = {},
): Promise<void> {
  const effectiveTimeout = timeoutMs > 0 ? timeoutMs : 60000;

  // Perform simple template replacement with shell escaping
  let interpolatedScript = script;
  for (const [key, value] of Object.entries(context)) {
    // Escape single quotes for shell safety
    const escapedValue = value.replace(/'/g, "'\\''");
    const regex = new RegExp(`{{${key}}}`, 'g');
    interpolatedScript = interpolatedScript.replace(regex, escapedValue);
  }

  logger.info({ hook: hookName, cwd }, `running hook hook=${hookName}`);

  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-lc', interpolatedScript], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      reject(new Error(`Hook "${hookName}" timed out after ${effectiveTimeout}ms`));
    }, effectiveTimeout);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_LOG_OUTPUT) stdout = stdout.slice(-MAX_LOG_OUTPUT);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_LOG_OUTPUT) stderr = stderr.slice(-MAX_LOG_OUTPUT);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;

      if (code !== 0) {
        logger.warn(
          { hook: hookName, exit_code: code, stdout: stdout.slice(-512), stderr: stderr.slice(-512) },
          `hook failed hook=${hookName} exit_code=${code}`,
        );
        reject(new Error(`Hook "${hookName}" exited with code ${code}`));
      } else {
        logger.info({ hook: hookName }, `hook completed hook=${hookName}`);
        resolve();
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (timedOut) return;
      reject(new Error(`Hook "${hookName}" spawn error: ${err.message}`));
    });
  });
}
