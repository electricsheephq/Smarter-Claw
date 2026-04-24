/**
 * Plan-mode approval state machine.
 *
 * After the agent calls `exit_plan_mode`, the runtime emits a
 * `plan_approval_requested` event. Channel plugins render inline
 * buttons (Approve / Edit / Reject). This module manages the
 * approval lifecycle and resolves the result.
 *
 * ## Rejection UX (Decision 4)
 *
 * On rejection, mode stays "plan" (fail-closed). The agent receives
 * a structured [PLAN_DECISION] injection at the start of its next
 * turn with the user's feedback. The agent revises and calls
 * update_plan again. No hard limit on cycles; after 3 rejections
 * the injection suggests asking the user to clarify their goal.
 *
 * On edit, the user's edits count as approval — mode transitions
 * to "normal" and the agent executes the edited plan.
 *
 * On timeout, mode stays "plan". The agent is told the proposal
 * expired and may re-propose when the user returns.
 */

import type { PlanModeSessionState } from "./types.js";

export interface PlanApprovalConfig {
  /** Seconds before an unanswered approval expires. Default: 600 (10 min). */
  approvalTimeoutSeconds: number;
}

export const DEFAULT_APPROVAL_CONFIG: PlanApprovalConfig = {
  approvalTimeoutSeconds: 600,
};

/**
 * Resolves a plan approval action into the next session state.
 *
 * @param feedback - Optional user feedback on rejection
 * @param expectedApprovalId - Optional version token from the approval event.
 *   If provided and doesn't match `current.approvalId`, the action is ignored
 *   as stale (e.g. user clicks Approve on a plan that was already rejected
 *   and revised on another surface).
 */
export function resolvePlanApproval(
  current: PlanModeSessionState,
  action: "approve" | "edit" | "reject" | "timeout",
  feedback?: string,
  expectedApprovalId?: string,
): PlanModeSessionState {
  const now = Date.now();

  // Stale-event guard: if the caller provided an approvalId, the current
  // state MUST have a matching approvalId. Mismatch — or, importantly,
  // current state having no approvalId at all when one is expected — means
  // the event is stale (e.g. user clicked Approve on a plan that was
  // already approved/rejected and the state moved on). No-op.
  //
  // Earlier draft only no-op'd when both sides had defined IDs and they
  // differed, which left a fail-open: an attacker (or stale UI) could
  // supply expectedApprovalId and have it accepted whenever the current
  // state happened to have a cleared/undefined approvalId.
  if (expectedApprovalId !== undefined) {
    if (current.approvalId === undefined || expectedApprovalId !== current.approvalId) {
      return current;
    }
  }

  // Terminal-state guard. Approved, edited, and timed_out are terminal —
  // they require a fresh exit_plan_mode call (which mints a new approvalId)
  // before any new action can apply. Rejected stays open for re-approval
  // or re-rejection.
  //
  // Also reject when `current.approval === "none"` AND no
  // `expectedApprovalId` was supplied. The "none" state means there is
  // no pending approval to act on — letting Approve/Edit/Reject through
  // here would let an out-of-sequence callback (e.g. a delayed Reject
  // after state reset) flip the session into a terminal state without a
  // real exit_plan_mode call. The `expectedApprovalId` check above
  // already handles the case where the caller has a token (rejected by
  // the approvalId mismatch). This adds a no-token defense.
  if (current.approval !== "pending" && current.approval !== "rejected") {
    return current;
  }
  if (action === "timeout" && current.approval !== "pending") {
    return current;
  }

  switch (action) {
    case "approve":
      // Approve clears feedback AND resets rejectionCount — the user is
      // moving forward, so cycle history is no longer relevant.
      //
      // PR #70071 follow-up (P2.4) — transitions to `mode: "executing"`
      // (was: `mode: "normal"`). The plan was approved and the agent
      // is now executing the steps; the session is no longer in plan
      // design but it's also not "no plan activity at all". This
      // unlocks downstream behavior that depends on knowing the
      // session is mid-execution:
      //   - UI chip rendering accurately reflects "plan is active"
      //     (PR #70071 P2.6)
      //   - execution-phase nudge crons (PR #70071 P2.9) can fire
      //     during stalls
      //   - `plan_mode_status` introspection reports the precise
      //     state (PR #70071 P2.8)
      //   - `[PLAN_STATUS]` per-turn preamble auto-injection
      //     (PR #70071 P2.12b)
      //
      // The close-on-complete detector (snapshot-persister.ts
      // `shouldAutoClosePlan`) continues to fire the
      // executing → "normal" transition when all steps are
      // completed/cancelled. Lifecycle: plan → executing →
      // (close-on-complete) → normal. Mutation gate is unaffected
      // by the new value (executing passes through like normal —
      // mutations are allowed once the plan is approved).
      return {
        ...current,
        mode: "executing",
        approval: "approved",
        confirmedAt: now,
        updatedAt: now,
        feedback: undefined,
        rejectionCount: 0,
      };

    case "edit":
      // Edit counts as approval — same reset behavior as approve.
      // Same `mode: "executing"` transition rationale as the approve
      // case above (see comment block there). Distinguished only by
      // `approval: "edited"` (vs "approved") for downstream signals
      // like `postApprovalPermissions.acceptEdits`.
      return {
        ...current,
        mode: "executing",
        approval: "edited",
        confirmedAt: now,
        updatedAt: now,
        feedback: undefined,
        rejectionCount: 0,
      };

    case "reject":
      return {
        ...current,
        mode: "plan",
        approval: "rejected",
        confirmedAt: undefined,
        updatedAt: now,
        feedback: feedback ?? current.feedback,
        rejectionCount: (current.rejectionCount ?? 0) + 1,
      };

    case "timeout":
      return {
        ...current,
        mode: "plan",
        approval: "timed_out",
        confirmedAt: undefined,
        updatedAt: now,
        feedback: undefined,
      };

    default: {
      const _exhaustive: never = action;
      return current;
    }
  }
}

