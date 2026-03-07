import chokidar from 'chokidar';
import { logger } from '../observability/logger';

export function watchWorkflow(filePath: string, onChange: () => void): () => void {
  const watcher = chokidar.watch(filePath, { persistent: true, ignoreInitial: true });

  watcher.on('change', () => {
    logger.info({ file: filePath }, 'workflow file changed, reloading');
    onChange();
  });

  watcher.on('error', (err) => {
    logger.error({ err, file: filePath }, 'workflow file watcher error');
  });

  return () => { watcher.close().catch(() => {}); };
}
