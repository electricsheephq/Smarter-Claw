/**
 * before_prompt_build hook handler — drains the pending-injection queue
 * into the system context AND clears the drained entries from session
 * state, all under the host's session-store lock.
 *
 * The drain happens via `consumePendingAgentInjections`, the clear via
 * `persistSmarterClawState`. Drained entries are JOINED with double
 * newlines and appended to the system context (via the same
 * `appendSystemContext` cacheable surface the archetype hook uses).
 *
 * Why appendSystemContext (not a synthetic user message): the plugin
 * SDK doesn't have a "prepend message to next turn" hook today —
 * `before_message_write` is for INTERCEPTING messages, not injecting.
 * The system-context route reaches the model the same way the archetype
 * prompt does. Trade-off: appears to the agent as system context
 * (which it then sees on the same turn the user's message arrives) so
 * `[PLAN_DECISION]: approved` lands as part of the system prologue,
 * not a separate user turn. In practice the model treats these the same.
 *
 * Idempotency: persistSmarterClawState writes the cleared queue back
 * BEFORE the drain returns (via the same updateSessionStoreEntry lock).
 * If the prompt build crashes after the clear but before delivery, the
 * injection is lost — we accept this trade-off because the alternative
 * (deliver-then-clear) risks duplicate delivery on retry, which is
 * worse for state-machine coherence.
 */

import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { persistSmarterClawState, readSmarterClawState } from "../runtime-api.js";
import { logPlanModeDebug } from "./debug-log.js";
import { consumePendingAgentInjections } from "./injections.js";

export type InjectionDrainContext = {
  agentId?: string;
  sessionKey?: string;
};

/**
 * Build the before_prompt_build payload for the in-flight turn's
 * pending-injection drain. Returns `{ appendSystemContext }` when there
 * are pending injections, otherwise undefined (no system-prompt
 * mutation).
 *
 * Side effect: clears the drained queue from session state via
 * persistSmarterClawState. Failures to clear are logged but don't
 * suppress delivery (the queue keeps the entries, so a future drain
 * will redeliver — preferring duplicate delivery over silent loss).
 */
export async function buildInjectionDrainResult(
  ctx: InjectionDrainContext,
): Promise<{ appendSystemContext: string } | undefined> {
  const sessionKey = ctx.sessionKey;
  const agentId = ctx.agentId;
  if (!sessionKey || !agentId) {
    return undefined;
  }
  let storePath: string;
  try {
    storePath = resolveStorePath(agentId);
  } catch {
    return undefined;
  }
  let entry: ReturnType<typeof resolveSessionStoreEntry>["existing"];
  try {
    const store = loadSessionStore(storePath, { skipCache: true });
    entry = resolveSessionStoreEntry({ store: store ?? {}, sessionKey }).existing;
  } catch {
    return undefined;
  }
  const planState = entry ? readSmarterClawState(entry) : undefined;
  if (!planState?.pendingAgentInjections || planState.pendingAgentInjections.length === 0) {
    return undefined;
  }

  // Drain via the pure helper. Filters expired entries, sorts by
  // priority, returns the composedText preamble.
  const drained = consumePendingAgentInjections({
    pendingAgentInjections: planState.pendingAgentInjections,
  });
  if (drained.injections.length === 0 || !drained.composedText) {
    return undefined;
  }

  // Persist the cleared queue. Done BEFORE returning the
  // appendSystemContext so a same-turn host crash doesn't redeliver
  // the injections on the next attempt. The persist failure case
  // (installer not run, etc) keeps the queue intact AND we still
  // deliver — duplicate delivery is preferred over silent loss.
  const persist = await persistSmarterClawState({
    agentId,
    sessionKey,
    update: (current) => (current ? { ...current, pendingAgentInjections: [] } : undefined),
  });

  logPlanModeDebug({
    kind: "tool_call",
    sessionKey,
    tool: persist.persisted
      ? `before_prompt_build:drained:${drained.injections.length}`
      : `before_prompt_build:drained-but-clear-failed:${drained.injections.length}`,
    details: persist.persisted ? undefined : { reason: persist.reason },
  });

  return { appendSystemContext: drained.composedText };
}
