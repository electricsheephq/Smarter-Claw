/**
 * Plan-tier model override.
 *
 * When the session is in plan mode + the operator has configured a
 * `planTierModel` (e.g. an Opus-class model for higher-quality plan
 * generation), this hook overrides the model for the duration of the
 * plan-mode turn.
 *
 * host_ref: src/agents/plan-mode/* doesn't have a centralized model-
 *   override file in the source-of-truth; the in-host wires this via
 *   the runtime's tier dispatch (`pi-embedded-runner/run/attempt.ts`).
 *   For the plugin, we implement it as a `before_model_resolve` hook
 *   that reads plan-mode state + operator config.
 *
 * # Requires allowConversationAccess
 *
 * `before_model_resolve` is in the conversation-access hook list
 * (docs/plugins/hooks.md:308-310). Operators who don't set the flag
 * get NO model override — plan-mode still works, just without the
 * higher-tier escalation.
 *
 * # Config contract
 *
 * Operator sets `plugins.entries.smarter-claw.config.planTierModel`
 * (e.g. "anthropic/claude-opus-4-7"). When undefined or empty, the
 * hook returns undefined and the host's default model resolves.
 */

import type { PlanModeStore } from "../state/store.js";

export interface PlanTierModelHookInput {
  store: PlanModeStore;
  /**
   * Resolved plan-tier model string from operator config. Pre-validated
   * by the plugin entry (must be non-empty); plugin entry passes
   * undefined when the operator hasn't configured it.
   */
  planTierModel?: string;
  /**
   * Optional provider override paired with the model. Operators
   * normally provide one or the other (or both).
   */
  planTierProvider?: string;
}

export interface PlanTierModelDecision {
  modelOverride?: string;
  providerOverride?: string;
}

/**
 * Decide whether to override the model for this turn. Returns the
 * SDK's expected before_model_resolve result shape (undefined fields
 * mean "no override").
 *
 * Caller passes the resolved sessionKey + the operator-configured
 * planTierModel. Logic:
 *
 *   1. No sessionKey → no override (defensive)
 *   2. No operator-configured planTierModel → no override
 *   3. Session is NOT in plan mode → no override
 *   4. Else → override to planTierModel
 */
export async function decidePlanTierModel(
  sessionKey: string | undefined,
  input: PlanTierModelHookInput,
): Promise<PlanTierModelDecision | undefined> {
  if (!sessionKey) return undefined;
  if (!input.planTierModel) return undefined;
  const snap = await input.store.readSnapshot(sessionKey);
  if (snap?.mode !== "plan") return undefined;
  return {
    modelOverride: input.planTierModel,
    ...(input.planTierProvider
      ? { providerOverride: input.planTierProvider }
      : {}),
  };
}
