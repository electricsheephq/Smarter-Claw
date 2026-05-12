/**
 * Escalating-retry decision tests.
 *
 * Covers the 3 detectors (PLAN_YIELD, PLAN_ACK_ONLY, PLANNING_RETRY)
 * + their precedence + idempotency-key shape + escalation tiers.
 *
 * Surgical-port S7 (2026-05-12): expanded coverage for the verbatim-
 * ported in-host instruction constants + FIRM/FINAL escalation tiers
 * + nuanced planning-narration regex.
 *
 * Full in-host corpus (59 cases) deferred to live-smoke #3 + a future
 * gateway-side PR; the in-host's `incomplete-turn.ts` 1070-LOC
 * detection pipeline integrates with runner internals (toolMetas,
 * replayMetadata) that the SDK abstracts away.
 *
 * Parity contract:
 *   - Instruction strings are byte-identical to in-host
 *     (incomplete-turn.ts:151-265).
 *   - Regex constants are byte-identical (incomplete-turn.ts:66-74).
 *   - Escalation thresholds match in-host
 *     (DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT = 2,
 *      DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT = 2).
 */

import { describe, expect, it } from "vitest";
import {
  decideEscalatingRetry,
  PLAN_APPROVED_YIELD_RETRY_INSTRUCTION,
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION,
} from "../../src/runtime/escalating-retry.js";
import {
  isPlanningOnlyNarrationText,
  PLANNING_ONLY_RETRY_INSTRUCTION,
  PLANNING_ONLY_RETRY_INSTRUCTION_FINAL,
  PLANNING_ONLY_RETRY_INSTRUCTION_FIRM,
  PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM,
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM,
  resolveEscalatingPlanAckOnlyInstruction,
  resolveEscalatingPlanYieldInstruction,
  resolveEscalatingPlanningRetryInstruction,
} from "../../src/runtime/escalating-retry-constants.js";

const SESSION_KEY = "agent:main:main";

describe("escalating-retry — PLAN_YIELD detector", () => {
  it("fires when post-approval turn yielded with no text + no tool call", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "",
      madeToolCall: false,
      isPostApprovalTurn: true,
    });
    expect(d?.detector).toBe("PLAN_YIELD");
    expect(d?.instruction).toMatch(/\[PLAN_YIELD\]:/);
    // Surgical-port S7: maxAttempts now matches in-host
    // DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT = 2.
    expect(d?.maxAttempts).toBe(2);
  });

  it("attempt 0 → standard instruction (byte-identical to in-host)", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "",
      madeToolCall: false,
      isPostApprovalTurn: true,
      attemptIndex: 0,
    });
    expect(d?.instruction).toBe(PLAN_APPROVED_YIELD_RETRY_INSTRUCTION);
  });

  it("attempt 1+ → firm instruction (escalation)", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "",
      madeToolCall: false,
      isPostApprovalTurn: true,
      attemptIndex: 1,
    });
    expect(d?.instruction).toBe(PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM);
    expect(d?.instruction).toContain("CRITICAL");
  });

  it("does NOT fire when post-approval turn made a tool call", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "",
      madeToolCall: true,
      isPostApprovalTurn: true,
    });
    expect(d).toBeUndefined();
  });

  it("does NOT fire when not a post-approval turn", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });
});

describe("escalating-retry — PLAN_ACK_ONLY detector", () => {
  it("fires in plan mode + chat-only turn", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "plan",
      lastAssistantMessage: "OK I understand, working on it.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d?.detector).toBe("PLAN_ACK_ONLY");
    expect(d?.instruction).toMatch(/\[PLAN_ACK_ONLY\]:/);
    expect(d?.maxAttempts).toBe(2); // DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT
  });

  it("attempt 0 → standard instruction (byte-identical to in-host)", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "plan",
      lastAssistantMessage: "I'm thinking about it.",
      madeToolCall: false,
      isPostApprovalTurn: false,
      attemptIndex: 0,
    });
    expect(d?.instruction).toBe(PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION);
  });

  it("attempt 1+ → firm instruction (escalation)", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "plan",
      lastAssistantMessage: "I'm thinking about it.",
      madeToolCall: false,
      isPostApprovalTurn: false,
      attemptIndex: 1,
    });
    expect(d?.instruction).toBe(PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM);
    expect(d?.instruction).toContain("CRITICAL");
  });

  it("does NOT fire when text matches COMPLETION_RE (e.g. 'done', 'fixed') — surgical-port S7", () => {
    // The in-host's PLANNING_ONLY_COMPLETION_RE guard prevents the
    // retry from firing on "done" / "fixed" / etc. — these signal the
    // agent has ended the work via reasoning, retrying would nag.
    for (const text of [
      "Done.",
      "Fixed the bug.",
      "Verified all paths.",
      "Found the issue.",
      "Implemented the change.",
      "Blocked by missing credentials.",
    ]) {
      const d = decideEscalatingRetry(SESSION_KEY, {
        planMode: "plan",
        lastAssistantMessage: text,
        madeToolCall: false,
        isPostApprovalTurn: false,
      });
      expect(d, `text=${JSON.stringify(text)} should not fire`).toBeUndefined();
    }
  });

  it("does NOT fire in plan mode when a tool call was made", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "plan",
      lastAssistantMessage: "Looking at the files...",
      madeToolCall: true,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });

  it("does NOT fire in plan mode with no assistant text + no tool call (different antipattern)", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "plan",
      lastAssistantMessage: "",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });

  it("does NOT fire when planMode is normal", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "OK I understand.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    // Normal mode + acknowledgment text is fine OR triggers PLANNING_RETRY
    // depending on in-host narration heuristic. "OK I understand" doesn't
    // match PLANNING_ONLY_PROMISE_RE, so no retry.
    expect(d).toBeUndefined();
  });
});

