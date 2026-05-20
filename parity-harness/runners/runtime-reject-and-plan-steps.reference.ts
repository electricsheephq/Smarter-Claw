/**
 * Vendored references for the runtime reject-injection builder + the
 * `planSteps → injection lines` mapper. Both are pure functions ported
 * inline from the in-host source-of-truth at commit `ea04ea52c7`.
 *
 * # buildPlanRuntimeRejectInjection
 *
 * From `src/gateway/sessions-patch.ts:1045-1050` (the live runtime reject
 * emit site). Wave-1 finding W1-D1 — earlier the plugin wired
 * `buildPlanDecisionInjection` as the reject emitter which produced
 * extra instruction lines + JSON-quoted feedback + a different sanitizer.
 * The runtime form is much thinner:
 *
 *   - 1 line if no feedback: `[PLAN_DECISION]: rejected`
 *   - 2 lines if feedback:   `[PLAN_DECISION]: rejected\nfeedback: <raw, mention-stripped>`
 *
 * Sanitization (from sessions-patch.ts:1045-1047):
 *   1. `@(channel|here|everyone)\b` → `@﹫$1`
 *   2. `<@` → `<​@`
 *
 * # planStepsToInjectionLines
 *
 * From `src/gateway/sessions-patch.ts:1001-1003`. Maps a step's
 * `activeForm` (or fallback to the bare `step`) into the per-line
 * injection text. Wave-1 finding W1-D2 — earlier the plugin appended
 * `status` enum instead of `activeForm`, surfacing the wrong label on
 * resumed/re-approved plans.
 *
 * host_ref:
 *   - sessions-patch.ts:1045-1050 (reject form)
 *   - sessions-patch.ts:1001-1003 (planSteps → lines)
 */

import type { PlanStep } from "../../src/types.js";

/**
 * In-host runtime reject sanitizer. Byte-faithful port of the inline
 * sanitization at sessions-patch.ts:1045-1047 — the chained `.replace`
 * calls applied to `feedback ?? ""`.
 */
function sanitizeRuntimeRejectFeedbackReference(raw: string): string {
  return raw
    .replace(/@(channel|here|everyone)\b/gi, "@\u{FE6B}$1")
    .replace(/<@/g, "<\u{200B}@");
}

/**
 * Build the in-host runtime reject injection text. At most 2 lines.
 *
 * host_ref: src/gateway/sessions-patch.ts:1048-1050 (commit ea04ea52c7)
 */
export function buildPlanRuntimeRejectInjectionReference(
  feedback?: string,
): string {
  const safeFeedback = sanitizeRuntimeRejectFeedbackReference(feedback ?? "");
  return safeFeedback
    ? `[PLAN_DECISION]: rejected\nfeedback: ${safeFeedback}`
    : `[PLAN_DECISION]: rejected`;
}

/**
 * Map plan steps to injection lines — uses `activeForm` when present,
 * otherwise the bare `step`.
 *
 * host_ref: src/gateway/sessions-patch.ts:1001-1003 (commit ea04ea52c7)
 */
export function planStepsToInjectionLinesReference(
  steps: PlanStep[],
): string[] {
  return steps.map((step) =>
    step.activeForm ? `${step.step} (${step.activeForm})` : step.step,
  );
}
