/**
 * Ported from openclaw-1: src/agents/plan-mode/plan-mode-debug-log.test.ts
 *
 * Adapted for Smarter-Claw API:
 *   - The Smarter-Claw debug log uses console.error directly (not a
 *     subsystem logger) and emits `[smarter-claw/<kind>]` tags.
 *   - Activation is via OPENCLAW_DEBUG_PLAN_MODE=1 OR
 *     setPlanModeDebugEnabled(true) (called by plugin entry on register).
 *     There is no loadConfig() path / no TTL cache / no
 *     _resetIsPlanModeDebugEnabledCacheForTests export.
 *   - Output format: `[smarter-claw/<kind>] key=value key=value ...`
 *     (positional, not a structured logger call).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPlanModeDebugEnabled,
  logPlanModeDebug,
  setPlanModeDebugEnabled,
} from "../src/debug-log.js";

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // Reset both signals.
  setPlanModeDebugEnabled(false);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.unstubAllEnvs();
  setPlanModeDebugEnabled(false);
});

describe("logPlanModeDebug — env-var gate", () => {
  it("no-op when OPENCLAW_DEBUG_PLAN_MODE unset", () => {
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "");
    logPlanModeDebug({
      kind: "state_transition",
      sessionKey: "session-1",
      from: "plan",
      to: "normal",
      trigger: "user_approval",
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("no-op when OPENCLAW_DEBUG_PLAN_MODE set to value other than '1'", () => {
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "true");
    logPlanModeDebug({
      kind: "state_transition",
      sessionKey: "session-1",
      from: "plan",
      to: "normal",
      trigger: "user_approval",
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("emits when OPENCLAW_DEBUG_PLAN_MODE=1", () => {
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "1");
    logPlanModeDebug({
      kind: "state_transition",
      sessionKey: "session-1",
      from: "plan",
      to: "normal",
      trigger: "user_approval",
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("respects late-set env var (no cached gate)", () => {
    // Disabled at first call.
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "");
    logPlanModeDebug({
      kind: "gate_decision",
      sessionKey: "session-1",
      tool: "edit",
      allowed: false,
      planMode: "plan",
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(0);

    // Enabled mid-process — next call SHOULD fire.
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "1");
    logPlanModeDebug({
      kind: "gate_decision",
      sessionKey: "session-1",
      tool: "edit",
      allowed: false,
      planMode: "plan",
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Adapted: Smarter-Claw uses setPlanModeDebugEnabled(true) instead of a
 * config flag read on every call. The plugin entry calls this on
 * register from the user's pluginConfig.debugLog.
 */
