/**
 * W1-B4 — accept-edits gate TRIGGER-predicate test.
 *
 * # What this pins
 *
 * The accept-edits gate (`checkAcceptEditsConstraint`, layer 2 of the
 * `before_tool_call` hook in `src/index.ts`) is fail-OPEN and only
 * gates the 3 hard-constraint categories. WHETHER it runs at all is
 * decided by the trigger predicate:
 *
 *   const isAcceptEditsPhase = approval === "edited";
 *   if (!isAcceptEditsPhase) return undefined;
 *
 * That predicate is the contract: PR #90 changed it from the prior
 * over-firing `autoApprove === true || approval === "edited"` to the
 * in-host-parity `approval === "edited"` alone. In-host, only an
 * EDIT-approval sets `postApprovalPermissions.acceptEdits = true`; a
 * plain APPROVE explicitly CLEARS it (verbatim execution — the user
 * did not opt into edits). See `sessions-patch.ts:982-993`.
 *
 * The full 72-case adversarial corpus for the gate's pure function is
 * in `tests/gates/accept-edits-gate.test.ts`, and `smoke-4` exercises
 * the WIRED hook for the `edited` state. But nothing in CI pinned the
 * PREDICATE itself across approval states — in particular the
 * `approved` negative case (smoke-4's "does NOT fire" test uses a
 * fresh `none`-state session, not an `approved` one). A refactor that
 * re-broadened the predicate — re-introducing the exact bug PR #90
 * fixed — would ship green. This file closes that gap.
 *
 * host_ref: trigger semantics — `sessions-patch.ts:982-993`
 *   (acceptEdits is set by `action === "edit"`, explicitly cleared by
 *    `action === "approve"`).
 * host_ref: in-host trigger site —
 *   `pi-tools.before-tool-call.ts:324`
 *   (`latestPlanMode === "normal" && getLatestAcceptEdits?.()`).
 *
 * # Layer interaction (why some states are tested via the mutation gate)
 *
 * The accept-edits predicate is layer 2 and is only REACHED when
 * `mode === "normal"`. Layer 1 (the plan-mode mutation gate) handles
 * `mode === "plan"` and returns before layer 2. So the plan-mode
 * approval states (`pending`, `rejected`, `none`) can never reach the
 * `isAcceptEditsPhase` check at all — for those, this test asserts a
 * destructive tool is intercepted by the MUTATION gate (a distinct,
 * log-distinguishable code path), which proves the accept-edits
 * trigger is not what fired. The two normal-mode states — `edited`
 * (gate fires) and `approved` (gate must NOT fire) — are the direct
 * predicate test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "../eva-live-smokes/harness.js";

const SESSION_KEY = "agent:main:main";

interface ToolFactory {
  (ctx: { sessionKey?: string }): {
    execute: (
      callId: string,
      args: unknown,
    ) => Promise<{ details: { status?: string; approvalId?: string } }>;
  };
}

type Harness = ReturnType<typeof createHarness>;

/** Drive a fresh session to `mode: "plan", approval: "pending"`. */
async function driveToPending(harness: Harness): Promise<string> {
  const enter = harness.findTool("enter_plan_mode") as ToolFactory;
  await enter({ sessionKey: SESSION_KEY }).execute("enter-1", {});
  const exit = harness.findTool("exit_plan_mode") as ToolFactory;
  const exitResult = await exit({ sessionKey: SESSION_KEY }).execute("exit-1", {
    title: "Trigger-predicate setup",
    plan: [{ step: "do the work", status: "pending" }],
  });
  const approvalId = exitResult.details.approvalId;
  if (!approvalId) {
    throw new Error(
      `exit_plan_mode produced no approvalId: ${JSON.stringify(exitResult)}`,
    );
  }
  return approvalId;
}

/**
 * Fire a destructive Bash command through the WIRED before_tool_call
 * hook and return the hook's decision plus the captured log lines —
 * the log lines let us tell WHICH gate (mutation vs accept-edits)
 * fired.
 */
