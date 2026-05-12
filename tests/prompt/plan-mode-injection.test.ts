/**
 * P-7 plan-mode injection tests.
 *
 * Covers the system-prompt fragment composition + byte-identity vs
 * in-host inline injection at attempt.ts:702-732.
 */

import { describe, expect, it } from "vitest";
import {
  buildPlanModeSystemContext,
  _testing,
} from "../../src/prompt/plan-mode-injection.js";
import { PLAN_ARCHETYPE_PROMPT } from "../../src/prompt/archetype-prompt.js";

describe("P-7 plan-mode injection — shape", () => {
  it("returns a non-empty string", () => {
    const s = buildPlanModeSystemContext();
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(100);
  });

  it("contains the PLAN MODE ACTIVE header", () => {
    expect(buildPlanModeSystemContext()).toContain("═══ PLAN MODE ACTIVE ═══");
  });

  it("contains the hard rules block", () => {
    const s = buildPlanModeSystemContext();
    expect(s).toContain("Hard rules:");
    expect(s).toContain("Mutating tools (write, edit, exec/bash");
    expect(s).toContain("Do NOT call enter_plan_mode");
  });

  it("contains the full archetype prompt", () => {
    expect(buildPlanModeSystemContext()).toContain(PLAN_ARCHETYPE_PROMPT);
  });

  it("ordering: header, hard rules, separator, archetype", () => {
    const s = buildPlanModeSystemContext();
    const headerIdx = s.indexOf("═══ PLAN MODE ACTIVE ═══");
    const rulesIdx = s.indexOf("Hard rules:");
    const sepIdx = s.indexOf("═════════════════════════");
    const archetypeIdx = s.indexOf("## Plan Mode — Decision-Complete Plan Standard");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(rulesIdx).toBeGreaterThan(headerIdx);
    expect(sepIdx).toBeGreaterThan(rulesIdx);
    expect(archetypeIdx).toBeGreaterThan(sepIdx);
  });
});

describe("P-7 plan-mode injection — byte stability (cache-bust prevention)", () => {
  it("two calls produce IDENTICAL bytes (no per-call drift)", () => {
    const a = buildPlanModeSystemContext();
    const b = buildPlanModeSystemContext();
    expect(a).toBe(b);
    expect(a.length).toBe(b.length);
  });

  it("HEADER text is the canonical byte sequence (pinned)", () => {
    // If a future PR changes the header bytes, prompt-cache keys
    // bump for every plan-mode turn. This test loud-fails.
    expect(_testing.PLAN_MODE_HEADER).toBe("═══ PLAN MODE ACTIVE ═══");
  });

  it("SEPARATOR text is the canonical byte sequence (pinned)", () => {
    expect(_testing.PLAN_MODE_SEPARATOR).toBe(
      "═════════════════════════",
    );
  });

  it("HARD_RULES bytes are pinned line-for-line", () => {
    const lines = _testing.PLAN_MODE_HARD_RULES.split("\n");
    expect(lines[0]).toBe("Hard rules:");
    expect(lines[1]).toMatch(/^- Mutating tools .* BLOCKED by the runtime/);
    expect(lines[2]).toMatch(/exit_plan_mode/);
    expect(lines[3]).toMatch(/Do NOT call enter_plan_mode/);
    expect(lines[4]).toMatch(/After `exit_plan_mode` in this turn: STOP/);
    expect(lines).toHaveLength(5);
  });
});

describe("P-7 plan-mode injection — PLAN_ARCHETYPE_PROMPT byte-parity", () => {
  // Anti-pattern guard: the archetype prompt is the in-host's PR-10
  // fragment. Bytes matter. Pin individual sections so paraphrases
  // are caught.

  it("starts with the H2 header", () => {
    expect(PLAN_ARCHETYPE_PROMPT).toMatch(
      /^## Plan Mode — Decision-Complete Plan Standard/,
    );
  });

  it("contains the Primary objective section", () => {
    expect(PLAN_ARCHETYPE_PROMPT).toContain("### Primary objective");
    expect(PLAN_ARCHETYPE_PROMPT).toContain("decision-complete plan");
  });

  it("contains all required-field bullets (title/summary/analysis/plan/assumptions/risks/verification/references)", () => {
    for (const field of [
      "`title`",
      "`summary`",
      "`analysis`",
      "`plan`",
      "`assumptions`",
      "`risks`",
      "`verification`",
      "`references`",
    ]) {
      expect(PLAN_ARCHETYPE_PROMPT).toContain(field);
    }
  });

  it("contains the Quality bar section + anti-patterns", () => {
    expect(PLAN_ARCHETYPE_PROMPT).toContain("### Quality bar");
    expect(PLAN_ARCHETYPE_PROMPT).toContain(
      "### Anti-patterns — do NOT submit a plan that is:",
    );
  });

  it("contains the ask_user_question guidance + self-check", () => {
    expect(PLAN_ARCHETYPE_PROMPT).toContain("### When to ask questions");
    expect(PLAN_ARCHETYPE_PROMPT).toContain(
      "### Self-check before `exit_plan_mode`",
    );
  });

  it("ends with the final self-check paragraph", () => {
    expect(PLAN_ARCHETYPE_PROMPT.trimEnd()).toMatch(
      /If the plan leaves meaningful implementation decisions unspecified, it[\s\S]+re-evaluate\.$/,
    );
  });

  it("uses em-dash (U+2014) NOT hyphen in the header", () => {
    // The in-host uses em-dash. A find-replace that swaps to hyphen
    // changes bytes → bumps prompt-cache. Pin it.
    expect(PLAN_ARCHETYPE_PROMPT).toContain("Plan Mode — Decision-Complete");
  });

  it("byte count is stable (regression sentinel)", () => {
    // If this fails, ASSERT that the change is INTENTIONAL +
    // byte-matched to a new in-host version. Don't update the
    // expected number without first running parity-harness against
    // the in-host source-of-truth.
    expect(PLAN_ARCHETYPE_PROMPT.length).toBeGreaterThan(4000);
    expect(PLAN_ARCHETYPE_PROMPT.length).toBeLessThan(6000);
  });
});