describe("escalating-retry — PLANNING_RETRY detector (in-host regex parity)", () => {
  it("fires on planning narration in normal mode (no tool call) — promise + action verb", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage:
        "I'll start by reading the auth config and then update the schema.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d?.detector).toBe("PLANNING_RETRY");
    expect(d?.instruction).toMatch(/\[PLANNING_RETRY\]:/);
    expect(d?.maxAttempts).toBe(3);
  });

  it("attempt 0 → standard, 1 → firm, 2+ → final (3-tier escalation)", () => {
    const base = {
      planMode: "normal" as const,
      lastAssistantMessage: "I'll read the file then update the schema.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    };
    expect(
      decideEscalatingRetry(SESSION_KEY, { ...base, attemptIndex: 0 })
        ?.instruction,
    ).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
    expect(
      decideEscalatingRetry(SESSION_KEY, { ...base, attemptIndex: 1 })
        ?.instruction,
    ).toBe(PLANNING_ONLY_RETRY_INSTRUCTION_FIRM);
    expect(
      decideEscalatingRetry(SESSION_KEY, { ...base, attemptIndex: 2 })
        ?.instruction,
    ).toBe(PLANNING_ONLY_RETRY_INSTRUCTION_FINAL);
    expect(
      decideEscalatingRetry(SESSION_KEY, { ...base, attemptIndex: 99 })
        ?.instruction,
    ).toBe(PLANNING_ONLY_RETRY_INSTRUCTION_FINAL);
  });

  it("fires on planning starters that pair with an action verb", () => {
    for (const text of [
      "Let me check the config first.",
      "First, I'll read the source.",
      "I will inspect the auth config.",
      "I'm going to investigate the failures.",
    ]) {
      const d = decideEscalatingRetry(SESSION_KEY, {
        planMode: "normal",
        lastAssistantMessage: text,
        madeToolCall: false,
        isPostApprovalTurn: false,
      });
      expect(d?.detector, `text=${JSON.stringify(text)}`).toBe(
        "PLANNING_RETRY",
      );
    }
  });

  it("does NOT fire on promise without action verb (surgical-port S7 — in-host rejects)", () => {
    // "I'll do this" matches PROMISE_RE but "do" is too vague — not
    // in PLANNING_ONLY_ACTION_VERB_RE. In-host returns null; we match.
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "I'll do this thing.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });

  it("does NOT fire when a tool call was made", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "I'll start by reading the config.",
      madeToolCall: true,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });

  it("does NOT fire when message contains a code block (agent IS executing)", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage:
        "I'll execute this:\n```sh\nls -la\n```\nDone.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });

  it("does NOT fire for short non-planning messages", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "Done!",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });

  it("does NOT fire for walls-of-text > 700 chars (in-host PLANNING_ONLY_MAX_VISIBLE_TEXT)", () => {
    // Surgical-port S7: in-host caps at 700 (not 2000). Tightening to
    // match.
    const longText = "I'll start by reading the file. " + "a".repeat(750);
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: longText,
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });

  it("does NOT fire when text matches COMPLETION_RE (e.g. 'done', 'fixed')", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage:
        "I'll just confirm: I fixed the auth bug and verified all paths.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });
});

describe("escalating-retry — detector precedence", () => {
  it("PLAN_YIELD wins over PLAN_ACK_ONLY when both conditions could fire", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "plan",
      lastAssistantMessage: "",
      madeToolCall: false,
      isPostApprovalTurn: true,
    });
    expect(d?.detector).toBe("PLAN_YIELD");
  });

  it("PLAN_ACK_ONLY wins over PLANNING_RETRY when in plan mode", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "plan",
      lastAssistantMessage: "I'll start by reading the file.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d?.detector).toBe("PLAN_ACK_ONLY");
  });
});

