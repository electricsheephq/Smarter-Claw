/**
 * Vendored reference for `resolvePlanApproval`.
 *
 * Byte-faithful port of the in-host `resolvePlanApproval` at
 * `src/agents/plan-mode/approval.ts` (commit `ea04ea52c7`). The plugin's
 * `src/plan-mode/approval.ts` claims byte-identical parity; this
 * reference exists to detect drift mechanically.
 *
 * The function is pure (apart from `Date.now()`), so the reference is
 * a direct copy of the in-host source. Tests freeze `Date.now()` to a
 * stable value in both the reference and plugin runner so the
 * `updatedAt` / `confirmedAt` fields don't differ for clock reasons.
 *
 * Anti-pattern guardrail: do NOT update this by reading the plugin
 * source. It must come from the in-host. Re-capture by running
 * `git -C /Volumes/LEXAR/repos/openclaw-pr70071-rebase show ea04ea52c7:src/agents/plan-mode/approval.ts`
 * and copy the function verbatim.
 *
 * host_ref: src/agents/plan-mode/approval.ts:36-145 (commit ea04ea52c7)
 */

import type { PlanModeSessionState } from "../../src/types.js";

export function resolvePlanApprovalReference(
  current: PlanModeSessionState,
  action: "approve" | "edit" | "reject" | "timeout",
  feedback?: string,
  expectedApprovalId?: string,
  /**
   * Frozen clock for deterministic test output. Real in-host uses
   * `Date.now()`; we inject a clock so reference and plugin observe the
   * same timestamp and the `updatedAt` / `confirmedAt` fields stay
   * comparable across runners.
   */
  now: number = Date.now(),
): PlanModeSessionState {
  // Stale-event guard.
  if (expectedApprovalId !== undefined) {
    if (current.approvalId === undefined || expectedApprovalId !== current.approvalId) {
      return current;
    }
  }

  // Terminal-state guard. Approved, edited, and timed_out are terminal;
  // rejected stays open for re-approval. None-state blocks Approve/Edit/Reject
  // when no token supplied (the expectedApprovalId branch above handles the
  // tokened case).
  if (current.approval !== "pending" && current.approval !== "rejected") {
    return current;
  }
  if (action === "timeout" && current.approval !== "pending") {
    return current;
  }

  switch (action) {
    case "approve":
      return {
        ...current,
        mode: "normal",
        approval: "approved",
        confirmedAt: now,
        updatedAt: now,
        feedback: undefined,
        rejectionCount: 0,
      };

    case "edit":
      return {
        ...current,
        mode: "normal",
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
