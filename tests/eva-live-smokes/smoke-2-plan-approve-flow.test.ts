/**
 * Eva Live-Smoke #2 — End-to-end plan → approve → execute flow.
 *
 * Scenario:
 *   1. Plugin loads.
 *   2. Agent calls `enter_plan_mode`. State.mode === "plan".
 *   3. Agent investigates (read), then calls `exit_plan_mode` with a
 *      proposed plan. State.approval === "pending". A unique
 *      approvalId is minted.
 *   4. User dispatches `plan.accept` session action with the matching
 *      approvalId.
 *   5. `[PLAN_DECISION]: approved` injection is enqueued for the next
 *      agent turn.
 *   6. State.approval === "approved" (verified indirectly via the
 *      session-action result + a follow-up attempt that hits
 *      no-pending-approval).
 *
 * Originally scheduled as Eva live-smoke #2 after P-8. The SDK-stub
 * harness lets us run the same plumbing assertions in CI.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "./harness.js";

const SESSION_KEY = "agent:main:main";

interface ToolFactory {
  (ctx: { sessionKey?: string }): {
    execute: (
      callId: string,
      args: unknown,
    ) => Promise<{
      details: { status?: string; approvalId?: string; mode?: string };
    }>;
  };
}

describe("Eva live-smoke #2 — full plan-approve-execute (P-8)", () => {
  let harness: ReturnType<typeof createHarness>;
  let enter: ToolFactory;
  let exit: ToolFactory;

  beforeEach(() => {
    harness = createHarness({ forceInMemory: true });
    enter = harness.findTool("enter_plan_mode") as ToolFactory;
    exit = harness.findTool("exit_plan_mode") as ToolFactory;
  });

  afterEach(() => {
    delete process.env.SMARTER_CLAW_USE_INMEMORY;
  });

  it("full happy path: enter → exit (pending) → accept (approved) → injection enqueued", async () => {
    // Step 1: enter plan mode.
    const enterTool = enter({ sessionKey: SESSION_KEY });
    const enterResult = await enterTool.execute("call-1", {});
    expect(enterResult.details.status).toBe("entered");
    expect(enterResult.details.mode).toBe("plan");

    // Step 2: exit_plan_mode with a proposed plan.
    const exitTool = exit({ sessionKey: SESSION_KEY });
    const exitResult = await exitTool.execute("call-2", {
      title: "Bump deps",
      plan: [
        { step: "Update package.json", status: "pending" },
        { step: "Run pnpm install", status: "pending" },
      ],
      summary: "Two-step dep bump.",
    });
    expect(exitResult.details.status).toBe("approval-requested");
    const approvalId = exitResult.details.approvalId;
    expect(typeof approvalId).toBe("string");
    expect(approvalId).toMatch(/^plan-/);

    // Step 3: user dispatches plan.accept.
    const acceptResult = (await harness.invokeAction("plan.accept", {
      sessionKey: SESSION_KEY,
      payload: { approvalId },
    })) as { ok: boolean; result?: Record<string, unknown>; continueAgent?: boolean };
    expect(acceptResult.ok).toBe(true);
    expect(acceptResult.continueAgent).toBe(true);
    expect(acceptResult.result?.approval).toBe("approved");

    // Step 4: injection enqueued.
    expect(harness.captures.enqueuedInjections).toHaveLength(1);
    const inj = harness.captures.enqueuedInjections[0] as {
      sessionKey: string;
      text: string;
      idempotencyKey: string;
      placement: string;
    };
    expect(inj.sessionKey).toBe(SESSION_KEY);
    expect(inj.text).toBe("[PLAN_DECISION]: approved");
    expect(inj.idempotencyKey).toBe(
      `smarter-claw:plan_decision:${approvalId}:approved`,
    );
    expect(inj.placement).toBe("prepend_context");
  });

  it("post-accept the session is no longer in pending-approval (double-accept skipped)", async () => {
    const enterTool = enter({ sessionKey: SESSION_KEY });
    await enterTool.execute("call-1", {});
    const exitTool = exit({ sessionKey: SESSION_KEY });
    const exitResult = await exitTool.execute("call-2", {
      title: "X",
      plan: [{ step: "a", status: "pending" }],
    });
    const approvalId = exitResult.details.approvalId;

    // First accept succeeds — surgical-port (PR-#) brings the plugin into
    // parity with in-host resolvePlanApproval, which transitions mode →
    // "normal" on approve. So a second accept on the same session now
    // hits the session-action layer's NOT_IN_PLAN_MODE check first
    // (session has exited plan mode after the successful approve).
    await harness.invokeAction("plan.accept", {
      sessionKey: SESSION_KEY,
      payload: { approvalId },
    });
    // Second accept should be rejected — session is no longer in plan mode.
    const second = (await harness.invokeAction("plan.accept", {
      sessionKey: SESSION_KEY,
      payload: { approvalId },
    })) as { ok: boolean; code?: string };
    expect(second.ok).toBe(false);
    expect(second.code).toBe("NOT_IN_PLAN_MODE");
  });

  it("STALE_APPROVAL_ID when accept is called with the wrong approvalId", async () => {
    const enterTool = enter({ sessionKey: SESSION_KEY });
    await enterTool.execute("call-1", {});
    const exitTool = exit({ sessionKey: SESSION_KEY });
    await exitTool.execute("call-2", {
      title: "X",
      plan: [{ step: "a", status: "pending" }],
    });
    const wrong = "plan-00000000-0000-4000-9000-000000000000";
    const result = (await harness.invokeAction("plan.accept", {
      sessionKey: SESSION_KEY,
      payload: { approvalId: wrong },
    })) as { ok: boolean; code?: string };
    expect(result.ok).toBe(false);
    expect(result.code).toBe("STALE_APPROVAL_ID");
  });

  it("plan.edit path: enter → exit → edit(with body) → [PLAN_DECISION]: edited with body", async () => {
    const enterTool = enter({ sessionKey: SESSION_KEY });
    await enterTool.execute("call-1", {});
    const exitTool = exit({ sessionKey: SESSION_KEY });
    const exitResult = await exitTool.execute("call-2", {
      title: "X",
      plan: [{ step: "a", status: "pending" }],
    });
    const approvalId = exitResult.details.approvalId;

    await harness.invokeAction("plan.edit", {
      sessionKey: SESSION_KEY,
      payload: {
        approvalId,
        body: "Edited step 1\nEdited step 2",
      },
    });
    expect(harness.captures.enqueuedInjections).toHaveLength(1);
    const inj = harness.captures.enqueuedInjections[0] as {
      text: string;
      idempotencyKey: string;
    };
    expect(inj.text).toBe(
      "[PLAN_DECISION]: edited\nEdited step 1\nEdited step 2",
    );
    expect(inj.idempotencyKey).toBe(
      `smarter-claw:plan_decision:${approvalId}:edited`,
    );
  });

  it("plan.cancel exits plan mode (continueAgent=false)", async () => {
    const enterTool = enter({ sessionKey: SESSION_KEY });
    await enterTool.execute("call-1", {});

    const result = (await harness.invokeAction("plan.cancel", {
      sessionKey: SESSION_KEY,
    })) as { ok: boolean; continueAgent?: boolean };
    expect(result.ok).toBe(true);
    expect(result.continueAgent).toBe(false);

    // After cancel, mutation gate stops firing — verify via Edit no longer
    // blocks.
    const ret = await harness.triggerHook(
      "before_tool_call",
      { toolName: "Edit", params: { file_path: "/tmp/x.ts" } },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect(ret[0]).toBeUndefined();
  });
});
