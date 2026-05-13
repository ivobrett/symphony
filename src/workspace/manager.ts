import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../observability/logger';
import { runHook } from './hooks';

interface HooksConfig {
  before_run?: string | null;
  after_run?: string | null;
  before_remove?: string | null;
  after_create?: string | null;
  timeout_ms: number;
}

interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

export function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

function assertWithinRoot(workspacePath: string, workspaceRoot: string): void {
  const normPath = path.resolve(workspacePath);
  const normRoot = path.resolve(workspaceRoot);
  if (!normPath.startsWith(normRoot + path.sep) && normPath !== normRoot) {
    throw new Error(
      `Workspace path "${normPath}" is outside workspace root "${normRoot}"`,
    );
  }
}

export async function prepareWorkspace(
  identifier: string,
  workspaceRoot: string,
  hooks: HooksConfig,
): Promise<Workspace> {
  const workspace_key = sanitizeIdentifier(identifier);
  const workspacePath = path.join(path.resolve(workspaceRoot), workspace_key);

  assertWithinRoot(workspacePath, workspaceRoot);

  let created_now = false;
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
    created_now = true;
    logger.info({ workspace_path: workspacePath }, 'workspace directory created');
  }

  if (created_now && hooks.after_create) {
    await runHook('after_create', hooks.after_create, workspacePath, hooks.timeout_ms);
  }

  return { path: workspacePath, workspace_key, created_now };
}

export async function removeWorkspace(
  identifier: string,
  workspaceRoot: string,
  hooks: HooksConfig,
): Promise<void> {
  const workspace_key = sanitizeIdentifier(identifier);
  const workspacePath = path.join(path.resolve(workspaceRoot), workspace_key);

  assertWithinRoot(workspacePath, workspaceRoot);

  if (!fs.existsSync(workspacePath)) return;

  if (hooks.before_remove) {
    await runHook('before_remove', hooks.before_remove, workspacePath, hooks.timeout_ms).catch(
      (err) => logger.warn({ err, workspace_path: workspacePath }, 'before_remove hook failed (ignored)'),
    );
  }

  fs.rmSync(workspacePath, { recursive: true, force: true });
  logger.info({ workspace_path: workspacePath }, 'workspace directory removed');
}
