/**
 * P-12 sidebar-descriptor tests.
 *
 * Validates the static shape of the PluginControlUiDescriptor we
 * register for the Plan Mode sidebar surface.
 */

import { describe, expect, it } from "vitest";
import {
  PLAN_MODE_SIDEBAR_DESCRIPTOR_ID,
  buildPlanModeSidebarDescriptor,
} from "../../src/ui/sidebar-descriptor.js";

describe("P-12 sidebar-descriptor", () => {
  it("uses the namespaced id `smarter-claw.plan-mode.sidebar`", () => {
    expect(PLAN_MODE_SIDEBAR_DESCRIPTOR_ID).toBe(
      "smarter-claw.plan-mode.sidebar",
    );
    const d = buildPlanModeSidebarDescriptor();
    expect(d.id).toBe(PLAN_MODE_SIDEBAR_DESCRIPTOR_ID);
  });

  it("renders on the `session` surface", () => {
    const d = buildPlanModeSidebarDescriptor();
    expect(d.surface).toBe("session");
  });

  it("has a human-readable label", () => {
    const d = buildPlanModeSidebarDescriptor();
    expect(d.label).toBe("Plan Mode");
  });

  it("describes the workflow + actions in the description", () => {
    const d = buildPlanModeSidebarDescriptor();
    expect(d.description).toBeTruthy();
    expect(d.description!.length).toBeGreaterThan(30);
  });

  it("schema declares the plan-mode state fields", () => {
    const d = buildPlanModeSidebarDescriptor();
    const schema = d.schema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        "mode",
        "approval",
        "rejectionCount",
        "approvalId",
        "title",
        "feedback",
        "lastPlanSteps",
        "autoApprove",
        "__schemaVersion",
      ]),
    );
    expect(schema.required).toEqual(["mode", "approval", "rejectionCount"]);
  });

  it("mode enum matches the PlanMode union", () => {
    const d = buildPlanModeSidebarDescriptor();
    const schema = d.schema as {
      properties: { mode: { enum: string[] } };
    };
    expect(schema.properties.mode.enum).toEqual(["plan", "normal"]);
  });

  it("approval enum matches the PlanApprovalState union", () => {
    const d = buildPlanModeSidebarDescriptor();
    const schema = d.schema as {
      properties: { approval: { enum: string[] } };
    };
    expect(schema.properties.approval.enum).toEqual([
      "none",
      "pending",
      "approved",
      "edited",
      "rejected",
      "timed_out",
    ]);
  });
});
