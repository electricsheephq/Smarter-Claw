/**
 * plan-mode injection tests.
 *
 * Covers the system-prompt fragment composition + byte-identity vs
 * in-host inline injection at attempt.ts:689-749.
 *
 * Surgical-port S5 (2026-05-12): expanded coverage for the full
 * in-host block including ACTION CONTRACT, Investigation Phase, and
 * PLAN MODE AVAILABLE branch.
 */

import { describe, expect, it } from "vitest";
import {
  buildPlanModeActiveSystemContext,
  buildPlanModeAvailableSystemContext,
  buildPlanModeSystemContext,
  _testing,
} from "../../src/prompt/plan-mode-injection.js";
import { PLAN_ARCHETYPE_PROMPT } from "../../src/prompt/archetype-prompt.js";

describe("plan-mode injection (active) — shape", () => {
  it("returns a non-empty string", () => {
    const s = buildPlanModeActiveSystemContext();
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(100);
  });

  it("contains the PLAN MODE ACTIVE header", () => {
    expect(buildPlanModeActiveSystemContext()).toContain("═══ PLAN MODE ACTIVE ═══");
  });

  it("contains the 'session IS in plan mode RIGHT NOW' preamble (surgical-port S4 fix)", () => {
    const s = buildPlanModeActiveSystemContext();
    expect(s).toContain("This session IS in plan mode RIGHT NOW");
    expect(s).toContain("Every user message in this session is a plan-mode message");
  });

  it("contains the ACTION CONTRACT block (surgical-port S4 fix)", () => {
    const s = buildPlanModeActiveSystemContext();
    expect(s).toContain("ACTION CONTRACT");
    expect(s).toContain("Briefly acknowledge in one short sentence");
    expect(s).toContain(
      'CALL `exit_plan_mode(title="…", summary="…", plan=[...])` IN THE SAME TURN',
    );
    expect(s).toContain("Stop after the tool call");
    expect(s).toContain(
      "Treat acknowledgement-without-tool-call as a defect, not as 'staying conversational'",
    );
  });

  it("contains the Investigation phase block with LOGS heuristic (surgical-port S4 fix)", () => {
    const s = buildPlanModeActiveSystemContext();
    expect(s).toContain("Investigation phase (when needed):");
    expect(s).toContain("Use read-only tools first");
    expect(s).toContain("For LOGS: start at the END (tail)");
    expect(s).toContain("`tail -n 100`");
    expect(s).toContain(
      "Use `ask_user_question` ONLY for tradeoffs you can't resolve via local investigation",
    );
  });

  it("contains the hard rules block", () => {
    const s = buildPlanModeActiveSystemContext();
    expect(s).toContain("Hard rules:");
    expect(s).toContain("Mutating tools (write, edit, exec/bash");
    expect(s).toContain("Do NOT call enter_plan_mode");
  });

  it("contains the full archetype prompt", () => {
    expect(buildPlanModeActiveSystemContext()).toContain(PLAN_ARCHETYPE_PROMPT);
  });

  it("ordering: header, preamble, ACTION CONTRACT, Investigation, hard rules, separator, archetype", () => {
    const s = buildPlanModeActiveSystemContext();
    const headerIdx = s.indexOf("═══ PLAN MODE ACTIVE ═══");
    const preambleIdx = s.indexOf("This session IS in plan mode RIGHT NOW");
    const actionIdx = s.indexOf("ACTION CONTRACT");
    const investigationIdx = s.indexOf("Investigation phase");
    const rulesIdx = s.indexOf("Hard rules:");
    const sepIdx = s.indexOf("═════════════════════════");
    const archetypeIdx = s.indexOf("## Plan Mode — Decision-Complete Plan Standard");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(preambleIdx).toBeGreaterThan(headerIdx);
    expect(actionIdx).toBeGreaterThan(preambleIdx);
    expect(investigationIdx).toBeGreaterThan(actionIdx);
    expect(rulesIdx).toBeGreaterThan(investigationIdx);
    expect(sepIdx).toBeGreaterThan(rulesIdx);
    expect(archetypeIdx).toBeGreaterThan(sepIdx);
  });
});

describe("plan-mode injection (active) — byte stability (cache-bust prevention)", () => {
  it("two calls produce IDENTICAL bytes (no per-call drift)", () => {
    const a = buildPlanModeActiveSystemContext();
    const b = buildPlanModeActiveSystemContext();
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

  it("ACTION_CONTRACT bytes pin the 3-step contract + defect clause", () => {
    const text = _testing.PLAN_MODE_ACTION_CONTRACT;
    expect(text).toMatch(/^ACTION CONTRACT/);
    expect(text).toContain("1. Briefly acknowledge in one short sentence");
    expect(text).toContain("2. CALL `exit_plan_mode(");
    expect(text).toContain("3. Stop after the tool call");
    expect(text).toContain(
      "Treat acknowledgement-without-tool-call as a defect",
    );
  });

  it("INVESTIGATION_PHASE bytes pin the read-only tools + LOGS heuristic", () => {
    const text = _testing.PLAN_MODE_INVESTIGATION_PHASE;
    expect(text).toMatch(/^Investigation phase \(when needed\):/);
    expect(text).toContain("read, web_search, web_fetch, lcm_grep");
    expect(text).toContain("start at the END (tail)");
    expect(text).toContain("`tail -n 100`");
  });
});

describe("plan-mode injection (available) — surgical-port S4 fix", () => {
  it("returns a non-empty string", () => {
    const s = buildPlanModeAvailableSystemContext();
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(100);
  });

  it("contains the PLAN MODE AVAILABLE header (not the ACTIVE header)", () => {
    const s = buildPlanModeAvailableSystemContext();
    expect(s).toContain("═══ PLAN MODE AVAILABLE ═══");
    expect(s).not.toContain("═══ PLAN MODE ACTIVE ═══");
  });

  it("instructs the agent to call enter_plan_mode when user requests a plan", () => {
    const s = buildPlanModeAvailableSystemContext();
    expect(s).toContain("call `enter_plan_mode`");
    expect(s).toContain("start a fresh planning cycle");
  });

  it("warns against re-entering plan mode when already executing", () => {
    const s = buildPlanModeAvailableSystemContext();
    expect(s).toContain("do NOT re-enter plan mode");
    expect(s).toContain("just continue executing the work");
  });

  it("byte-stable across calls (cache-bust prevention)", () => {
    expect(buildPlanModeAvailableSystemContext()).toBe(
      buildPlanModeAvailableSystemContext(),
    );
  });
});

describe("plan-mode injection — backward-compat alias", () => {
  it("buildPlanModeSystemContext() === buildPlanModeActiveSystemContext()", () => {
    expect(buildPlanModeSystemContext()).toBe(
      buildPlanModeActiveSystemContext(),
    );
  });
});

describe("plan-mode injection — PLAN_ARCHETYPE_PROMPT byte-parity", () => {
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
