/**
 * Ported from openclaw-1: src/agents/tools/exit-plan-mode-tool.test.ts
 *
 * What IS ported:
 *   - Title-required gate (Bug 2/6 fix).
 *   - All PR-10 archetype-field assertions: title clamping, analysis
 *     trim/drop-blank, assumptions trim+filter, risks both-fields-
 *     required filter, verification + references trim+drop-blank,
 *     omits-optionals when not supplied.
 *   - Parity port #3+#8 (2026-04-24): the subagent-in-flight gate
 *     reshaped to drive plugin-namespaced state via the
 *     openclaw/plugin-sdk/session-store-runtime mock seam.
 *     `blockingSubagentRunIds` is the field on
 *     `SmarterClawSessionState` populated by
 *     `lifecycle-hooks.handleSubagentSpawning` /
 *     `handleSubagentEnded`. The tool reads it via
 *     `readSmarterClawState` and refuses submission when non-empty.
 *     Replaces the openclaw-1 `clearAgentRunContext` /
 *     `registerAgentRunContext` test helpers (host-side, not on the
 *     plugin surface).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExitPlanModeTool } from "../src/tools/exit-plan-mode-tool.js";
import { SMARTER_CLAW_PLUGIN_ID } from "../src/types.js";

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

/**
 * Parity ports #3 + #8: subagent-in-flight gate.
 *
 * Drives the gate via a mocked `openclaw/plugin-sdk/session-store-runtime`
 * module — the same seam runtime-api and the tool body itself use to
 * read plugin-namespaced state. Each test seeds the in-memory store with
 * a SmarterClawSessionState slot containing the
 * `blockingSubagentRunIds` field that the gate reads.
 *
 * Mirrors the openclaw-1 suite shape:
 *   - empty list / no state → succeeds
 *   - missing agentId/sessionKey (test/standalone path) → succeeds
 *   - 1 in-flight → throws with that runId in message
 *   - 5 in-flight → all 5 listed
 *   - 7 in-flight → truncated with "and 2 more" suffix
 *   - error message names the post-approval-poisoning concern
 *   - drained list → succeeds on subsequent call
 */
