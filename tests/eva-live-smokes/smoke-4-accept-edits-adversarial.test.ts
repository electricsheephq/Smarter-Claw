/**
 * Eva Live-Smoke #4 — Accept-edits constraint gate adversarial inputs.
 *
 * Scenario:
 *   1. Plugin loads.
 *   2. Operator enables autoApprove (which lazy-inits a normal-mode
 *      state with autoApprove=true — same condition the runtime
 *      checks for "post-approval acceptEdits execution phase").
 *   3. Agent (in normal mode) tries 30 adversarial commands across
 *      the 3 hard-constraint categories:
 *        - Destructive (rm -rf, DROP TABLE, FLUSHALL, ...)
 *        - Self-restart (launchctl unload, pkill openclaw, ...)
 *        - Configuration changes (writes to ~/.openclaw/*, openclaw config set)
 *   4. Each MUST be blocked.
 *   5. Read-only and unrelated tool calls MUST pass through (fail-OPEN).
 *
 * Originally scheduled as Eva live-smoke #4 after P-13. The full 72-case
 * adversarial corpus is exercised by the unit suite at
 * `tests/gates/accept-edits-gate.test.ts` against the pure function;
 * this smoke validates the hook plumbing routes inputs to that gate
 * correctly via the WIRED before_tool_call path in index.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "./harness.js";

const SESSION_KEY = "agent:main:main";

describe("Eva live-smoke #4 — accept-edits gate via before_tool_call (P-13)", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(async () => {
    harness = createHarness({ forceInMemory: true });
    // Lazy-init the session into normal-mode + autoApprove=true.
    // This matches the runtime's "post-approval execution phase" — the
    // gate fires on the autoApprove signal.
    const r = (await harness.invokeAction("plan.auto.toggle", {
      sessionKey: SESSION_KEY,
      payload: { enabled: true },
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  afterEach(() => {
    delete process.env.SMARTER_CLAW_USE_INMEMORY;
  });

  it("blocks `rm -rf /` (destructive)", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: "rm -rf /important/data" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    const decision = ret[0] as
      | { block?: boolean; blockReason?: string }
      | undefined;
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toMatch(/destructive/i);
  });

  it("blocks `find ... -delete`", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: "find /tmp -name '*.bak' -delete" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect((ret[0] as { block?: boolean })?.block).toBe(true);
  });

  it("blocks `find ... -exec rm`", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: "find /tmp -name '*.bak' -exec rm {} \\;" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect((ret[0] as { block?: boolean })?.block).toBe(true);
  });

  it("blocks SQL DROP TABLE", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: 'psql -c "DROP TABLE users;"' },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect((ret[0] as { block?: boolean })?.block).toBe(true);
  });

  it("blocks Redis FLUSHALL", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: "redis-cli FLUSHALL" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect((ret[0] as { block?: boolean })?.block).toBe(true);
  });

  it("blocks `openclaw gateway stop` (self-restart)", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: "openclaw gateway stop" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    const decision = ret[0] as
      | { block?: boolean; blockReason?: string }
      | undefined;
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toMatch(/self.restart|gateway/i);
  });

  it("blocks `launchctl unload` on ai.openclaw.*", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: {
          command:
            "launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist",
        },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect((ret[0] as { block?: boolean })?.block).toBe(true);
  });

  it("blocks `pkill openclaw`", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: "pkill -f openclaw" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect((ret[0] as { block?: boolean })?.block).toBe(true);
  });

  it("blocks `openclaw config set` (config change)", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: {
          command: "openclaw config set plugins.entries.evil.enabled true",
        },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    const decision = ret[0] as
      | { block?: boolean; blockReason?: string }
      | undefined;
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toMatch(/config/i);
  });

  it("blocks Write to ~/.openclaw/openclaw.json (protected config path)", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Write",
        params: {
          file_path: "~/.openclaw/openclaw.json",
          content: "evil",
        },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect((ret[0] as { block?: boolean })?.block).toBe(true);
  });

  it("blocks Edit to /etc/openclaw/config (protected config path)", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Edit",
        params: { file_path: "/etc/openclaw/config.json" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect((ret[0] as { block?: boolean })?.block).toBe(true);
  });

  it("allows safe Edit to a normal file (fail-OPEN posture)", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Edit",
        params: { file_path: "/Users/me/repo/src/index.ts" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    // accept-edits gate is fail-OPEN — non-protected paths pass through.
    expect(ret[0]).toBeUndefined();
  });

  it("allows Read of any path (read-only)", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Read",
        params: { file_path: "~/.openclaw/openclaw.json" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect(ret[0]).toBeUndefined();
  });

  it("allows normal Bash (e.g. `ls -la`) — gate fires only on the 3 categories", async () => {
    const ret = await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: "ls -la /tmp" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    expect(ret[0]).toBeUndefined();
  });

  it("logs the constraint category on each block (operator observability)", async () => {
    await harness.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: "rm -rf /tmp/x" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    const blocked = harness.captures.loggerInfo.find((m) =>
      /accept-edits gate blocked/.test(m),
    );
    expect(blocked).toBeDefined();
    expect(blocked).toMatch(/constraint=destructive/);
  });

  it("does NOT fire when autoApprove is off + approval is not 'edited' (gate is conditional)", async () => {
    // Fresh harness without autoApprove pre-set.
    const fresh = createHarness({ forceInMemory: true });
    const ret = await fresh.triggerHook(
      "before_tool_call",
      {
        toolName: "Bash",
        params: { command: "rm -rf /tmp/x" },
      },
      { sessionKey: SESSION_KEY, getSessionExtension: () => undefined },
    );
    // Normal mode + no autoApprove: gate skipped, command passes through.
    // (The mutation gate is the layer-1 fail-CLOSED defense; that only
    // fires in plan mode. Layer 2 — accept-edits — is fail-OPEN and only
    // gates the 3 hard categories. So a non-plan-mode session DOES allow
    // rm -rf to pass through the plugin's gates. That's by design.)
    expect(ret[0]).toBeUndefined();
  });
});