async function triggerDestructive(harness: Harness): Promise<{
  decision: { block?: boolean; blockReason?: string } | undefined;
  loggedAcceptEdits: boolean;
  loggedMutationGate: boolean;
}> {
  const ret = await harness.triggerHook(
    "before_tool_call",
    { toolName: "Bash", params: { command: "rm -rf /important/data" } },
    { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
  );
  const decision = ret[0] as
    | { block?: boolean; blockReason?: string }
    | undefined;
  return {
    decision,
    loggedAcceptEdits: harness.captures.loggerInfo.some((m) =>
      /accept-edits gate blocked/.test(m),
    ),
    loggedMutationGate: harness.captures.loggerInfo.some((m) =>
      /mutation gate blocked/.test(m),
    ),
  };
}

describe("W1-B4 — accept-edits trigger predicate (approval === 'edited')", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness({ forceInMemory: true });
  });

  afterEach(() => {
    delete process.env.SMARTER_CLAW_USE_INMEMORY;
  });

  describe("FIRES when approval === 'edited'", () => {
    it("blocks a destructive command after an EDIT-approval", async () => {
      const approvalId = await driveToPending(harness);
      const edit = (await harness.invokeAction("plan.edit", {
        sessionKey: SESSION_KEY,
        payload: { approvalId, body: "Edited plan body" },
      })) as { ok: boolean; result?: { approval?: string } };
      expect(edit.ok).toBe(true);
      // Sanity: the edit-approval put the session in approval="edited".
      expect(edit.result?.approval).toBe("edited");

      const { decision, loggedAcceptEdits } =
        await triggerDestructive(harness);
      // The trigger predicate fired → the accept-edits gate evaluated
      // the command → destructive command blocked.
      expect(decision?.block).toBe(true);
      expect(decision?.blockReason).toMatch(/destructive/i);
      expect(loggedAcceptEdits).toBe(true);
    });
  });

  describe("does NOT fire for any other approval state", () => {
    it("approval === 'approved' (plain Accept): destructive command PASSES — gate skipped", async () => {
      // This is the load-bearing negative case + the exact PR #90
      // regression: a plain Accept must NOT grant acceptEdits, so the
      // gate must NOT fire. Session ends in mode="normal" so layer 1
      // is also skipped — the command passes through the plugin
      // entirely (fail-OPEN). If a refactor re-broadened the predicate
      // to include `approved`, this destructive command would be
      // blocked and this test would fail.
      const approvalId = await driveToPending(harness);
      const accept = (await harness.invokeAction("plan.accept", {
        sessionKey: SESSION_KEY,
        payload: { approvalId },
      })) as { ok: boolean; result?: { approval?: string } };
      expect(accept.ok).toBe(true);
      expect(accept.result?.approval).toBe("approved");

      const { decision, loggedAcceptEdits } =
        await triggerDestructive(harness);
      expect(decision).toBeUndefined();
      expect(loggedAcceptEdits).toBe(false);
    });

    it("approval === 'none' (fresh session, normal mode): gate skipped", async () => {
      // Brand-new session: mode="normal", approval defaults to "none".
      // isAcceptEditsPhase is false → layer 2 returns undefined.
      const { decision, loggedAcceptEdits } =
        await triggerDestructive(harness);
      expect(decision).toBeUndefined();
      expect(loggedAcceptEdits).toBe(false);
    });

    it("approval === 'pending' (mode plan): mutation gate fires, NOT the accept-edits trigger", async () => {
      // A pending plan keeps mode="plan", so layer 1 (the mutation
      // gate) intercepts and returns before layer 2's
      // isAcceptEditsPhase check is ever evaluated. The block here is
      // the MUTATION gate's, distinguishable by its log line.
      await driveToPending(harness);
      const { decision, loggedAcceptEdits, loggedMutationGate } =
        await triggerDestructive(harness);
      expect(decision?.block).toBe(true);
      expect(loggedMutationGate).toBe(true);
      // The accept-edits trigger never ran — it is unreachable in plan
      // mode.
      expect(loggedAcceptEdits).toBe(false);
    });

    it("approval === 'rejected' (mode plan): mutation gate fires, NOT the accept-edits trigger", async () => {
      // A rejected plan also keeps mode="plan" (fail-closed: the agent
      // stays in plan mode and revises). Same as pending — layer 1
      // intercepts; the accept-edits trigger is never reached.
      const approvalId = await driveToPending(harness);
      const reject = (await harness.invokeAction("plan.reject", {
        sessionKey: SESSION_KEY,
        payload: { approvalId, feedback: "too risky" },
      })) as { ok: boolean; result?: { approval?: string } };
      expect(reject.ok).toBe(true);
      expect(reject.result?.approval).toBe("rejected");

      const { decision, loggedAcceptEdits, loggedMutationGate } =
        await triggerDestructive(harness);
      expect(decision?.block).toBe(true);
      expect(loggedMutationGate).toBe(true);
      expect(loggedAcceptEdits).toBe(false);
    });
  });

  describe("predicate is exact — only the literal 'edited' state arms the gate", () => {
    it("an EDIT-approved session blocks; an ACCEPT-approved session does not (same destructive input)", async () => {
      // Two sessions, identical destructive command, differing ONLY in
      // approve-vs-edit. The divergence proves the predicate keys on
      // the approval STATE, not on "post-approval" generally.
      const editApproval = await driveToPending(harness);
      await harness.invokeAction("plan.edit", {
        sessionKey: SESSION_KEY,
        payload: { approvalId: editApproval, body: "Edited body" },
      });
      const edited = await triggerDestructive(harness);
      expect(edited.decision?.block).toBe(true);

      // Fresh, fully independent harness for the accept branch.
      const acceptHarness = createHarness({ forceInMemory: true });
      const acceptApproval = await driveToPending(acceptHarness);
      await acceptHarness.invokeAction("plan.accept", {
        sessionKey: SESSION_KEY,
        payload: { approvalId: acceptApproval },
      });
      const accepted = await triggerDestructive(acceptHarness);
      expect(accepted.decision).toBeUndefined();
    });
  });
});
