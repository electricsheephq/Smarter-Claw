/**
 * Plan-mode system-prompt injection composer.
 *
 * **Parity reference**: the in-host injects an inline block at
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-runner/run/attempt.ts:702-732`
 * (commit `ea04ea52c7`). That block has FOUR parts:
 *   1. PLAN_MODE_ACTIVE header
 *   2. Hard rules ("Mutating tools are BLOCKED... etc.")
 *   3. PLAN_ARCHETYPE_PROMPT (PR-10 quality steering — ported here at P-7)
 *   4. PLAN_MODE_REFERENCE_CARD (state diagram + tool contract +
 *      tag taxonomy — P-8 ports this companion)
 *
 * P-7 ships parts 1, 2, 3. P-8 adds part 4 + the
 * `composePromptWithPendingInjections` queue drain.
 */

import { PLAN_ARCHETYPE_PROMPT } from "./archetype-prompt.js";

const PLAN_MODE_HEADER = "═══ PLAN MODE ACTIVE ═══";

const PLAN_MODE_HARD_RULES = [
  "Hard rules:",
  "- Mutating tools (write, edit, exec/bash with side-effects, apply_patch) are BLOCKED by the runtime — calling them wastes a turn.",
  "- Do NOT write the plan as a markdown list in chat — it MUST go through exit_plan_mode so the user gets Accept/Edit/Reject buttons.",
  "- Do NOT call enter_plan_mode (you're already in plan mode — it's a no-op).",
  "- After `exit_plan_mode` in this turn: STOP. Do not emit any further chat text. The next turn (after user approval) delivers `[PLAN_DECISION]: approved` and you can resume execution then. Trailing chat poisons the approval card lifecycle.",
].join("\n");

const PLAN_MODE_SEPARATOR = "═════════════════════════";

/**
 * Build the system-prompt addition for an active plan-mode session.
 *
 * The output bytes are part of the prompt-cache key (cache hits depend
 * on byte-identical prefix matches). Tests pin this.
 *
 * host_ref: src/agents/pi-embedded-runner/run/attempt.ts:702-732 — the
 *   in-host inline block. Lines 1 (header), 3-7 (hard rules),
 *   13 (PLAN_ARCHETYPE_PROMPT). The reference-card append is P-8 scope.
 */
export function buildPlanModeSystemContext(): string {
  return [
    PLAN_MODE_HEADER,
    "",
    PLAN_MODE_HARD_RULES,
    "",
    PLAN_MODE_SEPARATOR,
    "",
    PLAN_ARCHETYPE_PROMPT,
  ].join("\n");
}

/**
 * For tests + parity-harness: expose the building blocks so assertions
 * can pin individual sections without re-deriving.
 */
export const _testing = {
  PLAN_MODE_HEADER,
  PLAN_MODE_HARD_RULES,
  PLAN_MODE_SEPARATOR,
};
