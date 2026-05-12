/**
 * P-14 debug-log tests.
 *
 * Validates the activation predicate + structured event emission +
 * approval-transition convenience helper.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetDebugFlagCacheForTests,
  isPlanModeDebugEnabled,
  logPlanModeApprovalTransition,
  logPlanModeDebug,
} from "../../src/runtime/debug-log.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

beforeEach(() => {
  _resetDebugFlagCacheForTests();
  delete process.env.OPENCLAW_DEBUG_PLAN_MODE;
});

afterEach(() => {
  _resetDebugFlagCacheForTests();
  delete process.env.OPENCLAW_DEBUG_PLAN_MODE;
});

describe("P-14 debug-log — activation predicate", () => {
  it("returns true when OPENCLAW_DEBUG_PLAN_MODE=1 (env var path)", () => {
    process.env.OPENCLAW_DEBUG_PLAN_MODE = "1";
    expect(isPlanModeDebugEnabled(undefined)).toBe(true);
    expect(isPlanModeDebugEnabled({ debug: false })).toBe(true); // env wins
  });

  it("returns true when pluginConfig.debug === true (config path)", () => {
    expect(isPlanModeDebugEnabled({ debug: true })).toBe(true);
  });

  it("returns false when env unset + pluginConfig is undefined", () => {
    expect(isPlanModeDebugEnabled(undefined)).toBe(false);
  });

  it("returns false when env unset + pluginConfig.debug === false", () => {
    expect(isPlanModeDebugEnabled({ debug: false })).toBe(false);
  });

  it("returns false when env unset + pluginConfig.debug is non-boolean", () => {
    expect(isPlanModeDebugEnabled({ debug: "true" })).toBe(false);
    expect(isPlanModeDebugEnabled({ debug: 1 })).toBe(false);
  });

  it("env var must be the exact string '1' (any other value is off)", () => {
    process.env.OPENCLAW_DEBUG_PLAN_MODE = "0";
    expect(isPlanModeDebugEnabled(undefined)).toBe(false);
    process.env.OPENCLAW_DEBUG_PLAN_MODE = "true";
    _resetDebugFlagCacheForTests();
    expect(isPlanModeDebugEnabled(undefined)).toBe(false);
  });
});

describe("P-14 debug-log — logPlanModeDebug emit", () => {
  it("no-ops when debug disabled (no log call)", () => {
    const logger = makeLogger();
    logPlanModeDebug(logger, undefined, {
      kind: "state_transition",
      sessionKey: "agent:main:main",
      from: "normal",
      to: "plan",
      trigger: "test",
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("emits info-level with [plan-mode/<kind>] tag when enabled (env)", () => {
    process.env.OPENCLAW_DEBUG_PLAN_MODE = "1";
    const logger = makeLogger();
    logPlanModeDebug(logger, undefined, {
      kind: "state_transition",
      sessionKey: "agent:main:main",
      from: "normal",
      to: "plan",
      trigger: "test",
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toMatch(/^\[plan-mode\/state_transition\] /);
  });

  it("emits all event kinds with the right tag", () => {
    process.env.OPENCLAW_DEBUG_PLAN_MODE = "1";
    const logger = makeLogger();
    const events = [
      {
        kind: "gate_decision" as const,
        sessionKey: "k",
        tool: "Edit",
        allowed: false,
        planMode: "plan",
      },
      {
        kind: "tool_call" as const,
        sessionKey: "k",
        tool: "Read",
        mode: "plan",
      },
      {
        kind: "synthetic_injection" as const,
        sessionKey: "k",
        injectionKind: "plan_decision",
      },
      {
        kind: "ui_toast" as const,
        message: "approved",
      },
      {
        kind: "nudge_phase" as const,
        sessionKey: "k",
        phase: "first",
      },
      {
        kind: "subagent_event" as const,
        sessionKey: "k",
        event: "spawn",
      },
    ];
    for (const e of events) {
      logPlanModeDebug(logger, undefined, e);
    }
    const tags = logger.info.mock.calls.map((c) =>
      (c[0] as string).split(" ")[0],
    );
    expect(tags).toEqual([
      "[plan-mode/gate_decision]",
      "[plan-mode/tool_call]",
      "[plan-mode/synthetic_injection]",
      "[plan-mode/ui_toast]",
      "[plan-mode/nudge_phase]",
      "[plan-mode/subagent_event]",
    ]);
  });

  it("meta-string uses sorted keys for deterministic output", () => {
    process.env.OPENCLAW_DEBUG_PLAN_MODE = "1";
    const logger = makeLogger();
    logPlanModeDebug(logger, undefined, {
      kind: "tool_call",
      sessionKey: "k",
      tool: "Read",
      mode: "plan",
      approvalId: "plan-x",
    });
    // Sorted alphabetically (approvalId comes before mode, sessionKey, tool).
    const msg = logger.info.mock.calls[0][0] as string;
    const meta = msg.substring("[plan-mode/tool_call] ".length);
    expect(meta).toBe(
      `approvalId="plan-x" mode="plan" sessionKey="k" tool="Read"`,
    );
  });

  it("drops undefined meta values from the output", () => {
    process.env.OPENCLAW_DEBUG_PLAN_MODE = "1";
    const logger = makeLogger();
    logPlanModeDebug(logger, undefined, {
      kind: "state_transition",
      sessionKey: "k",
      from: "normal",
      to: "plan",
      trigger: "x",
      approvalRunId: undefined, // should not appear in output
      approvalId: undefined,
    });
    const msg = logger.info.mock.calls[0][0] as string;
    expect(msg).not.toMatch(/approvalRunId/);
    expect(msg).not.toMatch(/approvalId/);
  });
});

describe("P-14 debug-log — logPlanModeApprovalTransition", () => {
  beforeEach(() => {
    process.env.OPENCLAW_DEBUG_PLAN_MODE = "1";
  });

  it("emits approval_transition when approval changes", () => {
    const logger = makeLogger();
    logPlanModeApprovalTransition(
      logger,
      undefined,
      "agent:main:main",
      { approval: "pending", approvalId: "plan-a" },
      { approval: "approved", approvalId: "plan-a" },
      "session-actions:accept",
    );
    expect(logger.info).toHaveBeenCalledTimes(1);
    const msg = logger.info.mock.calls[0][0] as string;
    expect(msg).toMatch(/\[plan-mode\/approval_transition\]/);
    expect(msg).toMatch(/from="pending"/);
    expect(msg).toMatch(/to="approved"/);
    expect(msg).toMatch(/trigger="session-actions:accept"/);
  });

  it("emits approval_transition when approvalId changes (cycle rotation)", () => {
    const logger = makeLogger();
    logPlanModeApprovalTransition(
      logger,
      undefined,
      "agent:main:main",
      { approval: "pending", approvalId: "plan-a" },
      { approval: "pending", approvalId: "plan-b" },
      "exit_plan_mode-rotate",
    );
    expect(logger.info).toHaveBeenCalled();
    const msg = logger.info.mock.calls[0][0] as string;
    expect(msg).toMatch(/approvalIdBefore="plan-a"/);
    expect(msg).toMatch(/approvalIdAfter="plan-b"/);
  });

  it("skips emission when neither approval nor approvalId changed (no-op)", () => {
    const logger = makeLogger();
    logPlanModeApprovalTransition(
      logger,
      undefined,
      "agent:main:main",
      { approval: "pending", approvalId: "plan-a" },
      { approval: "pending", approvalId: "plan-a" },
      "trivial-touch",
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("handles undefined prev/next gracefully", () => {
    const logger = makeLogger();
    logPlanModeApprovalTransition(
      logger,
      undefined,
      "agent:main:main",
      undefined,
      { approval: "pending", approvalId: "plan-a" },
      "first-write",
    );
    expect(logger.info).toHaveBeenCalled();
    const msg = logger.info.mock.calls[0][0] as string;
    expect(msg).toMatch(/from="\(absent\)"/);
  });

  it("includes approvalRunId when correlation is provided", () => {
    const logger = makeLogger();
    logPlanModeApprovalTransition(
      logger,
      undefined,
      "agent:main:main",
      { approval: "pending", approvalId: "plan-a" },
      { approval: "approved", approvalId: "plan-a" },
      "x",
      { approvalRunId: "run-123" },
    );
    const msg = logger.info.mock.calls[0][0] as string;
    expect(msg).toMatch(/approvalRunId="run-123"/);
  });

  it("no-ops when debug is disabled (regardless of transition)", () => {
    delete process.env.OPENCLAW_DEBUG_PLAN_MODE;
    _resetDebugFlagCacheForTests();
    const logger = makeLogger();
    logPlanModeApprovalTransition(
      logger,
      undefined,
      "agent:main:main",
      { approval: "pending" },
      { approval: "approved" },
      "x",
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});
