/**
 * Eva Live-Smoke #1 — Mutation gate end-to-end.
 *
 * Scenario:
 *   1. Plugin loads.
 *   2. Session calls `enter_plan_mode` → state.mode === "plan".
 *   3. Agent tries Edit / Write / Bash / a destructive exec → gate blocks.
 *   4. Read-only tools (Read, web_search) pass through.
 *   5. `exit_plan_mode` itself is allowed (otherwise the agent can't
 *      propose a plan).
 *
 * Originally scheduled to run live against Eva's gateway after P-5;
 * implemented here as an SDK-stubbed end-to-end test so it runs in CI
 * via `pnpm test` (no real gateway needed).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "./harness.js";

const SESSION_KEY = "agent:main:main";

describe("Eva live-smoke #1 — mutation gate (P-5)", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(async () => {
    harness = createHarness({ forceInMemory: true });
    // Drive into plan mode by invoking enter_plan_mode tool.
    const factory = harness.findTool("enter_plan_mode") as (
      ctx: { sessionKey?: string },
    ) => {
      execute: (
        callId: string,
        args: unknown,
      ) => Promise<{ details: { status: string } }>;
    };
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", { reason: "smoke #1" });
    expect(result.details.status).toBe("entered");
  });

  afterEach(() => {
    delete process.env.SMARTER_CLAW_USE_INMEMORY;
  });

  it("blocks Edit tool with the canonical mutation-gate reason", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      { toolName: "Edit", params: { file_path: "/tmp/x.ts" } },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect(ret).toHaveLength(1);
    const decision = ret[0] as { block?: boolean; blockReason?: string } | undefined;
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toMatch(/blocked in plan mode/i);
  });

  it("blocks Write tool", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      { toolName: "Write", params: { file_path: "/tmp/y.ts" } },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    const decision = ret[0] as { block?: boolean } | undefined;
    expect(decision?.block).toBe(true);
  });

  it("blocks Bash with a non-read-only command", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: "rm -rf /tmp/scratch" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    const decision = ret[0] as
      | { block?: boolean; blockReason?: string }
      | undefined;
    expect(decision?.block).toBe(true);
  });

  it("blocks Bash with shell compound operators even in a read-only-looking command", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: "ls /tmp; cat /etc/passwd" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    const decision = ret[0] as
      | { block?: boolean; blockReason?: string }
      | undefined;
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toMatch(/shell operators or newlines/i);
  });

  it("allows Read tool (in the explicit allowlist)", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      { toolName: "Read", params: { file_path: "/tmp/x.ts" } },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect(ret[0]).toBeUndefined();
  });

  it("allows web_search tool", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      { toolName: "web_search", params: { query: "x" } },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect(ret[0]).toBeUndefined();
  });

  it("allows exit_plan_mode (the agent's escape hatch)", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      { toolName: "exit_plan_mode", params: { title: "t", plan: [] } },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect(ret[0]).toBeUndefined();
  });

  it("allows Bash with a read-only prefix (e.g. `ls -la`)", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      { toolName: "Bash", params: { command: "ls -la" } },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect(ret[0]).toBeUndefined();
  });

  it("logs the block decision (operator observability)", async () => {
    await harness.triggerHook(
      "before_tool_call",
      { toolName: "Edit", params: { file_path: "/tmp/x.ts" } },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    const blocked = harness.captures.loggerInfo.find((m) =>
      /mutation gate blocked/.test(m),
    );
    expect(blocked).toBeDefined();
    expect(blocked).toMatch(/tool="Edit"/);
  });
});
