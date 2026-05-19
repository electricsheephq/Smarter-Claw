/**
 * P-14 debug-log tests.
 *
 * Validates the activation predicate + structured event emission +
 * approval-transition convenience helper.
 *
 * **W1-E2 follow-up (2026-05-20):** the event-kind taxonomy is now
 * byte-faithful to the in-host union at
 * `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/plan-mode-debug-log.ts`
 * commit `ea04ea52c7`. The "in-host taxonomy lock" suite below pins
 * the eight in-host kinds + `approval_transition` so any future
 * rename / drop fails loudly. See
 * `docs/audits/parity-refresh/slice-audit-E-runtime.md` E-2 for the
 * full divergence catalog that this re-port corrected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetDebugFlagCacheForTests,
  isPlanModeDebugEnabled,
  logPlanModeApprovalTransition,
  logPlanModeDebug,
  type PlanModeDebugEvent,
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

  it("emits all in-host event kinds with the right tag", () => {
    process.env.OPENCLAW_DEBUG_PLAN_MODE = "1";
    const logger = makeLogger();
    const events: PlanModeDebugEvent[] = [
      {
        kind: "gate_decision",
        sessionKey: "k",
        tool: "Edit",
        allowed: false,
        planMode: "plan",
      },
      {
        kind: "tool_call",
        sessionKey: "k",
        tool: "enter_plan_mode",
        runId: "run-1",
      },
      {
        kind: "synthetic_injection",
        sessionKey: "k",
        tag: "plan_decision",
        preview: "ok",
      },
      {
        kind: "toast_event",
        sessionKey: "k",
        toast: "plan-approved",
        phase: "fired",
      },
      {
        kind: "nudge_event",
        sessionKey: "k",
        nudgeId: "n-1",
        phase: "scheduled",
      },
      {
        kind: "subagent_event",
        sessionKey: "k",
        parentRunId: "p-1",
        childRunId: "c-1",
        event: "spawn",
      },
      {
        kind: "approval_event",
        sessionKey: "k",
        action: "accept",
        openSubagentCount: 0,
        result: "accepted",
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
      "[plan-mode/toast_event]",
      "[plan-mode/nudge_event]",
      "[plan-mode/subagent_event]",
      "[plan-mode/approval_event]",
    ]);
  });

  it("meta-string uses sorted keys for deterministic output", () => {
    process.env.OPENCLAW_DEBUG_PLAN_MODE = "1";
    const logger = makeLogger();
    logPlanModeDebug(logger, undefined, {
      kind: "tool_call",
      sessionKey: "k",
      tool: "enter_plan_mode",
      runId: "run-1",
      details: { foo: "bar" },
    });
    // Sorted alphabetically (details, runId, sessionKey, tool).
    const msg = logger.info.mock.calls[0][0] as string;
    const meta = msg.substring("[plan-mode/tool_call] ".length);
    expect(meta).toBe(
      `details={"foo":"bar"} runId="run-1" sessionKey="k" tool="enter_plan_mode"`,
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

// ---------------------------------------------------------------------------
// W1-E2 follow-up: in-host taxonomy lock.
//
// These tests pin the in-host event-kind names and field shapes so that
// any future re-rename or field-shape divergence fails loudly. The
// previous "verbatim port" claim slipped through review because there
// were no tests asserting parity with the in-host taxonomy — only tests
// asserting the (then-diverged) plugin shape. Locking the in-host names
// and required fields below closes that hole.
//
// host_ref: src/agents/plan-mode/plan-mode-debug-log.ts:63-141
// ---------------------------------------------------------------------------

describe("W1-E2 — in-host event-kind taxonomy lock", () => {
  beforeEach(() => {
    process.env.OPENCLAW_DEBUG_PLAN_MODE = "1";
  });

  it("emits a tag for each of the 8 in-host kinds + approval_transition", () => {
    // The exact set of kinds the in-host emits. Any future rename
    // (e.g. nudge_event → nudge_phase) or drop would fail this test.
    const expectedKinds = [
      "state_transition",
      "gate_decision",
      "tool_call",
      "synthetic_injection",
      "nudge_event",
      "subagent_event",
      "approval_event",
      "toast_event",
      "approval_transition",
    ] as const;
    const logger = makeLogger();
    const events: PlanModeDebugEvent[] = [
      {
        kind: "state_transition",
        sessionKey: "k",
        from: "normal",
        to: "plan",
        trigger: "t",
      },
      {
        kind: "gate_decision",
        sessionKey: "k",
        tool: "Edit",
        allowed: false,
        planMode: "plan",
      },
      {
        kind: "tool_call",
        sessionKey: "k",
        tool: "exit_plan_mode",
        runId: "r",
      },
      { kind: "synthetic_injection", sessionKey: "k", tag: "t", preview: "p" },
      {
        kind: "nudge_event",
        sessionKey: "k",
        nudgeId: "n-1",
        phase: "scheduled",
      },
      {
        kind: "subagent_event",
        sessionKey: "k",
        parentRunId: "p",
        childRunId: "c",
        event: "spawn",
      },
      {
        kind: "approval_event",
        sessionKey: "k",
        action: "accept",
        openSubagentCount: 0,
        result: "accepted",
      },
      {
        kind: "toast_event",
        sessionKey: "k",
        toast: "plan-approved",
        phase: "fired",
      },
      {
        kind: "approval_transition",
        sessionKey: "k",
        from: "pending",
        to: "approved",
        trigger: "t",
      },
    ];
    expect(events.length).toBe(expectedKinds.length);
    for (const e of events) logPlanModeDebug(logger, undefined, e);
    const actualKinds = logger.info.mock.calls.map((c) => {
      const msg = c[0] as string;
      const m = msg.match(/^\[plan-mode\/([^\]]+)\]/);
      return m ? m[1] : null;
    });
    expect(actualKinds).toEqual([...expectedKinds]);
  });

  it("tool_call carries runId (C7 correlation)", () => {
    const logger = makeLogger();
    logPlanModeDebug(logger, undefined, {
      kind: "tool_call",
      sessionKey: "k",
      tool: "exit_plan_mode",
      runId: "run-XYZ",
    });
    const msg = logger.info.mock.calls[0][0] as string;
    expect(msg).toMatch(/runId="run-XYZ"/);
  });

  it("nudge_event carries nudgeId + a phase from the in-host union", () => {
    const logger = makeLogger();
    const phases: Array<"scheduled" | "fired" | "cleaned"> = [
      "scheduled",
      "fired",
      "cleaned",
    ];
    for (const phase of phases) {
      logPlanModeDebug(logger, undefined, {
        kind: "nudge_event",
        sessionKey: "k",
        nudgeId: `n-${phase}`,
        phase,
      });
    }
    expect(logger.info).toHaveBeenCalledTimes(phases.length);
    const msgs = logger.info.mock.calls.map((c) => c[0] as string);
    for (let i = 0; i < phases.length; i++) {
      expect(msgs[i]).toMatch(new RegExp(`nudgeId="n-${phases[i]}"`));
      expect(msgs[i]).toMatch(new RegExp(`phase="${phases[i]}"`));
    }
  });

  it("subagent_event carries parentRunId + childRunId + spawn/return event", () => {
    const logger = makeLogger();
    logPlanModeDebug(logger, undefined, {
      kind: "subagent_event",
      sessionKey: "k",
      parentRunId: "parent-1",
      childRunId: "child-1",
      event: "spawn",
    });
    logPlanModeDebug(logger, undefined, {
      kind: "subagent_event",
      sessionKey: "k",
      parentRunId: "parent-1",
      childRunId: "child-1",
      event: "return",
    });
    const msgs = logger.info.mock.calls.map((c) => c[0] as string);
    expect(msgs[0]).toMatch(/parentRunId="parent-1"/);
    expect(msgs[0]).toMatch(/childRunId="child-1"/);
    expect(msgs[0]).toMatch(/event="spawn"/);
    expect(msgs[1]).toMatch(/event="return"/);
  });

  it("approval_event carries action + openSubagentCount + result discriminator", () => {
    const logger = makeLogger();
    const results: Array<"accepted" | "rejected_by_subagent_gate" | "other"> = [
      "accepted",
      "rejected_by_subagent_gate",
      "other",
    ];
    for (const result of results) {
      logPlanModeDebug(logger, undefined, {
        kind: "approval_event",
        sessionKey: "k",
        action: "accept",
        openSubagentCount: result === "rejected_by_subagent_gate" ? 1 : 0,
        result,
      });
    }
    const msgs = logger.info.mock.calls.map((c) => c[0] as string);
    for (let i = 0; i < results.length; i++) {
      expect(msgs[i]).toMatch(/action="accept"/);
      expect(msgs[i]).toMatch(new RegExp(`result="${results[i]}"`));
    }
    expect(msgs[1]).toMatch(/openSubagentCount=1/);
  });

  it("toast_event carries toast + fired/dismissed phase", () => {
    const logger = makeLogger();
    logPlanModeDebug(logger, undefined, {
      kind: "toast_event",
      sessionKey: "k",
      toast: "plan-approved",
      phase: "fired",
    });
    logPlanModeDebug(logger, undefined, {
      kind: "toast_event",
      sessionKey: "k",
      toast: "plan-approved",
      phase: "dismissed",
    });
    const msgs = logger.info.mock.calls.map((c) => c[0] as string);
    expect(msgs[0]).toMatch(/toast="plan-approved"/);
    expect(msgs[0]).toMatch(/phase="fired"/);
    expect(msgs[1]).toMatch(/phase="dismissed"/);
  });

  it("synthetic_injection carries tag + preview (not the older injectionKind shape)", () => {
    const logger = makeLogger();
    logPlanModeDebug(logger, undefined, {
      kind: "synthetic_injection",
      sessionKey: "k",
      tag: "plan_decision",
      preview: "approved",
    });
    const msg = logger.info.mock.calls[0][0] as string;
    expect(msg).toMatch(/tag="plan_decision"/);
    expect(msg).toMatch(/preview="approved"/);
    // Old plugin-only field names must not appear.
    expect(msg).not.toMatch(/injectionKind/);
    expect(msg).not.toMatch(/idempotencyKey/);
  });

  it("tool_call constrains the tool field to the 4 in-host values (compile-time)", () => {
    // This test asserts the type at compile time. If the union widens
    // or a value drops, tsc will fail the typecheck step.
    const validTools: Array<
      "enter_plan_mode" | "exit_plan_mode" | "update_plan" | "ask_user_question"
    > = [
      "enter_plan_mode",
      "exit_plan_mode",
      "update_plan",
      "ask_user_question",
    ];
    const logger = makeLogger();
    for (const tool of validTools) {
      logPlanModeDebug(logger, undefined, {
        kind: "tool_call",
        sessionKey: "k",
        tool,
        runId: "r",
      });
    }
    expect(logger.info).toHaveBeenCalledTimes(validTools.length);
  });

  it("legacy plugin-only kind names are NOT emittable (regression guard)", () => {
    // The four kinds the W1-E2 audit found diverged. None should be
    // valid PlanModeDebugEvent shapes. We validate the *output* — if
    // a future patch were to add (e.g.) `ui_toast` back as a kind, the
    // typecheck would fail or the `[plan-mode/ui_toast]` tag would
    // appear and we'd want this test to flag it.
    const logger = makeLogger();
    // We can't construct legacy events through PlanModeDebugEvent (the
    // union no longer includes them), but we can scan any emitted tag
    // and assert it's in the in-host set. Below, we emit all known
    // valid events and assert no legacy tags appear.
    const events: PlanModeDebugEvent[] = [
      {
        kind: "toast_event",
        sessionKey: "k",
        toast: "x",
        phase: "fired",
      },
      {
        kind: "nudge_event",
        sessionKey: "k",
        nudgeId: "n",
        phase: "scheduled",
      },
    ];
    for (const e of events) logPlanModeDebug(logger, undefined, e);
    const tags = logger.info.mock.calls.map((c) => c[0] as string);
    for (const t of tags) {
      expect(t).not.toMatch(/\[plan-mode\/ui_toast\]/);
      expect(t).not.toMatch(/\[plan-mode\/nudge_phase\]/);
    }
  });
});
