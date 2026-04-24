/**
 * Pending agent injection queue.
 *
 * Replaces a single-scalar `pendingAgentInjection: string` field with
 * an append-only, priority-ordered, id-dedup'd queue. Fixes the
 * last-write-wins clobber class of bug where a `[QUESTION_ANSWER]` or
 * `[PLAN_COMPLETE]` landing between `/plan accept` and runner consume
 * would silently overwrite the `[PLAN_DECISION]`.
 *
 * ## Semantics
 *
 * - **Append on write**: every writer goes through `upsertIntoQueue` /
 *   `appendToInjectionQueue` which atomically appends to the queue. If
 *   an entry with the same `id` already exists, the entry is upserted
 *   (not duplicated). This lets writers regenerate a stable id from
 *   `approvalId` or session state to guarantee idempotency.
 * - **Priority-ordered drain**: the consumer reads all non-expired
 *   entries, sorts by `priority DESC, createdAt ASC`, clears the queue,
 *   and returns the composed text.
 * - **Once-and-only-once**: clear and read happen inside one
 *   session-store update (single store lock). Best-effort on write
 *   failure — captured entries are still returned so the turn can
 *   inject; the queue will be cleared on the next successful write.
 * - **Bounded queue**: capped at `MAX_QUEUE_SIZE = 10`. Oldest entries
 *   evicted on overflow with a warn log. Correctness doesn't depend on
 *   this — the consumer always drains within a single turn — but the
 *   cap prevents unbounded growth in pathological cases (stuck session,
 *   consumer crash loop).
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ INSTALLER SEAM:                                                 │
 * │                                                                 │
 * │ The DELIVERY of a pending injection (synthesizing a user        │
 * │ message at the start of the agent's next turn) requires hooking │
 * │ the host's prompt-build / next-turn pipeline. The Plugin SDK    │
 * │ does not yet expose a "synthetic-message injection" surface.    │
 * │                                                                 │
 * │ Until it does, the installer-side patch is responsible for:     │
 * │                                                                 │
 * │   1. Reading the queue at the start of each turn via            │
 * │      `consumePendingAgentInjections(state)`.                    │
 * │   2. Calling `composePromptWithPendingInjections(injections,    │
 * │      userPrompt)` to prepend the drained text to whatever the   │
 * │      user said next.                                            │
 * │   3. Persisting the cleared state back via                      │
 * │      `writeSmarterClawState`.                                   │
 * │                                                                 │
 * │ Writers (slash-command dispatcher, snapshot persister, etc.)    │
 * │ enqueue via `appendToInjectionQueue(state, entry)` directly.    │
 * └─────────────────────────────────────────────────────────────────┘
 */

/**
 * Closed-set of injection kinds. Add new kinds here when introducing
 * new synthetic-message classes; the priority lookup below provides
 * default ordering for each.
 */
export type PendingAgentInjectionKind =
  | "plan_decision"
  | "plan_complete"
  | "question_answer"
  | "subagent_return"
  | "plan_intro"
  | "plan_nudge";

/**
 * A single queued injection. Writers always supply `id`, `kind`,
 * `text`, `createdAt`. `priority` and `expiresAt` are optional
 * overrides; ordering defaults are pulled from
 * `DEFAULT_INJECTION_PRIORITY`.
 */
export interface PendingAgentInjectionEntry {
  /**
   * Stable id used for dedup-on-upsert. Writers should derive this
   * from session state (e.g. `plan-decision-${approvalId}`) so a
   * retry of the same write upserts in place rather than appending
   * a duplicate.
   */
  id: string;
  kind: PendingAgentInjectionKind;
  /** The synthetic user-message text to prepend to the next turn. */
  text: string;
  /** Wall-clock createdAt (ms). Used as the secondary sort key. */
  createdAt: number;
  /**
   * Optional priority override. When omitted, the default for `kind`
   * is used. Higher drains first; ties broken by `createdAt`
   * ascending.
   */
  priority?: number;
  /**
   * Optional expiry timestamp (ms). Entries past their expiry are
   * filtered out at drain time without delivering. Use sparingly —
   * the queue normally drains every turn so most entries don't need
   * an expiry.
   */
  expiresAt?: number;
}

/**
 * The injection queue lives on the plugin's session-state slot under
 * `pendingAgentInjections`. We keep the field as a plain array on the
 * `SmarterClawSessionState` shape; this module exports helpers that
 * operate on that array.
 */
export interface InjectionQueueHost {
  pendingAgentInjections?: PendingAgentInjectionEntry[];
}

