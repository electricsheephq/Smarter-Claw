/**
 * In-memory PlanModeStateGateway for tests.
 *
 * Encapsulates the lock + fresh-read semantic the production gateway
 * (P-6) will provide via the real SDK seam. Tests exercise the 10
 * invariants against this in-memory impl; P-6 substitutes the real
 * gateway in the plugin entry.
 *
 * Concurrency model: a single in-flight `withLock` per sessionKey.
 * Subsequent calls queue (via a promise chain) until the prior call's
 * update callback resolves. Mirrors the in-host
 * `updateSessionStoreEntry` lock-acquire-then-read semantics.
 */

import type {
  PlanModeStateGateway,
} from "../../src/state/store.js";
import type { PlanModeSessionState } from "../../src/types.js";

export class InMemoryGateway implements PlanModeStateGateway {
  private state = new Map<string, PlanModeSessionState>();
  private locks = new Map<string, Promise<unknown>>();

  /**
   * For tests: seed initial state for a session. Bypasses the lock —
   * use only in test `beforeEach`, not during a `withLock` call.
   */
  seed(sessionKey: string, state: PlanModeSessionState): void {
    this.state.set(sessionKey, state);
  }

  /**
   * For tests: read the current state without locking. Used to assert
   * post-condition expectations.
   */
  peek(sessionKey: string): PlanModeSessionState | undefined {
    return this.state.get(sessionKey);
  }

  /**
   * For tests: count the total number of writes that have happened.
   * Useful for asserting invariant 3 ("reuse path performs NO write").
   */
  writeCount = 0;

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
      // Fresh-read inside the lock (invariant 6). Cloning so callers
      // can't mutate-by-reference.
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
