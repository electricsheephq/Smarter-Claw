/**
 * Dedup ledger for tool-result persist events.
 *
 * # Why this exists (BUG #5 — operator-reported, real-agent QA confirmed)
 *
 * `index.ts` registers TWO handlers that each route to
 * `handleToolResultPersist`:
 *   1. `api.on("tool_result_persist")` — the canonical hook
 *   2. `api.on("before_message_write")` — a "belt-and-suspenders fallback"
 *      added because tool_result_persist historically didn't fire for
 *      every plugin-registered tool path in the Pi runtime
 *
 * On openclaw v2026.4.23-beta.5 BOTH fire for every `exit_plan_mode` and
 * `update_plan` tool call. Result: each call writes archetype markdown
 * 3x (once from tool body, twice from duplicate persist hooks),
 * `pluginMetadata` is written twice (race window for BUG #1's slice
 * clobber), and the operator sees `tool_result_persist:received` log
 * lines firing in pairs.
 *
 * # The dedup contract
 *
 * Each event carries a message with an id. We maintain a small in-process
 * Set of recently-seen `(toolName + messageId)` keys with a sliding TTL.
 * Whichever handler fires first claims the key — the loser short-circuits.
 *
 * If the message lacks an id (older host versions or synthetic messages),
 * we fall back to letting the event through (bias toward NOT skipping
 * persists since silent skip is worse than duplicate write).
 *
 * # TTL choice
 *
 * 30 seconds is enough that a "typical tool call → persist → next agent
 * turn" cycle (sub-second) is well within the window, but short enough
 * that an entry from yesterday's same-id message (extremely rare —
 * message ids are random uuids) couldn't accidentally dedup with today's.
 */

type DedupEntry = { key: string; expiresAtMs: number };

/** Soft cap on entries kept (not strict — sweep removes expired first). */
const MAX_ENTRIES = 500;

/** TTL after which an entry is forgotten — see docstring rationale. */
const ENTRY_TTL_MS = 30_000;

const ledger = new Map<string, DedupEntry>();

function sweepExpired(nowMs: number): void {
  // Cheap O(n) walk — n is bounded by MAX_ENTRIES + recent burst. Called
  // on each claim, but only does work when entries are actually expired.
  for (const [key, entry] of ledger) {
    if (entry.expiresAtMs <= nowMs) {
      ledger.delete(key);
    }
  }
}

/**
 * Returns true if the caller should proceed (it claimed the dedup key);
 * false if a previous handler already claimed it (caller should skip).
 *
 * Pass undefined `messageId` to opt out — the call always returns true.
 * This is the safer default when the caller can't construct a stable
 * dedup key (silent skips are worse than duplicate writes).
 */
export function claimToolResultPersist(
  toolName: string | undefined,
  messageId: string | undefined,
): boolean {
  if (!toolName || !messageId) {
    return true;
  }
  const key = `${toolName}::${messageId}`;
  const nowMs = Date.now();
  const existing = ledger.get(key);
  if (existing && existing.expiresAtMs > nowMs) {
    return false;
  }
  if (ledger.size >= MAX_ENTRIES) {
    sweepExpired(nowMs);
    // If still at cap after sweep (edge: 500 active entries within TTL),
    // accept the duplicate rather than evict an in-flight key — duplicate
    // writes are recoverable, lost writes are not.
    if (ledger.size >= MAX_ENTRIES) {
      return true;
    }
  }
  ledger.set(key, { key, expiresAtMs: nowMs + ENTRY_TTL_MS });
  return true;
}

/** Test helper — clear the ledger between test cases. */
export function _resetDedupLedgerForTesting(): void {
  ledger.clear();
}

/** Test helper — inspect ledger size. */
export function _dedupLedgerSizeForTesting(): number {
  return ledger.size;
}
