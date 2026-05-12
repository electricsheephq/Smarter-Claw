/**
 * In-memory PlanModeStateGateway — P-4 placeholder.
 *
 * # Status
 *
 * This is a TRANSIENT IMPLEMENTATION shipped at P-4. State lives in
 * the plugin process; lost on plugin reload, not visible to other
 * clients (UI, channel handlers, etc.). Adequate for local dev +
 * tests + the Eva live-smoke #1 gate at P-5 (mutation gate within a
 * single plugin lifetime).
 *
 * # Replacement at P-6
 *
 * P-6 ships the real gateway backed by the SDK's session-extension
 * write path (whatever the canonical seam turns out to be at v2026.5.10-beta.5
 * — likely `api.sessions.pluginPatch` or `api.runtime.session.*`). The
 * P-6 replacement preserves the same `PlanModeStateGateway` interface
 * so PlanModeStore + tools don't change.
 *
 * # Concurrency
 *
 * Promise-chain lock per sessionKey. Subsequent `withLock` calls queue
 * until the prior callback resolves. Mirrors the in-host
 * `updateSessionStoreEntry` lock-acquire-then-read semantics.
 *
 * # Diagnostics
 *
 * `seed()` for test setup. `peek()` for non-locking reads (test
 * assertions only — production code uses `PlanModeStore.readSnapshot`).
 * `writeCount` for asserting "no-write paths" (Invariant 3 reuse).
 */

import type { PlanModeStateGateway } from "./store.js";
import type { PlanModeSessionState } from "../types.js";

export class InMemoryGateway implements PlanModeStateGateway {
  private state = new Map<string, PlanModeSessionState>();
  private locks = new Map<string, Promise<unknown>>();

  /** Diagnostic counter — increments on every successful write. */
  writeCount = 0;

  /**
   * Bypass-lock state seeding. Use in test setup; do NOT call during
   * a `withLock` callback or under concurrent load.
   */
  seed(sessionKey: string, state: PlanModeSessionState): void {
    this.state.set(sessionKey, state);
  }

  /**
   * Non-locking snapshot read. Test-only. Production code reads via
   * `PlanModeStore.readSnapshot` (which DOES route through `withLock`).
   */
  peek(sessionKey: string): PlanModeSessionState | undefined {
    return this.state.get(sessionKey);
  }

  async withLock<TTransition>(
    sessionKey: string,
    update: (
      current: PlanModeSessionState | undefined,
    ) => Promise<{
      next: PlanModeSessionState | null;
      transition?: TTransition;
    }>,
  ): Promise<{ transition?: TTransition }> {
    // Lock acquisition: chain off the prior lock (if any) so calls
    // serialize per-sessionKey.
    const prior = this.locks.get(sessionKey) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      sessionKey,
      prior.then(() => next),
    );
    await prior;

    try {
      // Fresh-read inside the lock. Cloning so callers can't
      // mutate-by-reference.
      const current = this.state.get(sessionKey);
      const freshCopy: PlanModeSessionState | undefined = current
        ? structuredClone(current)
        : undefined;
      const { next: nextState, transition } = await update(freshCopy);
      if (nextState !== null) {
        this.state.set(sessionKey, structuredClone(nextState));
        this.writeCount++;
      }
      return { transition };
    } finally {
      release!();
    }
  }
}
