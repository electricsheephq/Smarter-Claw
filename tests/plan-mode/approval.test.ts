/**
 * Tests for `resolvePlanApproval` — surgical-port companion to
 * `src/plan-mode/approval.ts`.
 *
 * **Parity contract**: verbatim port of the in-host `resolvePlanApproval`
 * tests at `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/approval.test.ts:18-107`
 * (commit ea04ea52c7).
 *
 * The text-builder tests (`buildApprovedPlanInjection`,
 * `buildAcceptEditsPlanInjection`, `buildPlanDecisionInjection`) from the
 * same in-host file are deferred — the plugin's
 * `src/prompt/plan-decision-injection.ts` already covers the rejection
 * text builder; the approve/edit text builders land in surgical PR #3
 * alongside the ACTION CONTRACT block port.
 */

import { describe, expect, it } from "vitest";
import { resolvePlanApproval } from "../../src/plan-mode/approval.js";
import type { PlanModeSessionState } from "../../src/types.js";

const BASE_STATE: PlanModeSessionState = {
  mode: "plan",
  approval: "pending",
  enteredAt: 1000,
  updatedAt: 2000,
  rejectionCount: 0,
};

describe("resolvePlanApproval", () => {
  it("approve transitions to normal mode with approved state", () => {
    const result = resolvePlanApproval(BASE_STATE, "approve");
    expect(result.mode).toBe("normal");
    expect(result.approval).toBe("approved");
    expect(result.confirmedAt).toBeGreaterThan(0);
    expect(result.feedback).toBeUndefined();
  });

  it("edit transitions to normal mode (user edits count as approval)", () => {
    const result = resolvePlanApproval(BASE_STATE, "edit");
    expect(result.mode).toBe("normal");
    expect(result.approval).toBe("edited");
    expect(result.confirmedAt).toBeGreaterThan(0);
  });

  it("reject stays in plan mode and increments rejectionCount", () => {
    const result = resolvePlanApproval(BASE_STATE, "reject", "Combine steps 2 and 3");
    expect(result.mode).toBe("plan");
    expect(result.approval).toBe("rejected");
    expect(result.rejectionCount).toBe(1);
    expect(result.feedback).toBe("Combine steps 2 and 3");
  });

  it("accumulates rejectionCount across multiple rejections", () => {
    let state = BASE_STATE;
    state = resolvePlanApproval(state, "reject", "Too many steps");
    expect(state.rejectionCount).toBe(1);
    state = resolvePlanApproval(state, "reject", "Still too complex");
    expect(state.rejectionCount).toBe(2);
    state = resolvePlanApproval(state, "reject");
    expect(state.rejectionCount).toBe(3);
  });

  it("timeout stays in plan mode with timed_out state", () => {
    const result = resolvePlanApproval(BASE_STATE, "timeout");
    expect(result.mode).toBe("plan");
    expect(result.approval).toBe("timed_out");
  });

  it("ignores stale timeout after approval is already resolved", () => {
    const approved: PlanModeSessionState = {
      ...BASE_STATE,
      approval: "approved",
      mode: "normal",
    };
    const result = resolvePlanApproval(approved, "timeout");
    expect(result.mode).toBe("normal");
    expect(result.approval).toBe("approved");
  });

  it("preserves enteredAt across all transitions", () => {
    for (const action of ["approve", "edit", "reject", "timeout"] as const) {
      const result = resolvePlanApproval(BASE_STATE, action);
      expect(result.enteredAt).toBe(1000);
    }
  });

  it("clears feedback on approval", () => {
    const pending: PlanModeSessionState = {
      ...BASE_STATE,
      approval: "pending",
      feedback: "old feedback",
      rejectionCount: 1,
    };
    const result = resolvePlanApproval(pending, "approve");
    expect(result.feedback).toBeUndefined();
  });

  it("allows transitions from rejected state (user changes mind)", () => {
    const rejected: PlanModeSessionState = {
      ...BASE_STATE,
      approval: "rejected",
      feedback: "old feedback",
    };
    const result = resolvePlanApproval(rejected, "approve");
    expect(result.approval).toBe("approved");
    expect(result.feedback).toBeUndefined();
  });

  it("ignores actions on terminal states (approved, edited, timed_out)", () => {
    const approved: PlanModeSessionState = {
      ...BASE_STATE,
      approval: "approved",
      confirmedAt: 3000,
    };
    const result = resolvePlanApproval(approved, "reject", "too late");
    expect(result.approval).toBe("approved"); // no-op
  });

  // Plugin-port additions: stale-event guard (line 62-66 of approval.ts).
  // The in-host has integration coverage in approval.test.ts via the
  // `expectedApprovalId` param of resolvePlanApproval; the in-host's
  // unit-test file doesn't pin this directly. We pin it here so the
  // plugin's stale-event-guard contract is regression-tested.
  describe("expectedApprovalId stale-event guard (in-host approval.ts:62-66)", () => {
    const APPROVAL_ID = "plan-aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee";
    const STALE_ID = "plan-00000000-0000-4000-9000-000000000000";

    it("no-ops on approve when expectedApprovalId mismatches current", () => {
      const pending: PlanModeSessionState = {
        ...BASE_STATE,
        approval: "pending",
        approvalId: APPROVAL_ID,
      };
      const result = resolvePlanApproval(pending, "approve", undefined, STALE_ID);
      expect(result).toBe(pending); // reference-equal — no-op
    });

    it("no-ops on approve when expectedApprovalId is provided but current.approvalId is undefined", () => {
      const pending: PlanModeSessionState = {
        ...BASE_STATE,
        approval: "pending",
        // approvalId deliberately undefined
      };
      const result = resolvePlanApproval(pending, "approve", undefined, APPROVAL_ID);
      expect(result).toBe(pending);
    });

    it("proceeds when expectedApprovalId matches", () => {
      const pending: PlanModeSessionState = {
        ...BASE_STATE,
        approval: "pending",
        approvalId: APPROVAL_ID,
      };
      const result = resolvePlanApproval(pending, "approve", undefined, APPROVAL_ID);
      expect(result.approval).toBe("approved");
      expect(result).not.toBe(pending); // new state
    });

    it("proceeds when expectedApprovalId is undefined (no token, no check)", () => {
      const pending: PlanModeSessionState = {
        ...BASE_STATE,
        approval: "pending",
        approvalId: APPROVAL_ID,
      };
      const result = resolvePlanApproval(pending, "approve");
      expect(result.approval).toBe("approved");
    });
  });

  // Plugin-port addition: "none" state guard (in-host approval.ts:73-83
  // PR-D review fix Codex P2 #3096560406 / Copilot #3105172000).
  describe("'none' state guard (in-host approval.ts:73-83)", () => {
    it("no-ops on approve when approval is 'none' AND no expectedApprovalId", () => {
      const fresh: PlanModeSessionState = {
        ...BASE_STATE,
        approval: "none", // freshly entered plan mode, no proposal yet
      };
      const result = resolvePlanApproval(fresh, "approve");
      expect(result).toBe(fresh);
    });

    it("no-ops on reject when approval is 'none'", () => {
      const fresh: PlanModeSessionState = {
        ...BASE_STATE,
        approval: "none",
      };
      const result = resolvePlanApproval(fresh, "reject", "fb");
      expect(result).toBe(fresh);
    });
  });
});
