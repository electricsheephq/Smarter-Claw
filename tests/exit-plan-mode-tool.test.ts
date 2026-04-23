/**
 * Ported from openclaw-1: src/agents/tools/exit-plan-mode-tool.test.ts
 *
 * Notes on what's NOT ported:
 *   - The "subagent gate" describe block is intentionally NOT ported.
 *     Smarter-Claw's exit_plan_mode tool does NOT enforce the subagent-
 *     in-flight gate; the file header explains: "subagent-in-flight
 *     gate omitted (no AgentRunContext access through the plugin SDK
 *     yet); the soft-steer in the tool description is the current
 *     enforcement". The original assertions used
 *     `clearAgentRunContext` / `registerAgentRunContext` from
 *     `../../infra/agent-events.js` which is host-side and not part of
 *     the plugin surface.
 *
 * What IS ported:
 *   - Title-required gate (Bug 2/6 fix).
 *   - All PR-10 archetype-field assertions: title clamping, analysis
 *     trim/drop-blank, assumptions trim+filter, risks both-fields-
 *     required filter, verification + references trim+drop-blank,
 *     omits-optionals when not supplied.
 */
import { describe, expect, it } from "vitest";
import { createExitPlanModeTool } from "../src/tools/exit-plan-mode-tool.js";

describe("createExitPlanModeTool — basic happy path", () => {
  const validPlanArgs = {
    title: "Test plan",
    plan: [{ step: "do the thing", status: "pending" }],
  };

  it("returns approval_requested with title + plan", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute("call-1", validPlanArgs, new AbortController().signal);
    expect(result.details).toMatchObject({
      status: "approval_requested",
      title: "Test plan",
    });
  });

  it("works without runId (standalone path)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute("call-1", validPlanArgs, new AbortController().signal);
    expect(result.details).toMatchObject({ status: "approval_requested" });
  });
});

describe("createExitPlanModeTool — PR-10 archetype fields", () => {
  const planSteps = [{ step: "do thing", status: "pending" }];
  const defaultTitle = "Test plan";

  it("rejects calls without title (Bug 2/6 fix)", async () => {
    const tool = createExitPlanModeTool();
    await expect(
      tool.execute("c1", { plan: planSteps }, new AbortController().signal),
    ).rejects.toThrow(/exit_plan_mode requires a `title` field/);
  });

  it("rejects calls with whitespace-only title", async () => {
    const tool = createExitPlanModeTool();
    await expect(
      tool.execute("c1", { title: "   ", plan: planSteps }, new AbortController().signal),
    ).rejects.toThrow(/exit_plan_mode requires a `title` field/);
  });

  it("forwards title (clamped to 80 chars)", async () => {
    const tool = createExitPlanModeTool();
    const longTitle = "x".repeat(200);
    const result = await tool.execute(
      "c1",
      { plan: planSteps, title: longTitle },
      new AbortController().signal,
    );
    const details = result.details as { title?: string };
    expect(details.title).toBeDefined();
    expect(details.title!.length).toBe(80);
  });

  it("forwards analysis when non-empty (trimmed)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      { title: defaultTitle, plan: planSteps, analysis: "  Multi-paragraph analysis text.  " },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({
      analysis: "Multi-paragraph analysis text.",
    });
  });

  it("drops analysis when whitespace-only (treats as missing)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      { title: defaultTitle, plan: planSteps, analysis: "   " },
      new AbortController().signal,
    );
    expect((result.details as Record<string, unknown>).analysis).toBeUndefined();
  });

  it("forwards assumptions array (trim + drop blank)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      {
        title: defaultTitle,
        plan: planSteps,
        assumptions: [" tests pass first run ", "", "  ", "auth exports stable"],
      },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({
      assumptions: ["tests pass first run", "auth exports stable"],
    });
  });

  it("drops assumptions array when all entries blank", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      { title: defaultTitle, plan: planSteps, assumptions: ["", "  "] },
      new AbortController().signal,
    );
    expect((result.details as Record<string, unknown>).assumptions).toBeUndefined();
  });

  it("forwards risks array (only entries with both risk + mitigation)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      {
        title: defaultTitle,
        plan: planSteps,
        risks: [
          { risk: "race condition", mitigation: "use mutex" },
          { risk: "missing mitigation only" },
          { mitigation: "no risk text" },
          { risk: "  ", mitigation: "  " },
          { risk: "   sql injection   ", mitigation: "  use parameterized query  " },
          "not an object",
          null,
        ],
      },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({
      risks: [
        { risk: "race condition", mitigation: "use mutex" },
        { risk: "sql injection", mitigation: "use parameterized query" },
      ],
    });
  });

  it("drops risks array when no entries have both fields", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      { title: defaultTitle, plan: planSteps, risks: [{ risk: "alone" }] },
      new AbortController().signal,
    );
    expect((result.details as Record<string, unknown>).risks).toBeUndefined();
  });

  it("forwards verification + references (trim + drop blank)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      {
        title: defaultTitle,
        plan: planSteps,
        verification: ["pnpm test passes", " "],
        references: ["src/x.ts:1", "PR #123", ""],
      },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({
      verification: ["pnpm test passes"],
      references: ["src/x.ts:1", "PR #123"],
    });
  });

  it("omits OPTIONAL archetype fields when none supplied (only title + plan required)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      { title: defaultTitle, plan: planSteps },
      new AbortController().signal,
    );
    const details = result.details as Record<string, unknown>;
    expect(details.analysis).toBeUndefined();
    expect(details.assumptions).toBeUndefined();
    expect(details.risks).toBeUndefined();
    expect(details.verification).toBeUndefined();
    expect(details.references).toBeUndefined();
    expect(details.status).toBe("approval_requested");
    expect(details.plan).toEqual(planSteps);
  });
});
