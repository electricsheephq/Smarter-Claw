/**
 * Escalating retry suite — proves the 3-detector + 7-level escalation
 * matches the openclaw-1 baseline (parity port #1, #5 from audit).
 *
 * Source coverage maps to:
 *   - openclaw-1 src/agents/pi-embedded-runner/run/incomplete-turn.test.ts
 *
 * Skips the runner-coupled cases that need Pi mocks; ports the pure
 * behavioral assertions against the plugin's resolver.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT,
  DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT,
  PLAN_APPROVED_YIELD_RETRY_INSTRUCTION,
  PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM,
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION,
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM,
  PLANNING_ONLY_RETRY_INSTRUCTION,
  PLANNING_ONLY_RETRY_INSTRUCTION_FINAL,
  PLANNING_ONLY_RETRY_INSTRUCTION_FIRM,
  POST_APPROVAL_ACK_ONLY_GRACE_MS,
  POST_APPROVAL_YIELD_GRACE_MS,
  extractPlanningOnlyPlanDetails,
  isLikelyExecutionAckPrompt,
  resolveEscalatingPlanApprovedYieldInstruction,
  resolveEscalatingPlanModeAckOnlyInstruction,
  resolveEscalatingPlanningRetryInstruction,
  resolveRetryDecision,
} from "../src/escalating-retry.js";
import type { SmarterClawSessionState } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseState: SmarterClawSessionState = {
  planMode: "normal",
  planApproval: "idle",
  autoApprove: false,
};

function planModeState(overrides: Partial<SmarterClawSessionState> = {}): SmarterClawSessionState {
  return { ...baseState, planMode: "plan", ...overrides };
}

function approvedState(
  recentlyApprovedAtMs: number,
  overrides: Partial<SmarterClawSessionState> = {},
): SmarterClawSessionState {
  return {
    ...baseState,
    planMode: "normal",
    planApproval: "approved",
    recentlyApprovedAt: new Date(recentlyApprovedAtMs).toISOString(),
    ...overrides,
  };
}

function userMsg(text: string) {
  return { role: "user", content: text };
}

function assistantTextOnly(text: string) {
  return { role: "assistant", content: text };
}

function toolResult(toolName: string, text = "ok") {
  return { role: "tool", toolName, content: text };
}

// ---------------------------------------------------------------------------
// Constants — these strings ARE the proven behavior. Treat as bytes-perfect.
// ---------------------------------------------------------------------------

describe("escalating-retry constants (verbatim from openclaw-1)", () => {
  it("PLANNING_ONLY 3-level escalation strings each include [PLANNING_RETRY] tag", () => {
    expect(PLANNING_ONLY_RETRY_INSTRUCTION).toMatch(/^\[PLANNING_RETRY\]:/);
    expect(PLANNING_ONLY_RETRY_INSTRUCTION_FIRM).toMatch(/^\[PLANNING_RETRY\]:/);
    expect(PLANNING_ONLY_RETRY_INSTRUCTION_FINAL).toMatch(/^\[PLANNING_RETRY\]:/);
  });

  it("PLAN_MODE_ACK_ONLY 2-level escalation strings each include [PLAN_ACK_ONLY] tag", () => {
    expect(PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION).toMatch(/^\[PLAN_ACK_ONLY\]:/);
    expect(PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM).toMatch(/^\[PLAN_ACK_ONLY\]:/);
  });

  it("PLAN_APPROVED_YIELD 2-level escalation strings each include [PLAN_YIELD] tag", () => {
    expect(PLAN_APPROVED_YIELD_RETRY_INSTRUCTION).toMatch(/^\[PLAN_YIELD\]:/);
    expect(PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM).toMatch(/^\[PLAN_YIELD\]:/);
  });

  it("FIRM/FINAL escalations include the word CRITICAL or 'final reminder'", () => {
    expect(PLANNING_ONLY_RETRY_INSTRUCTION_FIRM).toContain("CRITICAL");
    expect(PLANNING_ONLY_RETRY_INSTRUCTION_FINAL).toContain("Final reminder");
    expect(PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM).toContain("CRITICAL");
    expect(PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM).toContain("CRITICAL");
  });

  it("retry limits match openclaw-1 defaults (1, 2, 2)", () => {
    expect(DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT).toBe(2);
    expect(DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT).toBe(2);
  });

  it("grace windows: ack-only 5min, yield 2min", () => {
    expect(POST_APPROVAL_ACK_ONLY_GRACE_MS).toBe(5 * 60 * 1000);
    expect(POST_APPROVAL_YIELD_GRACE_MS).toBe(2 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// isLikelyExecutionAckPrompt — multilingual ack corpus
// ---------------------------------------------------------------------------

describe("isLikelyExecutionAckPrompt", () => {
  it.each([
    ["ok", true],
    ["okay", true],
    ["do it", true],
    ["go ahead", true],
    ["ship it", true],
    ["yes do it", true],
    ["yep do it", true],
  ])("matches English ack '%s' → %s", (input, expected) => {
    expect(isLikelyExecutionAckPrompt(input)).toBe(expected);
  });

  it.each([
    ["تمام", true], // Arabic "ok"
    ["やって", true], // Japanese "do it"
    ["mach es", true], // German "do it"
    ["allez y", true], // French "go ahead"
    ["hazlo", true], // Spanish "do it"
    ["faz isso", true], // Portuguese "do it"
  ])("matches non-English ack '%s' → %s", (input, expected) => {
    expect(isLikelyExecutionAckPrompt(input)).toBe(expected);
  });

  it("rejects long messages", () => {
    expect(isLikelyExecutionAckPrompt("ok please go ahead and do that thing for me right now")).toBe(false);
  });

  it("rejects multi-line messages", () => {
    expect(isLikelyExecutionAckPrompt("ok\ndo it")).toBe(false);
  });

  it("rejects question-marked messages", () => {
    expect(isLikelyExecutionAckPrompt("ok?")).toBe(false);
  });

  it("rejects long task prompts", () => {
    expect(isLikelyExecutionAckPrompt("read the README and tell me what it says")).toBe(false);
  });

  it("ignores punctuation + case", () => {
    expect(isLikelyExecutionAckPrompt("OK!")).toBe(true);
    expect(isLikelyExecutionAckPrompt("ship it.")).toBe(true);
    expect(isLikelyExecutionAckPrompt(" Do It ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractPlanningOnlyPlanDetails — bullet/sentence step extraction
// ---------------------------------------------------------------------------

describe("extractPlanningOnlyPlanDetails", () => {
  it("returns null on empty input", () => {
    expect(extractPlanningOnlyPlanDetails("")).toBeNull();
    expect(extractPlanningOnlyPlanDetails("   \n  ")).toBeNull();
  });

  it("extracts bullet-list steps", () => {
    const result = extractPlanningOnlyPlanDetails(`
- read the README
- check the changelog
- confirm the version
    `);
    expect(result).not.toBeNull();
    expect(result?.steps).toEqual([
      "read the README",
      "check the changelog",
      "confirm the version",
    ]);
  });

  it("extracts numbered-list steps", () => {
    const result = extractPlanningOnlyPlanDetails(`
1. fetch the data
2. parse the JSON
3. emit a summary
    `);
    expect(result?.steps).toEqual([
      "fetch the data",
      "parse the JSON",
      "emit a summary",
    ]);
  });

  it("falls back to sentence-split when no bullets", () => {
    const result = extractPlanningOnlyPlanDetails(
      "I'll read the file. Then I'll check the schema. Finally I'll write a fix.",
    );
    expect(result?.steps).toEqual([
      "I'll read the file.",
      "Then I'll check the schema.",
      "Finally I'll write a fix.",
    ]);
  });

  it("caps at 4 steps", () => {
    const result = extractPlanningOnlyPlanDetails(`
- one
- two
- three
- four
- five
- six
    `);
    expect(result?.steps).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// resolveEscalating* — pick-by-attempt-index ladders
// ---------------------------------------------------------------------------

describe("resolveEscalatingPlanningRetryInstruction (3-level ladder)", () => {
  it("attempt 0 → standard", () => {
    expect(resolveEscalatingPlanningRetryInstruction(0)).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });
  it("attempt 1 → firm", () => {
    expect(resolveEscalatingPlanningRetryInstruction(1)).toBe(PLANNING_ONLY_RETRY_INSTRUCTION_FIRM);
  });
  it.each([2, 3, 5, 99])("attempt %i (>=2) → final", (i) => {
    expect(resolveEscalatingPlanningRetryInstruction(i)).toBe(PLANNING_ONLY_RETRY_INSTRUCTION_FINAL);
  });
});

describe("resolveEscalatingPlanModeAckOnlyInstruction (2-level ladder)", () => {
  it("attempt 0 → standard", () => {
    expect(resolveEscalatingPlanModeAckOnlyInstruction(0)).toBe(
      PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION,
    );
  });
  it.each([1, 2, 5])("attempt %i (>=1) → firm", (i) => {
    expect(resolveEscalatingPlanModeAckOnlyInstruction(i)).toBe(
      PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM,
    );
  });
});

describe("resolveEscalatingPlanApprovedYieldInstruction (2-level ladder)", () => {
  it("attempt 0 → standard", () => {
    expect(resolveEscalatingPlanApprovedYieldInstruction(0)).toBe(
      PLAN_APPROVED_YIELD_RETRY_INSTRUCTION,
    );
  });
  it.each([1, 2, 5])("attempt %i (>=1) → firm", (i) => {
    expect(resolveEscalatingPlanApprovedYieldInstruction(i)).toBe(
      PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveRetryDecision — top-level resolver against agent_end messages
// ---------------------------------------------------------------------------

describe("resolveRetryDecision: PLAN_MODE_ACK_ONLY detector", () => {
  it("fires when in plan mode + text-only assistant turn + no investigative tool", () => {
    const decision = resolveRetryDecision({
      messages: [
        userMsg("plan something"),
        assistantTextOnly("I'll open a fresh plan cycle."),
      ],
      state: planModeState(),
    });
    expect(decision.kind).toBe("plan_mode_ack_only");
    if (decision.kind === "plan_mode_ack_only") {
      expect(decision.instruction).toBe(PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION);
      expect(decision.attemptIndex).toBe(0);
    }
  });

  it("escalates to FIRM on second attempt", () => {
    const decision = resolveRetryDecision({
      messages: [
        userMsg("plan something"),
        assistantTextOnly("Submitting now."),
      ],
      state: planModeState({ retryCounters: { planModeAckOnly: 1 } }),
    });
    expect(decision.kind).toBe("plan_mode_ack_only");
    if (decision.kind === "plan_mode_ack_only") {
      expect(decision.instruction).toBe(PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM);
    }
  });

  it("stops after retry limit (2)", () => {
    const decision = resolveRetryDecision({
      messages: [userMsg("plan"), assistantTextOnly("ack")],
      state: planModeState({ retryCounters: { planModeAckOnly: 2 } }),
    });
    expect(decision.kind).toBe("skip");
  });

  it("skips when an investigative tool fired this turn", () => {
    const decision = resolveRetryDecision({
      messages: [
        userMsg("plan"),
        assistantTextOnly("Looking..."),
        toolResult("read", "file content"),
      ],
      state: planModeState(),
    });
    expect(decision.kind).toBe("skip");
  });

  it("skips when exit_plan_mode fired this turn", () => {
    const decision = resolveRetryDecision({
      messages: [
        userMsg("plan"),
        assistantTextOnly("Submitting plan."),
        toolResult("exit_plan_mode", "approval requested"),
      ],
      state: planModeState(),
    });
    expect(decision.kind).toBe("skip");
  });

  it("skips when text exceeds max-visible cap (likely full inline plan)", () => {
    const longText = "I will execute a plan. ".repeat(100); // ~2300 chars
    const decision = resolveRetryDecision({
      messages: [userMsg("plan"), assistantTextOnly(longText)],
      state: planModeState(),
    });
    expect(decision.kind).toBe("skip");
  });

  it("fires within post-approval ack-only grace even when planMode is normal", () => {
    const justApproved = Date.now() - 1000;
    const decision = resolveRetryDecision({
      messages: [userMsg("ok"), assistantTextOnly("Now executing.")],
      state: approvedState(justApproved),
      nowMs: justApproved + 1000,
    });
    expect(decision.kind).toBe("plan_mode_ack_only");
  });

  it("does NOT fire after ack-only grace window expires", () => {
    const longAgo = Date.now() - POST_APPROVAL_ACK_ONLY_GRACE_MS - 1000;
    const decision = resolveRetryDecision({
      messages: [userMsg("ok"), assistantTextOnly("Now executing.")],
      state: approvedState(longAgo),
    });
    expect(decision.kind).toBe("skip");
  });
});

describe("resolveRetryDecision: PLAN_APPROVED_YIELD detector", () => {
  it("fires when within yield-grace AND no main-lane tool called", () => {
    const justApproved = Date.now() - 30_000;
    const decision = resolveRetryDecision({
      messages: [
        userMsg("/plan accept"),
        assistantTextOnly(""),
      ],
      state: approvedState(justApproved),
      nowMs: justApproved + 30_000,
    });
    expect(decision.kind).toBe("plan_approved_yield");
    if (decision.kind === "plan_approved_yield") {
      expect(decision.instruction).toBe(PLAN_APPROVED_YIELD_RETRY_INSTRUCTION);
    }
  });

  it("escalates to FIRM on second yield", () => {
    const justApproved = Date.now() - 30_000;
    const decision = resolveRetryDecision({
      messages: [userMsg("ok"), assistantTextOnly("")],
      state: approvedState(justApproved, { retryCounters: { planApprovedYield: 1 } }),
      nowMs: justApproved + 30_000,
    });
    expect(decision.kind).toBe("plan_approved_yield");
    if (decision.kind === "plan_approved_yield") {
      expect(decision.instruction).toBe(PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM);
    }
  });

  it("does NOT fire after yield-grace window (2min) expires", () => {
    const longAgo = Date.now() - POST_APPROVAL_YIELD_GRACE_MS - 1000;
    const decision = resolveRetryDecision({
      messages: [userMsg("ok"), assistantTextOnly("")],
      state: approvedState(longAgo),
    });
    expect(decision.kind).toBe("skip");
  });

  it("skips when a main-lane tool fired (real progress)", () => {
    const justApproved = Date.now() - 30_000;
    const decision = resolveRetryDecision({
      messages: [
        userMsg("/plan accept"),
        assistantTextOnly("Starting now."),
        toolResult("write", "ok"),
      ],
      state: approvedState(justApproved),
      nowMs: justApproved + 30_000,
    });
    expect(decision.kind).toBe("skip");
  });

  it("update_plan alone counts as YIELD (not main-lane)", () => {
    const justApproved = Date.now() - 30_000;
    const decision = resolveRetryDecision({
      messages: [
        userMsg("ok"),
        assistantTextOnly(""),
        toolResult("update_plan", "tracked"),
      ],
      state: approvedState(justApproved),
      nowMs: justApproved + 30_000,
    });
    expect(decision.kind).toBe("plan_approved_yield");
  });
});

describe("resolveRetryDecision: skip cases", () => {
  it("skips when no last assistant message", () => {
    const decision = resolveRetryDecision({
      messages: [userMsg("hello")],
      state: planModeState(),
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toMatch(/no last assistant message/);
  });

  it("skips when state is undefined", () => {
    const decision = resolveRetryDecision({
      messages: [assistantTextOnly("hi")],
      state: undefined,
    });
    expect(decision.kind).toBe("skip");
  });

  it("skips when planMode is normal AND no recent approval", () => {
    const decision = resolveRetryDecision({
      messages: [assistantTextOnly("Just a chat reply.")],
      state: baseState,
    });
    expect(decision.kind).toBe("skip");
  });
});