/**
 * Grace window (ms) after a subagent completes during plan mode
 * before exit_plan_mode and sessions.patch approve/edit can fire.
 * Lets completion events propagate and parent announce-turns settle.
 * Tuned conservatively: log-forensics shows most event-propagation
 * lag is < 2s; 10s gives 5x headroom with minimal user-visible
 * friction.
 */
export const SUBAGENT_SETTLE_GRACE_MS = 10_000;

/**
 * Maximum concurrent subagents allowed during plan mode. Prevents
 * spawn-stacking during plan investigation which would multiply the
 * race-window surface at exit_plan_mode time.
 */
export const MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE = 1;

/**
 * Builds the context injection for an approved plan.
 * Tells the agent to execute the approved plan without re-planning.
 *
 * Prefixed with the canonical one-line tag `[PLAN_DECISION]: approved`
 * so downstream tooling (chat renderers that hide synthetic markers,
 * debug log filters) match uniformly with the reject / timed_out /
 * question_answer / complete variants.
 */
export function buildApprovedPlanInjection(planSteps: string[]): string {
  const stepList = planSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  // PR #70071 follow-up — "check and record status per step" instructions
  // (issue #51, openclaw-1 commit 37ac8983e6). Without these instructions
  // the agent does the work but forgets to call update_plan, leaving the
  // plan stuck in mid-execution forever (Eva's MiniMax/David VM session
  // log + Baoyu flyer skills failure mode). The instructions are a SOFT
  // STEER (the agent can still skip update_plan); the close-on-complete
  // detector in snapshot-persister is the semantic gate that auto-
  // transitions when all steps are recorded done. But reinforcing the
  // instruction in the approval text closes the common-case stall where
  // the agent finishes sub-operations and goes idle without recording
  // state.
  return (
    "[PLAN_DECISION]: approved\n\n" +
    "The user has approved the following plan. Execute it now without re-planning. " +
    "Check and record the status for each step as you go. After each step " +
    "finishes (successful or not), call `update_plan` to mark that step as " +
    'done. The plan is not done until every step is recorded as completed ' +
    "or cancelled. If a step is no longer viable, mark it cancelled and " +
    "add a revised step.\n\n" +
    "The approved plan:\n\n" +
    stepList
  );
}

/**
 * Builds the context injection for a plan approved with the
 * acceptEdits permission. Mirrors Claude Code's `acceptEdits` mode —
 * the user is granting the AGENT permission to self-modify the plan
 * during execution when ≥95% confident, NOT claiming to have edited
 * the plan themselves (there is no user-side plan editor today; the
 * webchat affordance simply surfaces this permission mode).
 *
 * Three hard constraints override acceptEdits regardless of confidence
 * level:
 *   1. No destructive actions (delete db, delete files, truncate, etc.)
 *   2. No self-restart (gateway restart, kill the running process)
 *   3. No configuration changes (openclaw config set, ~/.openclaw/*)
 *
 * Prompt teaches the rule; a runtime constraint gate (in
 * `accept-edits-gate.ts`) enforces the rule in code. Both layers
 * required.
 */
export function buildAcceptEditsPlanInjection(planSteps: string[]): string {
  const stepList = planSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return (
    "[PLAN_DECISION]: edited\n\n" +
    "The user has approved the following plan with acceptEdits permission. " +
    "Execute it now. You may self-modify the plan via update_plan during " +
    "execution when you are ≥95% confident that:\n" +
    "  - A step needs to be added to reach the goal, OR\n" +
    "  - A step is no longer necessary (mark it cancelled), OR\n" +
    "  - The plan needs to pivot based on new information.\n\n" +
    "Before modifying the plan, briefly state:\n" +
    "  1. What you're changing\n" +
    "  2. Your confidence level (must be ≥95%)\n" +
    "  3. The evidence justifying the change\n\n" +
    "If confidence is <95%, ask the user instead of modifying.\n\n" +
    "Hard constraints (OVERRIDE acceptEdits — require explicit user confirmation):\n" +
    "  - No destructive actions (rm, rmdir, DROP TABLE, DELETE FROM, truncate, " +
    "overwrites of protected files)\n" +
    "  - No self-restart (openclaw gateway restart, launchctl kickstart, " +
    "kill the gateway process)\n" +
    "  - No configuration changes (openclaw config set, writes to " +
    "~/.openclaw/config.toml or ~/.claude/config)\n\n" +
    "The approved plan:\n\n" +
    stepList
  );
}
