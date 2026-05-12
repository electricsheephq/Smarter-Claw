/**
 * P-4 enter_plan_mode tool tests.
 *
 * Covers the tool-factory contract + state-transition wiring through
 * PlanModeStore. Does NOT test the in-host runner path (the plugin
 * doesn't have a runner — the tool body itself owns the mutation).
 */

import { describe, expect, it } from "vitest";
import { createEnterPlanModeTool } from "../../src/tools/enter-plan-mode.js";
import { InMemoryGateway } from "../../src/state/in-memory-gateway.js";
import { PlanModeStore } from "../../src/state/store.js";

const SESSION_KEY = "agent:main:main";

function build() {
  const gw = new InMemoryGateway();
  const store = new PlanModeStore(gw);
  const factory = createEnterPlanModeTool({ store });
  return { gw, store, factory };
}

describe("P-4 enter_plan_mode — tool shape", () => {
  it("factory returns a tool definition with required fields", () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    expect(tool.name).toBe("enter_plan_mode");
    expect(tool.label).toBe("Enter Plan Mode");
    expect(tool.description).toMatch(/plan mode/i);
    expect(typeof tool.execute).toBe("function");
  });

  it("schema rejects unknown properties (additionalProperties: false)", () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    // typebox schema is a static object; spot-check.
    const params = tool.parameters as { additionalProperties?: boolean };
    expect(params.additionalProperties).toBe(false);
  });

  it("description contains TOOL LIFECYCLE clause (surgical-port S1 fix)", () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    expect(tool.description).toMatch(/TOOL LIFECYCLE/);
    expect(tool.description).toMatch(/enter_plan_mode = ONCE/);
    expect(tool.description).toMatch(/update_plan = DURING/);
    expect(tool.description).toMatch(/exit_plan_mode = ONCE when ready to propose/);
  });

  it("description points to reference card + plan_mode_status diagnostic", () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    expect(tool.description).toMatch(/reference card/);
    expect(tool.description).toMatch(/plan_mode_status/);
  });
});

describe("P-4 enter_plan_mode — state transitions", () => {
  it("entering from no state writes mode=plan, approval=none", async () => {
    const { gw, factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {});
    const state = gw.peek(SESSION_KEY);
    expect(state?.mode).toBe("plan");
    expect(state?.approval).toBe("none");
    expect(state?.rejectionCount).toBe(0);
    expect(state?.enteredAt).toBeGreaterThan(0);
    expect(result.details).toEqual(
      expect.objectContaining({ status: "entered", mode: "plan" }),
    );
  });

  it("entering when already in plan mode is a noop (no extra write)", async () => {
    const { gw, factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    await tool.execute("call-1", {});
    expect(gw.writeCount).toBe(1);
    const result = await tool.execute("call-2", {});
    expect(gw.writeCount).toBe(1); // unchanged
    expect(result.details).toEqual(
      expect.objectContaining({ status: "already-in-plan-mode", mode: "plan" }),
    );
  });

  it("reason is echoed in details when provided", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", { reason: "multi-file refactor" });
    expect(result.details).toEqual(
      expect.objectContaining({ reason: "multi-file refactor" }),
    );
  });

  it("blank reason is dropped from details (defense vs schema bypass)", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", { reason: "   " });
    expect((result.details as { reason?: string }).reason).toBeUndefined();
  });

  it("output text tells the model what to do next (anti-halt nudge)", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {});
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/exit_plan_mode/);
    expect(text).toMatch(/do NOT stop/i);
  });
});

describe("P-4 enter_plan_mode — error paths", () => {
  it("returns soft no-session error when sessionKey unresolved", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: undefined });
    const result = await tool.execute("call-1", {});
    expect(result.details).toEqual(
      expect.objectContaining({ status: "no-session" }),
    );
    expect(result.content[0]?.text).toMatch(/no sessionKey/i);
  });

  it("returns soft failure when gateway throws (IO error)", async () => {
    const brokenGw = {
      async withLock<T>(_k: string, _u: unknown): Promise<{ transition?: T }> {
        throw new Error("simulated disk failure");
      },
    };
    const store = new PlanModeStore(brokenGw as never);
    const factory = createEnterPlanModeTool({ store });
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {});
    expect(result.details).toEqual(
      expect.objectContaining({ status: "failed" }),
    );
    expect(result.content[0]?.text).toMatch(/simulated disk failure/);
  });
});
