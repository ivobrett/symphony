/**
 * Gemini API key rotation
 *
 * When the Gemini CLI hits a rate limit (429) or quota error on one key,
 * the orchestrator calls `rotateKey()` to advance to the next key in the
 * pool. The pool is a simple round-robin: current_index advances by 1 mod
 * pool length. The updated index is written back to the live GeminiConfig
 * so all subsequent runs use the new key without restart.
 *
 * WORKFLOW.md configuration:
 *
 *   gemini:
 *     api_key: $GEMINI_KEY_1          # primary / also pool[0]
 *     key_pool:
 *       - $GEMINI_KEY_2
 *       - $GEMINI_KEY_3
 *       - $GEMINI_KEY_4
 *
 * Environment variables:
 *   GEMINI_KEY_1, GEMINI_KEY_2, GEMINI_KEY_3, GEMINI_KEY_4 …
 *
 * Each key represents a separate Google account. Symphony will rotate
 * through them automatically when it detects quota exhaustion.
 */
import { GeminiConfig, GeminiKeyPool } from '../domain';
import { logger } from '../observability/logger';

/** Patterns in gemini stderr/stdout that indicate a quota/rate-limit error */
const RATE_LIMIT_PATTERNS = [
  /429/,
  /quota/i,
  /rate.?limit/i,
  /resource.?exhausted/i,
  /too.?many.?requests/i,
  /exceeded.*limit/i,
];

export function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(message));
}

/**
 * Returns the currently active GOOGLE_API_KEY for this config.
 * If no pool is configured, returns the primary key.
 */
export function activeKey(config: GeminiConfig): string {
  if (!config.key_pool || config.key_pool.api_keys.length === 0) {
    return config.api_key;
  }
  const pool = config.key_pool;
  // pool[0] === primary key, pool[1..n] are secondary accounts
  return pool.api_keys[pool.current_index] ?? config.api_key;
}

/**
 * Rotate to the next key in the pool.
 * Returns the new active key, or null if there is only one key (no rotation
 * possible).
 */
export function rotateKey(config: GeminiConfig): string | null {
  if (!config.key_pool || config.key_pool.api_keys.length <= 1) {
    logger.warn('gemini key rotation requested but pool has only one key — no rotation possible');
    return null;
  }

  const pool = config.key_pool;
  const prev = pool.current_index;
  pool.current_index = (pool.current_index + 1) % pool.api_keys.length;
  const next = activeKey(config);

  logger.info(
    { prev_index: prev, next_index: pool.current_index, pool_size: pool.api_keys.length },
    `gemini key rotated: account ${prev + 1} → account ${pool.current_index + 1} of ${pool.api_keys.length}`,
  );

  return next;
}

/**
 * Build a GeminiKeyPool from config values.
 * The primary api_key is always pool[0]; additional keys follow.
 */
export function buildKeyPool(primaryKey: string, additionalKeys: string[]): GeminiKeyPool {
  return {
    api_keys: [primaryKey, ...additionalKeys].filter(Boolean),
    current_index: 0,
  };
}