/**
 * Priority lookup for default ordering. Writers may override on the
 * entry. Higher drains first; ties broken by `createdAt` ascending.
 */
export const DEFAULT_INJECTION_PRIORITY: Record<PendingAgentInjectionKind, number> = {
  plan_decision: 10,
  plan_complete: 9,
  question_answer: 8,
  subagent_return: 5,
  plan_intro: 3,
  plan_nudge: 1,
};

/**
 * Queue size cap. The consumer drains every turn so a well-behaved
 * session should never approach this. Eviction is oldest-first with a
 * warn log so operators can spot a stuck drain loop.
 */
export const MAX_QUEUE_SIZE = 10;

type Log = { warn?: (msg: string) => void; debug?: (msg: string) => void };

function resolveEntryPriority(entry: PendingAgentInjectionEntry): number {
  if (typeof entry.priority === "number") {
    return entry.priority;
  }
  return DEFAULT_INJECTION_PRIORITY[entry.kind] ?? 0;
}

function filterExpired(
  entries: PendingAgentInjectionEntry[],
  now: number,
): PendingAgentInjectionEntry[] {
  return entries.filter((e) => typeof e.expiresAt !== "number" || e.expiresAt > now);
}

/**
 * Kinds where MOST RECENT user feedback matters more than the oldest
 * (e.g. plan_decision: a 12-rejection cycle should deliver the user's
 * latest feedback, not the 8-revision-stale first one). For these
 * kinds we drop OLDEST entries on cap — keeping the most recent
 * MAX_QUEUE_SIZE within the kind. Per BUG #4 from adversarial QA.
 *
 * Other kinds (system messages, plan_intro) keep the historical
 * "drop newest" semantic since priority-based ranking already favors
 * older + higher-priority entries appropriately.
 */
const KEEP_NEWEST_KINDS = new Set<string>(["plan_decision"]);

/**
 * Sorts a queue for drain order and applies the size cap.
 * Pure (no store I/O) so callers can test independently.
 *
 * BUG #4 + #10 fix (Smarter-Claw v0.2.0-beta.2): the cap policy is
 * now KIND-AWARE. Pre-fix `sorted.slice(0, MAX_QUEUE_SIZE)` kept
 * oldest within each priority band — which silently dropped the
 * user's most recent feedback in multi-revision plan_decision
 * cycles. The warn-log text said "dropping oldest" but actually
 * dropped newest entries (anything past index MAX). Now: for kinds
 * in KEEP_NEWEST_KINDS we keep the LAST MAX entries (most recent
 * timestamps); for other kinds we keep the FIRST MAX (oldest, the
 * historical behavior). The warn log now correctly reflects what
 * was dropped per kind.
 */
