/**
 * P-8 pending-injections compose tests.
 *
 * Byte-identical contract with in-host
 * `src/agents/plan-mode/injections.ts:347-360`. Three test cases mirror
 * the in-host injections.test.ts's `composePromptWithPendingInjections`
 * suite at lines 197-228.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_INJECTION_PRIORITY,
  MAX_QUEUE_SIZE,
  composePromptWithPendingInjections,
  type PendingAgentInjectionEntry,
} from "../../src/prompt/pending-injections.js";

const mk = (
  kind: PendingAgentInjectionEntry["kind"],
  text: string,
  createdAt = 1_000,
  extras: Partial<PendingAgentInjectionEntry> = {},
): PendingAgentInjectionEntry => ({
  id: `id-${kind}-${createdAt}`,
  kind,
  text,
  createdAt,
  ...extras,
});

describe("P-8 pending-injections — composePromptWithPendingInjections", () => {
  it("empty injections → returns userPrompt unchanged", () => {
    expect(composePromptWithPendingInjections([], "do the thing")).toBe(
      "do the thing",
    );
  });

  it("non-empty injections + userPrompt → joins with two newlines", () => {
    const entries = [mk("plan_decision", "[PLAN_DECISION]: approved")];
    expect(composePromptWithPendingInjections(entries, "next")).toBe(
      "[PLAN_DECISION]: approved\n\nnext",
    );
  });

  it("empty userPrompt → returns preamble alone (no trailing newlines)", () => {
    const entries = [mk("plan_decision", "[PLAN_DECISION]: approved")];
    expect(composePromptWithPendingInjections(entries, "")).toBe(
      "[PLAN_DECISION]: approved",
    );
  });

  it("whitespace-only userPrompt → returns preamble alone (trimmed)", () => {
    const entries = [mk("plan_decision", "[PLAN_DECISION]: approved")];
    expect(composePromptWithPendingInjections(entries, "   \n  ")).toBe(
      "[PLAN_DECISION]: approved",
    );
  });

  it("multiple injections joined with two newlines between each", () => {
    const entries = [
      mk("plan_decision", "[PLAN_DECISION]: approved"),
      mk("question_answer", "[QUESTION_ANSWER]: option 2", 1100),
    ];
    expect(composePromptWithPendingInjections(entries, "next")).toBe(
      "[PLAN_DECISION]: approved\n\n[QUESTION_ANSWER]: option 2\n\nnext",
    );
  });

  it("trims leading/trailing whitespace on userPrompt", () => {
    const entries = [mk("plan_decision", "[PLAN_DECISION]: approved")];
    expect(composePromptWithPendingInjections(entries, "  hi  \n")).toBe(
      "[PLAN_DECISION]: approved\n\nhi",
    );
  });

  it("preserves preamble bytes exactly (no escaping, no transformation)", () => {
    const entries = [mk("plan_decision", "[PLAN_DECISION]: approved\n  with newline")];
    const result = composePromptWithPendingInjections(entries, "next");
    expect(result).toBe(
      "[PLAN_DECISION]: approved\n  with newline\n\nnext",
    );
  });
});

describe("P-8 pending-injections — type contract", () => {
  it("DEFAULT_INJECTION_PRIORITY has 6 entries with the documented kinds", () => {
    const keys = Object.keys(DEFAULT_INJECTION_PRIORITY).sort();
    expect(keys).toEqual(
      [
        "plan_complete",
        "plan_decision",
        "plan_intro",
        "plan_nudge",
        "question_answer",
        "subagent_return",
      ].sort(),
    );
  });

  it("plan_decision has the highest priority (drains first on approve)", () => {
    expect(DEFAULT_INJECTION_PRIORITY.plan_decision).toBe(10);
    expect(DEFAULT_INJECTION_PRIORITY.plan_decision).toBeGreaterThan(
      DEFAULT_INJECTION_PRIORITY.plan_complete,
    );
    expect(DEFAULT_INJECTION_PRIORITY.plan_decision).toBeGreaterThan(
      DEFAULT_INJECTION_PRIORITY.question_answer,
    );
  });

  it("MAX_QUEUE_SIZE is 10 (matches in-host)", () => {
    expect(MAX_QUEUE_SIZE).toBe(10);
  });
});
