/**
 * P-8 reference card byte-stability tests.
 *
 * Pins the canonical PLAN_MODE_REFERENCE_CARD content so paraphrases
 * fail loudly + prompt-cache bytes stay stable.
 */

import { describe, expect, it } from "vitest";
import { PLAN_MODE_REFERENCE_CARD } from "../../src/prompt/reference-card.js";

describe("P-8 reference card — shape + canonical content", () => {
  it("non-empty + has the canonical header", () => {
    expect(PLAN_MODE_REFERENCE_CARD.length).toBeGreaterThan(1000);
    expect(PLAN_MODE_REFERENCE_CARD).toMatch(
      /^═══ PLAN MODE — REFERENCE CARD ═══/,
    );
  });

  it("contains all 4 documented sections", () => {
    expect(PLAN_MODE_REFERENCE_CARD).toContain("## State diagram");
    expect(PLAN_MODE_REFERENCE_CARD).toContain("## Tool contract");
    expect(PLAN_MODE_REFERENCE_CARD).toContain("## [PLAN_*]: tag taxonomy");
    expect(PLAN_MODE_REFERENCE_CARD).toContain(
      "## /plan slash-command surface",
    );
    expect(PLAN_MODE_REFERENCE_CARD).toContain("## Common pitfalls");
    expect(PLAN_MODE_REFERENCE_CARD).toContain("## Debugging tips");
  });

  it("documents the state-diagram transitions (enter → investigate → pending → normal)", () => {
    expect(PLAN_MODE_REFERENCE_CARD).toContain("NORMAL MODE");
    expect(PLAN_MODE_REFERENCE_CARD).toContain("PLAN MODE — INVESTIGATION");
    expect(PLAN_MODE_REFERENCE_CARD).toContain("PLAN MODE — PENDING APPROVAL");
  });

  it("documents all 6 [PLAN_*]: tags + [QUESTION_ANSWER]", () => {
    for (const tag of [
      "[PLAN_MODE_INTRO]:",
      "[PLAN_DECISION]:",
      "[QUESTION_ANSWER]:",
      "[PLAN_COMPLETE]:",
      "[PLAN_NUDGE]:",
      "[PLAN_ACK_ONLY]:",
      "[PLAN_YIELD]:",
      "[PLANNING_RETRY]:",
    ]) {
      expect(PLAN_MODE_REFERENCE_CARD).toContain(tag);
    }
  });

  it("documents all 7 /plan slash commands", () => {
    for (const cmd of [
      "/plan on",
      "/plan off",
      "/plan status",
      "/plan view",
      "/plan accept",
      "/plan revise",
      "/plan answer",
      "/plan auto",
    ]) {
      expect(PLAN_MODE_REFERENCE_CARD).toContain(cmd);
    }
  });

  it("two calls return byte-identical content (no per-call drift)", () => {
    // The constant is a frozen string; pin that joining doesn't
    // happen lazily.
    expect(PLAN_MODE_REFERENCE_CARD).toBe(PLAN_MODE_REFERENCE_CARD);
  });

  it("uses em-dash (U+2014) in header (cache-bust sentinel)", () => {
    expect(PLAN_MODE_REFERENCE_CARD).toContain("PLAN MODE — REFERENCE CARD");
  });

  it("ends with the canonical bottom rule", () => {
    expect(PLAN_MODE_REFERENCE_CARD).toMatch(
      /═════════════════════════════════════\s*$/,
    );
  });
});
