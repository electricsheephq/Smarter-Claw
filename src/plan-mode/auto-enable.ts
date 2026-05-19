/**
 * Plan-mode auto-enable matching.
 *
 * **Parity contract**: byte-identical port of the in-host
 * `src/agents/plan-mode/auto-enable.ts` at commit `ea04ea52c7`
 * (`/Users/lume/repos/openclaw-pr70071-rebase/src/agents/plan-mode/auto-enable.ts`).
 *
 * Only adaptation: this file lives at `src/plan-mode/` to match the
 * plugin's existing namespace conventions (the in-host puts plan-mode
 * code under `src/agents/plan-mode/`).
 *
 * # What this does
 *
 * Evaluates whether a given model id matches any of the regex
 * patterns configured under `agents.defaults.planMode.autoEnableFor`.
 * When a match is found, the runtime caller is expected to flip the
 * session into plan mode at session start (unless the user has
 * already toggled it explicitly).
 *
 * This helper is intentionally pure and synchronous so it can be
 * called from hot paths (session-entry materialization, cron-turn
 * setup) without adding async overhead.
 *
 * # Compiled-regex cache
 *
 * Patterns rarely change at runtime (config is static within a
 * gateway lifetime); compiling each pattern once and memoizing
 * avoids per-call regex allocation. The cache key is the raw pattern
 * string so callers don't need to pre-compile.
 *
 * # Surgical-port rationale (2026-05-12)
 *
 * Wave-1 audit slice S5 found the plugin had no equivalent of this
 * helper. The in-host wires `evaluateAutoEnableForMatch` into
 * session-start so models matching configured patterns auto-enter
 * plan mode.
 *
 * # Wiring status — NOT YET WIRED (Wave-1 finding W1-A5)
 *
 * This helper is a correct, tested port — but it currently has NO
 * caller in `src/`. A configured `autoEnableFor` pattern therefore
 * has no effect yet. Wiring it needs three pieces the plugin doesn't
 * yet have cleanly: (1) an `autoEnableFor` entry in the plugin's
 * `configSchema`, (2) a once-per-session trigger (auto-enable must
 * fire at session start, NOT every turn — a per-turn caller would
 * drag the user back into plan mode after they exit), (3) reliable
 * access to the resolved model id at that trigger point. Tracked as
 * a dedicated issue; until then this file is a building block, not
 * a live feature. (Previously this header claimed it "restores that
 * capability" — it does not, yet. Corrected to avoid the false
 * claim that W1-A5 flagged.)
 *
 * host_ref: src/agents/plan-mode/auto-enable.ts (commit ea04ea52c7)
 */

const compiledPatternCache = new Map<string, RegExp | null>();

function compilePattern(pattern: string): RegExp | null {
  if (compiledPatternCache.has(pattern)) {
    return compiledPatternCache.get(pattern) ?? null;
  }
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(pattern);
  } catch {
    // Malformed pattern → treat as non-matching. Operators see the
    // set-value go silent rather than a gateway crash; the intent is
    // "auto-enable for these models", and a broken pattern should
    // not enable for EVERY model.
    compiled = null;
  }
  compiledPatternCache.set(pattern, compiled);
  return compiled;
}

/**
 * Returns true when `modelId` matches any of the supplied regex
 * patterns. Empty / undefined inputs return false (no match, do not
 * auto-enable).
 *
 * @param modelId — session's resolved model id, e.g. `openai/gpt-5.4`
 * @param patterns — array of regex pattern strings from the config
 *   under `agents.defaults.planMode.autoEnableFor`
 */
export function evaluateAutoEnableForMatch(
  modelId: string | undefined,
  patterns: ReadonlyArray<string> | undefined,
): boolean {
  if (!modelId || typeof modelId !== "string" || modelId.length === 0) {
    return false;
  }
  if (!patterns || !Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }
  for (const raw of patterns) {
    if (typeof raw !== "string" || raw.length === 0) {
      continue;
    }
    const compiled = compilePattern(raw);
    if (compiled && compiled.test(modelId)) {
      return true;
    }
  }
  return false;
}

/**
 * Test-only: clear the compiled-pattern cache. Production code should
 * never call this; tests that exercise malformed-pattern behavior use
 * it to keep cases independent.
 */
export function __resetCompiledPatternCacheForTests(): void {
  compiledPatternCache.clear();
}