describe("escalating-retry — idempotency keys", () => {
  it("key includes sessionKey + detector for host counter scoping", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "plan",
      lastAssistantMessage: "I understand and will proceed.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d?.idempotencyKey).toBe(
      "smarter-claw:PLAN_ACK_ONLY:agent:main:main",
    );
  });

  it("different detectors → different keys (so counters are independent)", () => {
    const a = decideEscalatingRetry(SESSION_KEY, {
      planMode: "plan",
      lastAssistantMessage: "I understand and will proceed.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    const b = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "",
      madeToolCall: false,
      isPostApprovalTurn: true,
    });
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey);
  });

  it("different sessions → different keys (isolation)", () => {
    const a = decideEscalatingRetry("agent:main:main", {
      planMode: "plan",
      lastAssistantMessage: "I will read this.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    const b = decideEscalatingRetry("agent:other:abc", {
      planMode: "plan",
      lastAssistantMessage: "I will read this.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey);
  });
});

describe("escalating-retry — defensive", () => {
  it("returns undefined when no sessionKey", () => {
    const d = decideEscalatingRetry(undefined, {
      planMode: "plan",
      lastAssistantMessage: "I will read this.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });
});

// ===========================================================================
// Surgical-port S7: in-host instruction-tier resolvers (verbatim parity).
// ===========================================================================

describe("resolveEscalatingPlanningRetryInstruction (in-host parity)", () => {
  it("attempt 0 returns the standard instruction", () => {
    expect(resolveEscalatingPlanningRetryInstruction(0)).toBe(
      PLANNING_ONLY_RETRY_INSTRUCTION,
    );
  });

  it("attempt 1 returns the firm instruction", () => {
    expect(resolveEscalatingPlanningRetryInstruction(1)).toBe(
      PLANNING_ONLY_RETRY_INSTRUCTION_FIRM,
    );
  });

  it("attempt 2+ returns the final instruction", () => {
    expect(resolveEscalatingPlanningRetryInstruction(2)).toBe(
      PLANNING_ONLY_RETRY_INSTRUCTION_FINAL,
    );
    expect(resolveEscalatingPlanningRetryInstruction(99)).toBe(
      PLANNING_ONLY_RETRY_INSTRUCTION_FINAL,
    );
  });

  it("negative attempt clamps to standard", () => {
    expect(resolveEscalatingPlanningRetryInstruction(-1)).toBe(
      PLANNING_ONLY_RETRY_INSTRUCTION,
    );
  });
});

describe("resolveEscalatingPlanAckOnlyInstruction (in-host parity)", () => {
  it("attempt 0 → standard, 1+ → firm (2-tier)", () => {
    expect(resolveEscalatingPlanAckOnlyInstruction(0)).toBe(
      PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION,
    );
    expect(resolveEscalatingPlanAckOnlyInstruction(1)).toBe(
      PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM,
    );
    expect(resolveEscalatingPlanAckOnlyInstruction(99)).toBe(
      PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM,
    );
  });
});

describe("resolveEscalatingPlanYieldInstruction (in-host parity)", () => {
  it("attempt 0 → standard, 1+ → firm (2-tier)", () => {
    expect(resolveEscalatingPlanYieldInstruction(0)).toBe(
      PLAN_APPROVED_YIELD_RETRY_INSTRUCTION,
    );
    expect(resolveEscalatingPlanYieldInstruction(1)).toBe(
      PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM,
    );
  });
});

describe("isPlanningOnlyNarrationText (in-host text-only signal)", () => {
  it("returns true for promise + action verb", () => {
    expect(
      isPlanningOnlyNarrationText("I'll inspect the auth config."),
    ).toBe(true);
    expect(
      isPlanningOnlyNarrationText("Let me check the schema first."),
    ).toBe(true);
  });

  it("returns false for empty / undefined / whitespace", () => {
    expect(isPlanningOnlyNarrationText(undefined)).toBe(false);
    expect(isPlanningOnlyNarrationText("")).toBe(false);
    expect(isPlanningOnlyNarrationText("   ")).toBe(false);
  });

  it("returns false for text > PLANNING_ONLY_MAX_VISIBLE_TEXT (700 chars)", () => {
    const long = "I'll inspect the file. " + "x".repeat(800);
    expect(isPlanningOnlyNarrationText(long)).toBe(false);
  });

  it("returns false when code block is present", () => {
    expect(
      isPlanningOnlyNarrationText("I'll check this:\n```sh\nls\n```"),
    ).toBe(false);
  });

  it("returns false when completion-signal is present", () => {
    expect(
      isPlanningOnlyNarrationText(
        "I'll just note I fixed it and verified all paths.",
      ),
    ).toBe(false);
  });

  it("returns true for structured plan format (heading + bullets + promise)", () => {
    const text = [
      "Plan:",
      "- I'll inspect the config",
      "- Then update the schema",
    ].join("\n");
    expect(isPlanningOnlyNarrationText(text)).toBe(true);
  });

  it("returns false when promise but no action verb (in-host's filter)", () => {
    expect(isPlanningOnlyNarrationText("I'll do this thing.")).toBe(false);
  });
});
