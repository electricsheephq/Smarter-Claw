/**
 * Ported from openclaw-1: src/agents/plan-mode/integration.test.ts
 *
 * Adapted for Smarter-Claw API:
 *   - The "tool enablement gate" describe block in the openclaw-1 file
 *     asserts on `isPlanModeToolsEnabledForOpenClawTools`, which is a
 *     host-side module (`src/agents/openclaw-tools.registration.js`)
 *     not present in the Smarter-Claw plugin. Skipped as `it.skip`
 *     with a TODO; documented in tests/SKIPPED.md.
 *   - The "before-tool-call hook" assertions in the openclaw-1 file
 *     went through `runBeforeToolCallHook` (host module
 *     `src/agents/pi-tools.before-tool-call.js`). Smarter-Claw's
 *     equivalent surface is `checkMutationGate` (the same logic the
 *     installer patch wires into the host's before_tool_call hook).
 *     The assertions are reshaped to call the gate directly.
 *   - The exit_plan_mode tool tests use Smarter-Claw's createExitPlanModeTool
 *     (which already drops the subagent gate — see exit-plan-mode-tool.test.ts
 *     header).
 */
import { describe, expect, it } from "vitest";
import { checkMutationGate } from "../src/mutation-gate.js";
import { createEnterPlanModeTool } from "../src/tools/enter-plan-mode-tool.js";
import { createExitPlanModeTool } from "../src/tools/exit-plan-mode-tool.js";

describe("plan-mode integration", () => {
  describe.skip("tool enablement gate (TODO: port if Smarter-Claw exposes equivalent helper)", () => {
    it.skip("returns false when agents.defaults.planMode is absent", () => {
      // Lives in openclaw-1's host module
      // src/agents/openclaw-tools.registration.js — not part of the
      // Smarter-Claw plugin surface. The plugin is enabled/disabled via
      // its plugin manifest + plugin config; there's no equivalent
      // `isPlanModeToolsEnabledForOpenClawTools` helper to assert on.
    });
  });

  describe("enter_plan_mode tool", () => {
    it("returns a structured 'entered' result the runner can dispatch on", async () => {
      const tool = createEnterPlanModeTool();
      const result = await tool.execute(
        "call-1",
        { reason: "multi-file refactor" },
        new AbortController().signal,
      );
      expect(result.details).toMatchObject({
        status: "entered",
        mode: "plan",
        reason: "multi-file refactor",
      });
    });

    it("omits reason when not provided or whitespace-only", async () => {
      const tool = createEnterPlanModeTool();
      const r1 = await tool.execute("c1", {}, new AbortController().signal);
      const r2 = await tool.execute("c2", { reason: "   " }, new AbortController().signal);
      expect((r1.details as Record<string, unknown>).reason).toBeUndefined();
      expect((r2.details as Record<string, unknown>).reason).toBeUndefined();
    });
  });

  describe("exit_plan_mode tool", () => {
    it("returns 'approval_requested' with the proposed plan", async () => {
      const tool = createExitPlanModeTool();
      const result = await tool.execute(
        "call-1",
        {
          title: "Refactor checklist",
          summary: "Refactor checklist",
          plan: [
            { step: "Run tests", status: "pending" },
            { step: "Apply patch", status: "pending" },
          ],
        },
        new AbortController().signal,
      );
      expect(result.details).toMatchObject({
        status: "approval_requested",
        summary: "Refactor checklist",
        plan: [
          { step: "Run tests", status: "pending" },
          { step: "Apply patch", status: "pending" },
        ],
      });
    });

    it("rejects an empty plan (cannot exit without a proposal)", async () => {
      const tool = createExitPlanModeTool();
      await expect(
        tool.execute("c1", { title: "Empty plan", plan: [] }, new AbortController().signal),
      ).rejects.toThrow();
    });

    it("rejects a plan with multiple in_progress steps", async () => {
      const tool = createExitPlanModeTool();
      await expect(
        tool.execute(
          "c1",
          {
            title: "Multiple active steps",
            plan: [
              { step: "A", status: "in_progress" },
              { step: "B", status: "in_progress" },
            ],
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/at most one in_progress/);
    });

    it("rejects a plan with an unknown status value", async () => {
      const tool = createExitPlanModeTool();
      await expect(
        tool.execute(
          "c1",
          {
            title: "Unknown status",
            plan: [{ step: "A", status: "weirdo" }],
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/must be one of/);
    });
  });

  // Reshaped: the openclaw-1 file used `runBeforeToolCallHook` (host module);
  // Smarter-Claw's equivalent contract is `checkMutationGate` directly.
  describe("mutation-gate with planMode active", () => {
    it("blocks `write` tool when planMode === 'plan'", () => {
      const result = checkMutationGate("write", "plan");
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/plan mode/i);
    });

    it("blocks `edit` tool when planMode === 'plan'", () => {
      const result = checkMutationGate("edit", "plan");
      expect(result.blocked).toBe(true);
    });

    it("blocks `exec` with a mutation command when planMode === 'plan'", () => {
      const result = checkMutationGate("exec", "plan", "rm -rf /tmp/something");
      expect(result.blocked).toBe(true);
    });

    it("ALLOWS `read` tool when planMode === 'plan' (read-only)", () => {
      const result = checkMutationGate("read", "plan");
      expect(result.blocked).toBe(false);
    });

    it("ALLOWS `web_search` tool when planMode === 'plan'", () => {
      const result = checkMutationGate("web_search", "plan");
      expect(result.blocked).toBe(false);
    });

    it("ALLOWS `update_plan` tool when planMode === 'plan'", () => {
      const result = checkMutationGate("update_plan", "plan");
      expect(result.blocked).toBe(false);
    });

    it("ALLOWS `exit_plan_mode` tool when planMode === 'plan'", () => {
      const result = checkMutationGate("exit_plan_mode", "plan");
      expect(result.blocked).toBe(false);
    });

    it("ALLOWS `exec` with read-only command (e.g. `ls`) when planMode === 'plan'", () => {
      const result = checkMutationGate("exec", "plan", "ls -la");
      expect(result.blocked).toBe(false);
    });

    it("DOES NOT block any tool when planMode === 'normal'", () => {
      expect(checkMutationGate("write", "normal").blocked).toBe(false);
      expect(checkMutationGate("exec", "normal", "rm -rf /tmp").blocked).toBe(false);
    });

    it("blocks unknown tools by default in plan mode (default-deny)", () => {
      const result = checkMutationGate("some_unknown_mcp_tool", "plan");
      expect(result.blocked).toBe(true);
    });
  });
});
