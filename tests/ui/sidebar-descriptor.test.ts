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

  // W1-S9-1: the descriptor schema must mirror `PlanModeSessionState`
  // (src/types.ts) field-for-field — the store writes all 5 of these
  // and a strict-validating UI client would otherwise drop them.
  it("schema declares the 5 previously-omitted state fields (W1-S9-1)", () => {
    const d = buildPlanModeSidebarDescriptor();
    const props = (
      d.schema as { properties: Record<string, { type?: string }> }
    ).properties;
    // Timestamps — Unix ms integers.
    expect(props.enteredAt).toEqual({ type: "integer" });
    expect(props.confirmedAt).toEqual({ type: "integer" });
    expect(props.updatedAt).toEqual({ type: "integer" });
    // Ids / hash — strings.
    expect(props.approvalRunId).toEqual({ type: "string" });
    expect(props.lastPlanPayloadHash).toEqual({ type: "string" });
  });

  it("the 5 added fields are OPTIONAL (not in `required`)", () => {
    const d = buildPlanModeSidebarDescriptor();
    const required = (d.schema as { required: string[] }).required;
    for (const field of [
      "enteredAt",
      "confirmedAt",
      "updatedAt",
      "approvalRunId",
      "lastPlanPayloadHash",
    ]) {
      expect(required).not.toContain(field);
    }
  });

  it("schema mirrors PlanModeSessionState field-for-field (no drift)", () => {
    // Every non-`__schemaVersion` key the descriptor declares must be a
    // real `PlanModeSessionState` field, and every state field must be
    // declared. `__schemaVersion` is a store-stamped meta field with no
    // type-level counterpart, so it is allowed as an extra.
    const d = buildPlanModeSidebarDescriptor();
    const declared = Object.keys(
      (d.schema as { properties: Record<string, unknown> }).properties,
    )
      .filter((k) => k !== "__schemaVersion")
      .sort();
    const stateFields = [
      "mode",
      "approval",
      "enteredAt",
      "confirmedAt",
      "updatedAt",
      "feedback",
      "rejectionCount",
      "approvalId",
      "title",
      "approvalRunId",
      "lastPlanPayloadHash",
      "lastPlanSteps",
      "autoApprove",
    ].sort();
    expect(declared).toEqual(stateFields);
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