describe("logPlanModeDebug — config-flag gate (setPlanModeDebugEnabled)", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "");
  });

  it("emits when setPlanModeDebugEnabled(true)", () => {
    setPlanModeDebugEnabled(true);
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 0,
      result: "accepted",
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("no-op when setPlanModeDebugEnabled(false)", () => {
    setPlanModeDebugEnabled(false);
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 0,
      result: "accepted",
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("env var WINS over config flag (env=1, config=false → emit)", () => {
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "1");
    setPlanModeDebugEnabled(false);
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 0,
      result: "accepted",
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("isPlanModeDebugEnabled returns true when either signal is on", () => {
    expect(isPlanModeDebugEnabled()).toBe(false);
    setPlanModeDebugEnabled(true);
    expect(isPlanModeDebugEnabled()).toBe(true);
    setPlanModeDebugEnabled(false);
    expect(isPlanModeDebugEnabled()).toBe(false);
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "1");
    expect(isPlanModeDebugEnabled()).toBe(true);
  });
});

describe("logPlanModeDebug — event-kind serialization", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_DEBUG_PLAN_MODE", "1");
  });

  /**
   * Helper: extract the formatted output from the spy. Smarter-Claw uses
   * console.error(parts.join(" ")) so the call gets a single string arg.
   */
  function lastEmittedLine(): string {
    expect(consoleErrorSpy).toHaveBeenCalled();
    const lastCall = consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1];
    return lastCall[0] as string;
  }

  it("state_transition: tag includes kind, line includes from/to/trigger", () => {
    logPlanModeDebug({
      kind: "state_transition",
      sessionKey: "s1",
      from: "normal",
      to: "plan",
      trigger: "enter_plan_mode_tool",
    });
    const line = lastEmittedLine();
    expect(line).toContain("[smarter-claw/state_transition]");
    expect(line).toContain("sessionKey=s1");
    expect(line).toContain("from=normal");
    expect(line).toContain("to=plan");
    expect(line).toContain("trigger=enter_plan_mode_tool");
  });

  it("gate_decision: includes allowed + planMode + optional reason", () => {
    logPlanModeDebug({
      kind: "gate_decision",
      sessionKey: "s1",
      tool: "exec",
      allowed: false,
      planMode: "plan",
      reason: "mutating tool blocked",
    });
    const line = lastEmittedLine();
    expect(line).toContain("[smarter-claw/gate_decision]");
    expect(line).toContain("tool=exec");
    expect(line).toContain("allowed=false");
    expect(line).toContain("planMode=plan");
    // Whitespace-containing values get JSON-stringified.
    expect(line).toContain(`reason="mutating tool blocked"`);
  });

  it("tool_call: includes tool name + runId + details (JSON)", () => {
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey: "s1",
      tool: "exit_plan_mode",
      runId: "run-abc",
      details: { stepCount: 5, title: "test" },
    });
    const line = lastEmittedLine();
    expect(line).toContain("[smarter-claw/tool_call]");
    expect(line).toContain("tool=exit_plan_mode");
    expect(line).toContain("runId=run-abc");
    // Object values get JSON-stringified.
    expect(line).toContain(`details=`);
    expect(line).toContain(`"stepCount":5`);
    expect(line).toContain(`"title":"test"`);
  });

  it("synthetic_injection: includes tag + preview", () => {
    logPlanModeDebug({
      kind: "synthetic_injection",
      sessionKey: "s1",
      tag: "[PLAN_DECISION]",
      preview: "approved",
    });
    const line = lastEmittedLine();
    expect(line).toContain("[smarter-claw/synthetic_injection]");
    expect(line).toContain("tag=");
    expect(line).toContain("[PLAN_DECISION]");
    expect(line).toContain("preview=approved");
  });

  it("nudge_event: includes nudge id + phase", () => {
    logPlanModeDebug({
      kind: "nudge_event",
      sessionKey: "s1",
      nudgeId: "nudge-1",
      phase: "scheduled",
    });
    const line = lastEmittedLine();
    expect(line).toContain("[smarter-claw/nudge_event]");
    expect(line).toContain("nudgeId=nudge-1");
    expect(line).toContain("phase=scheduled");
  });

  it("subagent_event: includes parent + child runIds + event", () => {
    logPlanModeDebug({
      kind: "subagent_event",
      sessionKey: "s1",
      parentRunId: "run-parent",
      childRunId: "run-child",
      event: "spawn",
    });
    const line = lastEmittedLine();
    expect(line).toContain("[smarter-claw/subagent_event]");
    expect(line).toContain("parentRunId=run-parent");
    expect(line).toContain("childRunId=run-child");
    expect(line).toContain("event=spawn");
  });

  it("approval_event: includes action + subagent count + result", () => {
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 2,
      result: "rejected_by_subagent_gate",
    });
    const line = lastEmittedLine();
    expect(line).toContain("[smarter-claw/approval_event]");
    expect(line).toContain("action=approve");
    expect(line).toContain("openSubagentCount=2");
    expect(line).toContain("result=rejected_by_subagent_gate");
  });

  it("approval_event: threads approvalRunId + approvalId for cross-event correlation", () => {
    logPlanModeDebug({
      kind: "approval_event",
      sessionKey: "s1",
      action: "approve",
      openSubagentCount: 0,
      result: "accepted",
      approvalRunId: "run-abc",
      approvalId: "approval-v1",
    });
    const line = lastEmittedLine();
    expect(line).toContain("approvalRunId=run-abc");
    expect(line).toContain("approvalId=approval-v1");
  });

  it("synthetic_injection: accepts approvalRunId + approvalId for cycle correlation", () => {
    logPlanModeDebug({
      kind: "synthetic_injection",
      sessionKey: "s1",
      tag: "[PLAN_DECISION]",
      preview: "approved",
      approvalRunId: "run-abc",
      approvalId: "approval-v1",
    });
    const line = lastEmittedLine();
    expect(line).toContain("approvalRunId=run-abc");
    expect(line).toContain("approvalId=approval-v1");
  });

  it("toast_event: includes toast id + phase", () => {
    logPlanModeDebug({
      kind: "toast_event",
      sessionKey: "s1",
      toast: "subagentBlocking",
      phase: "fired",
    });
    const line = lastEmittedLine();
    expect(line).toContain("[smarter-claw/toast_event]");
    expect(line).toContain("toast=subagentBlocking");
    expect(line).toContain("phase=fired");
  });
});
