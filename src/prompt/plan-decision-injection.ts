/**
 * Plan-decision injection builder.
 *
 * **Parity contract**: byte-identical port of the in-host
 * `buildPlanDecisionInjection` at
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/plan-mode/types.ts:172-209`
 * (commit `ea04ea52c7`, iter-3 D5 fix for one-line tag format).
 *
 * # The [PLAN_DECISION]: tag format
 *
 * One-line opener: `[PLAN_DECISION]: <decision>`, then optional
 * lines:
 *   - `feedback: <JSON-quoted sanitized text>` (on reject)
 *   - Deescalation hint at rejectionCount ≥ 3 (on reject)
 *   - Resume guidance (on timed_out)
 *
 * The one-line format is uniform across approved/rejected/timed_out
 * so a future regex (e.g. "hide PLAN_* tags in user-visible chat")
 * matches all variants.
 *
 * # Why this matters
 *
 * The decision injection is the SYNTHETIC message the host's runtime
 * queues into pendingAgentInjections on user resolution. The agent
 * sees it at the start of the next turn and acts on it. Wording is
 * the contract — paraphrases regress agent behavior.
 */

import { sanitizeFeedbackForInjection } from "../helpers/sanitize.js";

/**
 * Build a `[PLAN_DECISION]:` injection for the agent's next turn.
 *
 * @param decision — one of "rejected" | "expired" | "timed_out".
 *   The "expired" alias is accepted for backward-compat with legacy
 *   callers; "timed_out" is canonical and aligns with
 *   PlanApprovalState.
 * @param feedback — user-supplied rejection feedback (will be
 *   sanitized + JSON-quoted before injection).
 * @param rejectionCount — total rejections in this session. At ≥3 we
 *   add a deescalation hint suggesting the agent ask for clarification
 *   instead of re-proposing.
 *
 * host_ref: src/agents/plan-mode/types.ts:172-209 — byte-identical
 *   port of the in-host buildPlanDecisionInjection.
 */
export function buildPlanDecisionInjection(
  decision: "rejected" | "expired" | "timed_out",
  feedback?: string,
  rejectionCount?: number,
): string {
  const lines: string[] = [`[PLAN_DECISION]: ${decision}`];
  if (feedback) {
    lines.push(
      `feedback: ${JSON.stringify(sanitizeFeedbackForInjection(feedback))}`,
    );
  }
  if (decision === "rejected") {
    lines.push(
      "Revise your plan based on the feedback and call update_plan again.",
    );
    if (rejectionCount && rejectionCount >= 3) {
      lines.push(
        "Multiple revisions have been rejected. Consider asking the user to clarify their goal before proposing another plan.",
      );
    }
  } else if (decision === "expired" || decision === "timed_out") {
    lines.push(
      "Your plan proposal timed out. The user has not responded. You remain in plan mode. You may re-propose when the user returns.",
    );
  }
  return lines.join("\n");
}

/**
 * Build a `[PLAN_DECISION]: approved` injection. The approved-plan
 * preamble is separate so it can be paired with the
 * `buildApprovedPlanInjection` (P-11 will port that companion that
 * lists steps + the "mark cancelled if blocked" instruction).
 *
 * For P-11 scope we ship the one-line opener only; the full approved
 * preamble lands when the session-action handler at P-12 needs it.
 *
 * host_ref: src/agents/plan-mode/types.ts (the approve path of
 *   buildPlanDecisionInjection's siblings; full
 *   buildApprovedPlanInjection lives at approval.ts:195-244).
 */
export function buildPlanApprovedDecisionLine(): string {
  return "[PLAN_DECISION]: approved";
}

/**
 * Build an `[PLAN_DECISION]: edited` opener for the edited-on-approve
 * path. Same shape as approved but UI may render edits differently.
 */
export function buildPlanEditedDecisionLine(): string {
  return "[PLAN_DECISION]: edited";
}
