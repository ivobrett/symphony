import 'dotenv/config';
import * as path from 'path';
import { Orchestrator } from './orchestrator';
import { startHttpServer } from './observability/server';
import { logger } from './observability/logger';

function parseArgs(): { workflowPath: string; port: number | null } {
  const args = process.argv.slice(2);
  let workflowPath = path.resolve(process.cwd(), 'WORKFLOW.md');
  let port: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--workflow' || args[i] === '-w') && args[i + 1]) {
      workflowPath = path.resolve(args[++i]);
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i].startsWith('--port=')) {
      port = parseInt(args[i].split('=')[1], 10);
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { workflowPath, port };
}

function printHelp(): void {
  console.log(`
Symphony - Claude Code Orchestration Service

Usage:
  symphony [options]

Options:
  --workflow, -w <path>  Path to WORKFLOW.md (default: ./WORKFLOW.md)
  --port <n>             Enable HTTP server on given port
  --help, -h             Show this help

Environment:
  ANTHROPIC_API_KEY      Required: Claude API key
  LINEAR_API_KEY         Required: Linear API key (or set in WORKFLOW.md)
  LOG_LEVEL              Log level: trace|debug|info|warn|error (default: info)
`);
}

async function main(): Promise<void> {
  const { workflowPath, port } = parseArgs();

  logger.info({ workflow_path: workflowPath }, 'symphony starting');

  const orchestrator = new Orchestrator({
    workflowPath,
    serverPort: port ?? undefined,
  });

  let stopServer: (() => Promise<void>) | null = null;

  // Shutdown handler
  const shutdown = async (signal: string) => {
    logger.info({ signal }, `received ${signal}, shutting down`);
    orchestrator.stop();
    if (stopServer) await stopServer();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await orchestrator.start();
  } catch (err) {
    logger.error({ err }, 'failed to start orchestrator');
    process.exit(1);
  }

  // Start HTTP server: --port flag takes precedence over server.port in WORKFLOW.md
  const effectivePort = port ?? orchestrator.getConfig().server.port;
  if (effectivePort) {
    try {
      stopServer = await startHttpServer({
        port: effectivePort,
        getSnapshot: () => orchestrator.getSnapshot(),
        triggerRefresh: () => orchestrator.triggerRefresh(),
      });
    } catch (err) {
      logger.error({ err }, 'failed to start HTTP server');
    }
  }
}

void main();
