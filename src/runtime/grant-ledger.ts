/**
 * Approval grant ledger — in-memory correlation map of
 * (approvalId, approvalRunId, sessionKey) for the lifetime of an
 * approval cycle.
 *
 * # Why
 *
 * Plan-mode events propagate across many touch points (tool calls,
 * gates, injections, UI toasts). Operators tracing a single approval
 * cycle through the debug log need a stable correlation key. The host
 * runtime provides `approvalRunId` (agent run that minted the plan)
 * and `approvalId` (the version token); the ledger keeps them
 * together so we can look up either-by-the-other.
 *
 * # In-host equivalent
 *
 * In-host, the approvalRunId/approvalId pair lives on the session
 * row itself (`planMode.approvalRunId` + `planMode.approvalId`). The
 * plugin port has the same fields on PlanModeSessionState — but the
 * ledger gives us a CHEAP lookup by approvalId-only (without going
 * through the gateway lock). Useful in hot paths like debug-log emit
 * where the caller has an approvalId from a synthetic injection
 * idempotency-key and wants to enrich the event with approvalRunId.
 *
 * # Lifetime
 *
 * Entries are added on exit_plan_mode persist (approvalId is the
 * candidate from newPlanApprovalId, approvalRunId is the agent's
 * runId at that moment). Entries are pruned when:
 *   - The approval resolves (approve/edit/reject) — explicit prune
 *   - TTL expires (default 1h) — defensive sweep on get
 *
 * # No persistence
 *
 * Process-local. Plugin restart resets the ledger; the canonical
 * data still lives on the session row. P-final may add a persistent
 * grant-ledger backed by the session-extension if needed for
 * cross-restart debugging.
 *
 * host_ref: src/agents/plan-mode/plan-mode-debug-log.ts:46-62
 *   (C7 correlation-field design notes)
 */

export interface GrantLedgerEntry {
  approvalId: string;
  approvalRunId?: string;
  sessionKey: string;
  recordedAt: number;
}

export interface GrantLedgerOptions {
  /**
   * TTL for ledger entries. Defaults to 1 hour. Entries older than
   * this are pruned on `get()` (lazy sweep).
   */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class GrantLedger {
  private entries = new Map<string, GrantLedgerEntry>();
  private readonly ttlMs: number;

  constructor(options: GrantLedgerOptions = {}) {
    this.ttlMs =
      options.ttlMs !== undefined && options.ttlMs > 0
        ? options.ttlMs
        : DEFAULT_TTL_MS;
  }

  /**
   * Record a grant. Called from exit_plan_mode persist path. Existing
   * entry for the same approvalId is overwritten (the new entry has
   * the freshest correlation data).
   */
  record(input: {
    approvalId: string;
    approvalRunId?: string;
    sessionKey: string;
  }): GrantLedgerEntry {
    const entry: GrantLedgerEntry = {
      approvalId: input.approvalId,
      ...(input.approvalRunId !== undefined
        ? { approvalRunId: input.approvalRunId }
        : {}),
      sessionKey: input.sessionKey,
      recordedAt: Date.now(),
    };
    this.entries.set(input.approvalId, entry);
    return entry;
  }

  /**
   * Look up a grant by approvalId. Returns undefined when absent or
   * the entry has expired (with lazy delete on expiry).
   */
  get(approvalId: string): GrantLedgerEntry | undefined {
    const entry = this.entries.get(approvalId);
    if (!entry) return undefined;
    if (Date.now() - entry.recordedAt > this.ttlMs) {
      this.entries.delete(approvalId);
      return undefined;
    }
    return entry;
  }

  /**
   * Explicit prune — called when an approval resolves
   * (approve/edit/reject) so the ledger doesn't grow indefinitely.
   */
  prune(approvalId: string): boolean {
    return this.entries.delete(approvalId);
  }

  /**
   * Diagnostic — current size. Test-only convenience.
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Diagnostic — list of recorded approvalIds. Test-only.
   */
  approvalIds(): readonly string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Sweep all expired entries. Optional manual GC; the lazy delete
   * in `get()` typically suffices.
   */
  sweepExpired(now: number = Date.now()): number {
    let pruned = 0;
    for (const [id, entry] of this.entries) {
      if (now - entry.recordedAt > this.ttlMs) {
        this.entries.delete(id);
        pruned += 1;
      }
    }
    return pruned;
  }
}
