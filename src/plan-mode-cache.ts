/**
 * Per-session in-process cache for plan-mode state.
 *
 * Issue #10: the before_tool_call hook used to call
 * `loadSessionStore(storePath, { skipCache: true })` on EVERY tool call —
 * a fresh JSON.parse of the whole session store from disk, before the
 * gate decision. With a chatty agent (50+ tool calls per turn) and a
 * busy gateway (many active sessions, large store file) that's tens to
 * hundreds of milliseconds wasted per tool call.
 *
 * The cache:
 *
 *   - Keyed by sessionKey (stable per session for the duration of a turn).
 *   - Stores the resolved planMode + autoApprove plus a timestamp.
 *   - Hit window is configurable (default: 5_000ms — long enough to
 *     skip per-turn lookups for a chatty agent, short enough to catch
 *     external state flips like a slash command run between turns).
 *   - Bust: explicit `bustPlanModeCache(sessionKey)` when we know the
 *     state changed (tool body wrote new state, slash command flipped,
 *     session_start fired, etc).
 *   - Bust-all: `bustAllPlanModeCache()` for global resets (test cleanup,
 *     gateway restart on the same process).
 *
 * The cache is intentionally PROCESS-LOCAL — same lifecycle as the
 * gateway. A multi-process gateway would need a shared invalidation
 * channel, but v1.0 ships single-process.
 */

export type PlanModeCacheEntry = {
  /**
   * The cached SessionEntry-shaped object the caller passes to
   * shouldBlockMutation. We cache the whole entry (not just planMode)
   * because the gate also reads autoApprove and other slice fields,
   * and the cost of carrying a few extra bytes is trivial vs the cost
   * of a fresh disk read.
   *
   * `undefined` is a legitimate cache value — it means "we looked,
   * the entry doesn't exist yet" and we want subsequent calls in the
   * same window to skip the disk read too.
   */
  entry: Record<string, unknown> | undefined;
  /**
   * Wall-clock timestamp (ms) when this entry was cached. Compared
   * against now() at lookup time.
   */
  cachedAt: number;
};

/**
 * Default cache age in milliseconds. 5 seconds: short enough to catch
 * a slash command flip between turns (typical inter-turn latency is
 * well under 5s), long enough to skip ALL per-turn lookups for a
 * chatty agent (typical turn duration is well under 5s, often < 1s).
 */
export const DEFAULT_PLAN_MODE_CACHE_MAX_AGE_MS = 5_000;

const cache = new Map<string, PlanModeCacheEntry>();

/**
 * Read a cached plan-mode entry for a sessionKey. Returns undefined when
 * the cache is empty for that key OR when the cached entry has aged
 * past `maxAgeMs`. Caller should fall back to a fresh disk read on miss
 * and call setPlanModeCache to populate the cache.
 */
export function getPlanModeCache(
  sessionKey: string,
  opts: { maxAgeMs?: number; now?: () => number } = {},
): PlanModeCacheEntry | undefined {
  const maxAge = opts.maxAgeMs ?? DEFAULT_PLAN_MODE_CACHE_MAX_AGE_MS;
  const now = opts.now ?? Date.now;
  const cached = cache.get(sessionKey);
  if (!cached) return undefined;
  if (now() - cached.cachedAt > maxAge) {
    // Expired — drop and force the caller to refetch.
    cache.delete(sessionKey);
    return undefined;
  }
  return cached;
}

/**
 * Populate the cache for a sessionKey. Overwrites any existing entry.
 * Pass `undefined` for entry when the disk read returned no entry —
 * that's a legitimate cache value (don't keep retrying on every tool
 * call when we know the entry doesn't exist).
 */
export function setPlanModeCache(
  sessionKey: string,
  entry: Record<string, unknown> | undefined,
  opts: { now?: () => number } = {},
): void {
  const now = opts.now ?? Date.now;
  cache.set(sessionKey, { entry, cachedAt: now() });
}

/**
 * Invalidate the cache entry for a single sessionKey. Call this when we
 * know the state changed (tool body wrote new state, slash command
 * flipped, session_start fired for this session, etc) so the next
 * before_tool_call gets a fresh read.
 */
export function bustPlanModeCache(sessionKey: string): void {
  cache.delete(sessionKey);
}

/**
 * Invalidate the entire cache. Used on gateway restart-equivalent
 * lifecycle events and from test setup/teardown. Cheap (single Map.clear).
 */
export function bustAllPlanModeCache(): void {
  cache.clear();
}

/**
 * Test-only: read cache size (number of distinct sessionKeys cached).
 * Exported for unit tests that want to assert hit/miss behavior without
 * reaching into the module-private Map.
 */
export function getPlanModeCacheSizeForTest(): number {
  return cache.size;
}