describe("createExitPlanModeTool — subagent gate (parity #3)", () => {
  const validPlanArgs = {
    title: "Test plan",
    plan: [{ step: "do the thing", status: "pending" }],
  };

  type StoreShape = Record<string, Record<string, unknown>>;

  function buildStoreSeed(opts: {
    sessionKey: string;
    blockingSubagentRunIds?: readonly string[];
  }): StoreShape {
    const state: Record<string, unknown> = {
      planMode: "plan",
      planApproval: "idle",
      autoApprove: false,
    };
    if (opts.blockingSubagentRunIds) {
      state.blockingSubagentRunIds = [...opts.blockingSubagentRunIds];
    }
    return {
      [opts.sessionKey]: {
        sessionId: opts.sessionKey,
        pluginMetadata: { [SMARTER_CLAW_PLUGIN_ID]: state },
      },
    };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("openclaw/plugin-sdk/session-store-runtime");
  });

  afterEach(() => {
    vi.doUnmock("openclaw/plugin-sdk/session-store-runtime");
    vi.resetModules();
  });

  async function runToolWithSeed(
    seed: StoreShape | undefined,
    args: Record<string, unknown> = validPlanArgs,
  ): Promise<{ result?: unknown; error?: Error }> {
    vi.doMock("openclaw/plugin-sdk/session-store-runtime", () => ({
      loadSessionStore: () => seed ?? {},
      resolveSessionStoreEntry: ({
        store,
        sessionKey,
      }: {
        store: Record<string, Record<string, unknown>>;
        sessionKey: string;
      }) => ({ existing: store?.[sessionKey] }),
      resolveStorePath: () => "/tmp/mock-store",
      // No write API needed — exit_plan_mode body's persistFromTool
      // call short-circuits when missing, and we only care about the
      // gate decision.
      updateSessionStoreEntry: undefined,
    }));
    const { createExitPlanModeTool: makeTool } = await import(
      "../src/tools/exit-plan-mode-tool.js"
    );
    const tool = makeTool({ agentId: "default", sessionKey: "session-gate-test" });
    try {
      const result = await tool.execute("call-1", args, new AbortController().signal);
      return { result };
    } catch (err) {
      return { error: err as Error };
    }
  }

  it("empty blockingSubagentRunIds → succeeds", async () => {
    const seed = buildStoreSeed({
      sessionKey: "session-gate-test",
      blockingSubagentRunIds: [],
    });
    const { result, error } = await runToolWithSeed(seed);
    expect(error).toBeUndefined();
    expect((result as { details: { status: string } }).details).toMatchObject({
      status: "approval_requested",
    });
  });

  it("no plugin state at all → succeeds (planMode never set)", async () => {
    const seed = { "session-gate-test": { sessionId: "session-gate-test" } };
    const { result, error } = await runToolWithSeed(seed);
    expect(error).toBeUndefined();
    expect((result as { details: { status: string } }).details).toMatchObject({
      status: "approval_requested",
    });
  });

  it("missing sessionKey/agentId on the tool factory → succeeds (standalone path)", async () => {
    // No mock seed — the tool factory was created without
    // agentId/sessionKey so the gate skips the store-read entirely.
    const tool = createExitPlanModeTool();
    const result = await tool.execute("call-1", validPlanArgs, new AbortController().signal);
    expect(result.details).toMatchObject({ status: "approval_requested" });
  });

  it("1 in-flight subagent → throws with that runId in message", async () => {
    const seed = buildStoreSeed({
      sessionKey: "session-gate-test",
      blockingSubagentRunIds: ["child-run-abc"],
    });
    const { error } = await runToolWithSeed(seed);
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/child-run-abc/);
    expect(error!.message).toMatch(/exit_plan_mode blocked/);
  });

  it("5 in-flight subagents → all 5 ids in error message", async () => {
    const seed = buildStoreSeed({
      sessionKey: "session-gate-test",
      blockingSubagentRunIds: ["r1", "r2", "r3", "r4", "r5"],
    });
    const { error } = await runToolWithSeed(seed);
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/r1.*r2.*r3.*r4.*r5/);
  });

  it("7 in-flight subagents → truncated with 'and 2 more' suffix", async () => {
    const seed = buildStoreSeed({
      sessionKey: "session-gate-test",
      blockingSubagentRunIds: ["r1", "r2", "r3", "r4", "r5", "r6", "r7"],
    });
    const { error } = await runToolWithSeed(seed);
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/and 2 more/);
  });

  it("error message names the post-approval-poisoning concern", async () => {
    const seed = buildStoreSeed({
      sessionKey: "session-gate-test",
      blockingSubagentRunIds: ["rx"],
    });
    const { error } = await runToolWithSeed(seed);
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/post-approval execution path will be poisoned/);
  });

  it("drained list after subagent completion → succeeds", async () => {
    // First call blocks.
    const blockedSeed = buildStoreSeed({
      sessionKey: "session-gate-test",
      blockingSubagentRunIds: ["child-x"],
    });
    const { error: blockedErr } = await runToolWithSeed(blockedSeed);
    expect(blockedErr).toBeDefined();
    expect(blockedErr!.message).toMatch(/child-x/);

    // Second call after completion drain — fresh module so the doMock
    // gets re-applied with the drained seed.
    vi.resetModules();
    vi.doUnmock("openclaw/plugin-sdk/session-store-runtime");
    const drainedSeed = buildStoreSeed({
      sessionKey: "session-gate-test",
      blockingSubagentRunIds: [],
    });
    const { result: drainedResult, error: drainedErr } = await runToolWithSeed(drainedSeed);
    expect(drainedErr).toBeUndefined();
    expect((drainedResult as { details: { status: string } }).details).toMatchObject({
      status: "approval_requested",
    });
  });

  it("session-store read failure → bypasses gate (best-effort) and succeeds", async () => {
    vi.doMock("openclaw/plugin-sdk/session-store-runtime", () => ({
      loadSessionStore: () => {
        throw new Error("simulated store read failure");
      },
      resolveSessionStoreEntry: () => ({ existing: undefined }),
      resolveStorePath: () => "/tmp/mock-store",
      updateSessionStoreEntry: undefined,
    }));
    const { createExitPlanModeTool: makeTool } = await import(
      "../src/tools/exit-plan-mode-tool.js"
    );
    const tool = makeTool({ agentId: "default", sessionKey: "session-gate-test" });
    const result = await tool.execute("call-1", validPlanArgs, new AbortController().signal);
    expect(result.details).toMatchObject({ status: "approval_requested" });
  });
});
