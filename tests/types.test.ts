/**
 * P-2 type tests.
 *
 * Pins the public types + DEFAULT_PLAN_MODE_STATE shape that P-3+ build
 * on. Catches accidental schema drift (additive-only rule) before
 * downstream PRs break.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_MODE_STATE,
  type PlanApprovalState,
  type PlanMode,
  type PlanModeSessionState,
  type PlanStep,
} from "../src/types.js";

describe("P-2 types — PlanMode union", () => {
  it("accepts the two documented values", () => {
    const _planMode: PlanMode = "plan";
    const _normalMode: PlanMode = "normal";
    // Compile-time check only — these assignments compile or the test
    // file fails to compile (which fails CI).
    expect(_planMode).toBe("plan");
    expect(_normalMode).toBe("normal");
  });

  // Type-level negative test: this should NOT compile if our union
  // expands accidentally. We can't enforce it from inside the test
  // body, but a `@ts-expect-error` comment in a type-only file would.
  // (Add to a separate types-negative test if drift becomes a worry.)
});

describe("P-2 types — PlanApprovalState union", () => {
  it("accepts all 6 documented values", () => {
    const cases: PlanApprovalState[] = [
      "none",
      "pending",
      "approved",
      "edited",
      "rejected",
      "timed_out",
    ];
    expect(cases).toHaveLength(6);
  });
});

describe("P-2 types — PlanStep", () => {
  it("requires step + status; activeForm optional", () => {
    const minimal: PlanStep = { step: "Bump deps", status: "pending" };
    const withActiveForm: PlanStep = {
      step: "Bumping deps",
      status: "in_progress",
      activeForm: "Bumping deps to latest",
    };
    expect(minimal.step).toBe("Bump deps");
    expect(withActiveForm.activeForm).toBe("Bumping deps to latest");
  });
});

describe("P-2 types — PlanModeSessionState DEFAULT", () => {
  it("starts in normal mode with no approval pending", () => {
    expect(DEFAULT_PLAN_MODE_STATE.mode).toBe("normal");
    expect(DEFAULT_PLAN_MODE_STATE.approval).toBe("none");
  });

  it("rejectionCount initializes to 0", () => {
    expect(DEFAULT_PLAN_MODE_STATE.rejectionCount).toBe(0);
  });

  it("optional fields are undefined by default", () => {
    expect(DEFAULT_PLAN_MODE_STATE.approvalId).toBeUndefined();
    expect(DEFAULT_PLAN_MODE_STATE.title).toBeUndefined();
    expect(DEFAULT_PLAN_MODE_STATE.lastPlanPayloadHash).toBeUndefined();
    expect(DEFAULT_PLAN_MODE_STATE.lastPlanSteps).toBeUndefined();
    expect(DEFAULT_PLAN_MODE_STATE.feedback).toBeUndefined();
  });

  it("default object can be spread to build new states (immutability check)", () => {
    const stateA: PlanModeSessionState = {
      ...DEFAULT_PLAN_MODE_STATE,
      mode: "plan",
      enteredAt: 1700000000000,
    };
    // Spreading creates a new object; original stays "normal".
    expect(DEFAULT_PLAN_MODE_STATE.mode).toBe("normal");
    expect(stateA.mode).toBe("plan");
    expect(stateA.rejectionCount).toBe(0);
  });

  it("the default object exposes only the 3 required keys", () => {
    // Catches accidental drift: if we add a 4th field with a default
    // value, this test fails and forces an explicit migration plan.
    const keys = Object.keys(DEFAULT_PLAN_MODE_STATE).sort();
    expect(keys).toEqual(["approval", "mode", "rejectionCount"]);
  });
});
