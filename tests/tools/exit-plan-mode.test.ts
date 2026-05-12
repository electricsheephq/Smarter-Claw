/**
 * P-4 exit_plan_mode tool tests.
 *
 * Covers schema validation (plan steps, at-most-one in_progress), the
 * payloadHash + approvalId minting + PlanModeStore wiring. The full
 * Invariant 1-10 behavior is covered by tests/state/store.test.ts +
 * parity-harness; here we test the TOOL-level wrapping (input
 * validation, output shape, error mapping).
 */

import { describe, expect, it } from "vitest";
import { createExitPlanModeTool } from "../../src/tools/exit-plan-mode.js";
import { InMemoryGateway } from "../../src/state/in-memory-gateway.js";
import { PlanModeStore } from "../../src/state/store.js";
import { isPlanApprovalId } from "../../src/helpers/approval-id.js";

const SESSION_KEY = "agent:main:main";

function build() {
  const gw = new InMemoryGateway();
  // Seed the session in plan mode so exit_plan_mode can persist.
  gw.seed(SESSION_KEY, {
    mode: "plan",
    approval: "none",
    rejectionCount: 0,
    enteredAt: 1_700_000_000_000,
  });
  const store = new PlanModeStore(gw);
  const factory = createExitPlanModeTool({ store });
  return { gw, store, factory };
}

describe("P-4 exit_plan_mode — tool shape", () => {
  it("factory returns a tool definition with required fields", () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    expect(tool.name).toBe("exit_plan_mode");
    expect(tool.label).toBe("Exit Plan Mode");
    expect(tool.description).toMatch(/approval/i);
    expect(typeof tool.execute).toBe("function");
  });

  it("schema enforces additionalProperties: false at the top level", () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const params = tool.parameters as { additionalProperties?: boolean };
    expect(params.additionalProperties).toBe(false);
  });
});

describe("P-4 exit_plan_mode — input validation", () => {
  it("rejects missing plan array", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {});
    expect(result.details).toEqual(
      expect.objectContaining({ status: "invalid-input" }),
    );
    expect(result.content[0]?.text).toMatch(/plan required/);
  });

  it("rejects empty plan array", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", { plan: [] });
    expect(result.details).toEqual(
      expect.objectContaining({ status: "invalid-input" }),
    );
  });

  it("rejects plan with multiple in_progress steps", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      plan: [
        { step: "a", status: "in_progress" },
        { step: "b", status: "in_progress" },
      ],
    });
    expect(result.details).toEqual(
      expect.objectContaining({ status: "invalid-input" }),
    );
    expect(result.content[0]?.text).toMatch(/at most one in_progress/i);
  });

  it("rejects plan step with invalid status", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      plan: [{ step: "a", status: "bogus_status" }],
    });
    expect(result.details).toEqual(
      expect.objectContaining({ status: "invalid-input" }),
    );
    expect(result.content[0]?.text).toMatch(/status must be one of/i);
  });

  it("accepts valid plan with one in_progress + multiple pending", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      plan: [
        { step: "a", status: "completed" },
        { step: "b", status: "in_progress" },
        { step: "c", status: "pending" },
      ],
    });
    expect(result.details).toEqual(
      expect.objectContaining({ status: "approval-requested" }),
    );
  });
});

describe("P-4 exit_plan_mode — happy path", () => {
  it("mints a valid plan-approvalId via newPlanApprovalId", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      plan: [{ step: "do thing", status: "pending" }],
    });
    const approvalId = (result.details as { approvalId?: string }).approvalId;
    expect(approvalId).toBeDefined();
    expect(isPlanApprovalId(approvalId)).toBe(true);
  });

  it("computes payloadHash and exposes it in details", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      title: "Bump deps",
      summary: "Update tooling",
      plan: [{ step: "Bump eslint", status: "pending" }],
    });
    const hash = (result.details as { payloadHash?: string }).payloadHash;
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("persists plan-mode state through PlanModeStore", async () => {
    const { gw, factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    await tool.execute("call-1", {
      title: "Bump deps",
      plan: [
        { step: "Bump eslint", status: "pending" },
        { step: "Bump prettier", status: "pending" },
      ],
    });
    const state = gw.peek(SESSION_KEY);
    expect(state?.approval).toBe("pending");
    expect(state?.approvalId).toBeDefined();
    expect(state?.title).toBe("Bump deps");
    expect(state?.lastPlanSteps).toHaveLength(2);
    expect(state?.lastPlanPayloadHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("step count reflected in result text", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const r1 = await tool.execute("c1", { plan: [{ step: "a", status: "pending" }] });
    expect(r1.content[0]?.text).toMatch(/1 step/);
    const r2 = await tool.execute("c2", {
      plan: [
        { step: "a", status: "pending" },
        { step: "b", status: "pending" },
      ],
    });
    expect(r2.content[0]?.text).toMatch(/2 steps/);
  });
});

describe("P-4 exit_plan_mode — duplicate detection (Invariant 3)", () => {
  it("returns duplicate-detected status + reuses existing approvalId on identical re-submit", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const input = {
      title: "Bump deps",
      plan: [{ step: "Bump eslint", status: "pending" }],
    };
    const first = await tool.execute("c1", input);
    const firstId = (first.details as { approvalId: string }).approvalId;

    const second = await tool.execute("c2", input);
    expect(second.details).toEqual(
      expect.objectContaining({ status: "duplicate-detected", approvalId: firstId }),
    );
    expect(second.content[0]?.text).toMatch(/duplicate detected/i);
  });

  it("changing the plan minted a fresh approvalId (Invariant 3 rotate path)", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const first = await tool.execute("c1", {
      plan: [{ step: "v1", status: "pending" }],
    });
    const firstId = (first.details as { approvalId: string }).approvalId;
    const second = await tool.execute("c2", {
      plan: [{ step: "v2", status: "pending" }],
    });
    expect((second.details as { approvalId: string }).approvalId).not.toBe(firstId);
    expect((second.details as { status: string }).status).toBe("approval-requested");
  });
});

describe("P-4 exit_plan_mode — error paths", () => {
  it("returns not-in-plan-mode when session has no plan-mode payload", async () => {
    const gw = new InMemoryGateway(); // unseeded
    const store = new PlanModeStore(gw);
    const factory = createExitPlanModeTool({ store });
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe("not-in-plan-mode");
    expect(result.content[0]?.text).toMatch(/Call enter_plan_mode first/);
  });

  it("returns no-session when sessionKey unresolved", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: undefined });
    const result = await tool.execute("c1", {
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe("no-session");
  });

  it("returns failed when store gateway throws", async () => {
    const brokenGw = {
      async withLock<T>(): Promise<{ transition?: T }> {
        throw new Error("simulated IO failure");
      },
    };
    const store = new PlanModeStore(brokenGw as never);
    const factory = createExitPlanModeTool({ store });
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe("failed");
    expect(result.content[0]?.text).toMatch(/simulated IO failure/);
  });
});