export function sortAndCapQueue(
  queue: PendingAgentInjectionEntry[],
  log?: Log,
): PendingAgentInjectionEntry[] {
  const sorted = [...queue].sort((a, b) => {
    const pa = resolveEntryPriority(a);
    const pb = resolveEntryPriority(b);
    if (pa !== pb) {
      return pb - pa;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    // Deterministic tiebreaker on id. Without this, two entries sharing
    // priority AND createdAt can swap positions between turns (engine-
    // dependent stable-sort behavior), causing the composed injection
    // text to diverge byte-for-byte across runs and breaking prompt
    // cache stability. localeCompare gives a stable total order over
    // the string ids.
    return a.id.localeCompare(b.id);
  });
  if (sorted.length <= MAX_QUEUE_SIZE) {
    return sorted;
  }
  // Per-kind cap policy: separate by kind, apply directional slice.
  const byKind = new Map<string, PendingAgentInjectionEntry[]>();
  for (const entry of sorted) {
    const arr = byKind.get(entry.kind) ?? [];
    arr.push(entry);
    byKind.set(entry.kind, arr);
  }
  const kept: PendingAgentInjectionEntry[] = [];
  for (const [kind, entries] of byKind) {
    if (entries.length <= MAX_QUEUE_SIZE) {
      kept.push(...entries);
      continue;
    }
    if (KEEP_NEWEST_KINDS.has(kind)) {
      // Keep the LAST MAX (most recent timestamps within priority).
      const dropped = entries.slice(0, entries.length - MAX_QUEUE_SIZE);
      const keptForKind = entries.slice(entries.length - MAX_QUEUE_SIZE);
      for (const d of dropped) {
        log?.warn?.(
          `pending-injection-queue: at cap ${MAX_QUEUE_SIZE} for kind=${kind}, dropping older entry id=${d.id} (keep-newest policy)`,
        );
      }
      kept.push(...keptForKind);
    } else {
      // Keep the FIRST MAX (oldest within priority — historical default).
      const dropped = entries.slice(MAX_QUEUE_SIZE);
      const keptForKind = entries.slice(0, MAX_QUEUE_SIZE);
      for (const d of dropped) {
        log?.warn?.(
          `pending-injection-queue: at cap ${MAX_QUEUE_SIZE} for kind=${kind}, dropping newer entry id=${d.id} (keep-oldest policy)`,
        );
      }
      kept.push(...keptForKind);
    }
  }
  // Re-sort the merged kept set by the same sort key so drain-order
  // is preserved across the per-kind partitioning.
  return kept.sort((a, b) => {
    const pa = resolveEntryPriority(a);
    const pb = resolveEntryPriority(b);
    if (pa !== pb) return pb - pa;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Appends or upserts an entry in the queue. If an entry with the same
 * `id` exists, it is replaced (regardless of position — stable dedup
 * across writer retries).
 *
 * Does NOT sort — ordering is applied at drain time so writers can
 * enqueue cheaply without re-sorting on every call.
 */
export function upsertIntoQueue(
  queue: PendingAgentInjectionEntry[],
  entry: PendingAgentInjectionEntry,
): PendingAgentInjectionEntry[] {
  const existingIdx = queue.findIndex((e) => e.id === entry.id);
  if (existingIdx >= 0) {
    const next = [...queue];
    next[existingIdx] = entry;
    return next;
  }
  return [...queue, entry];
}

/**
 * In-place mutator: appends an entry to a host's injection queue.
 * SYNCHRONOUS — for use inside an existing session-store update
 * callback where the store lock is already held.
 *
 * Mutates `host` in place. Returns nothing; the caller is expected to
 * persist the host object.
 */
export function appendToInjectionQueue(
  host: InjectionQueueHost,
  newEntry: PendingAgentInjectionEntry,
  log?: Log,
): void {
  const current = host.pendingAgentInjections ?? [];
  const next = upsertIntoQueue(current, newEntry);
  const capped = sortAndCapQueue(next, log);
  host.pendingAgentInjections = capped;
}

export interface ConsumePendingAgentInjectionsResult {
  /**
   * Drained entries in delivery order (priority DESC, createdAt ASC).
   * Empty array if nothing was pending.
   */
  injections: PendingAgentInjectionEntry[];
  /**
   * Entries joined with `\n\n` into a single synthetic user-message
   * preamble. `undefined` when the queue was empty (vs. empty string,
   * which would still cause the composer to emit a leading blank).
   */
  composedText: string | undefined;
}

/**
 * Pure read: returns the sorted, expiry-filtered, capped queue plus a
 * composed text. Does NOT mutate the host — the installer-side wiring
 * is responsible for clearing the queue from session state once the
 * drained injections have been handed to the prompt build.
 *
 * The pure-read shape lets the caller decide WHEN to commit the
 * cleared state (typically: inside the same session-store update that
 * builds the next turn's prompt, so clear and read happen under one
 * lock).
 */
export function consumePendingAgentInjections(
  host: InjectionQueueHost,
  log?: Log,
): ConsumePendingAgentInjectionsResult {
  const queue = host.pendingAgentInjections ?? [];
  if (queue.length === 0) {
    return { injections: [], composedText: undefined };
  }
  const now = Date.now();
  const fresh = filterExpired(queue, now);
  const captured = sortAndCapQueue(fresh, log);
  if (captured.length === 0) {
    return { injections: [], composedText: undefined };
  }
  const composedText = captured.map((e) => e.text).join("\n\n");
  return { injections: captured, composedText };
}

/**
 * Composes the agent's next-turn prompt by prepending a list of drained
 * injections to the user's input. Entries are joined with `\n\n`; the
 * combined block is separated from the user prompt by another `\n\n`.
 * If the user prompt is empty or whitespace-only, the injection stands
 * alone (no trailing blanks).
 */
export function composePromptWithPendingInjections(
  injections: readonly PendingAgentInjectionEntry[],
  userPrompt: string,
): string {
  if (injections.length === 0) {
    return userPrompt;
  }
  const preamble = injections.map((e) => e.text).join("\n\n");
  const trimmedUser = userPrompt.trim();
  if (trimmedUser.length === 0) {
    return preamble;
  }
  return `${preamble}\n\n${trimmedUser}`;
}
