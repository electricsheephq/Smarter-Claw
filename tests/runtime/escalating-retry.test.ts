/**
 * P-10 escalating-retry decision tests.
 *
 * Covers the 3 detectors (PLAN_YIELD, PLAN_ACK_ONLY, PLANNING_RETRY)
 * + their precedence + idempotency-key shape.
 *
 * Full corpus (59 host-internal cases) deferred to Eva live-smoke #3
 * + a P-10.5 follow-up; the in-host's `incomplete-turn.ts` 1070-LOC
 * detection pipeline integrates with runner internals that the
 * SDK abstracts away.
 */

import { describe, expect, it } from "vitest";
import { decideEscalatingRetry } from "../../src/runtime/escalating-retry.js";

const SESSION_KEY = "agent:main:main";

describe("P-10 escalating-retry — PLAN_YIELD detector", () => {
  it("fires when post-approval turn yielded with no text + no tool call", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "",
      madeToolCall: false,
      isPostApprovalTurn: true,
    });
    expect(d?.detector).toBe("PLAN_YIELD");
    expect(d?.instruction).toMatch(/\[PLAN_YIELD\]:/);
    expect(d?.maxAttempts).toBe(3);
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

  it("does NOT fire when post-approval turn emitted text + tool call", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: "Starting execution",
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

describe("P-10 escalating-retry — PLAN_ACK_ONLY detector", () => {
  it("fires in plan mode + chat-only turn", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "plan",
      lastAssistantMessage: "OK I understand, working on it.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d?.detector).toBe("PLAN_ACK_ONLY");
    expect(d?.instruction).toMatch(/\[PLAN_ACK_ONLY\]:/);
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
    // Empty turn in plan mode is its own bug; PLAN_ACK_ONLY requires
    // actual chat. (PLAN_YIELD covers the post-approval-empty case.)
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
    // depending on planning-narration heuristic. "OK I understand" doesn't
    // match planning-narration starters, so undefined.
    expect(d).toBeUndefined();
  });
});

describe("P-10 escalating-retry — PLANNING_RETRY detector", () => {
  it("fires on planning narration in normal mode (no tool call)", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage:
        "I'll start by reading the auth config and then update the schema.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d?.detector).toBe("PLANNING_RETRY");
    expect(d?.instruction).toMatch(/\[PLANNING_RETRY\]:/);
  });

  it("fires on multiple planning starters", () => {
    for (const text of [
      "I'll do this thing.",
      "I will start with the easy bit.",
      "Let me check the config first.",
      "First, I'll read the source.",
      "Here's my plan: walk the tree.",
      "My plan is to refactor",
      "The plan involves three steps.",
    ]) {
      const d = decideEscalatingRetry(SESSION_KEY, {
        planMode: "normal",
        lastAssistantMessage: text,
        madeToolCall: false,
        isPostApprovalTurn: false,
      });
      expect(d?.detector).toBe("PLANNING_RETRY");
    }
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

  it("does NOT fire when message ends with a question (it's a clarifying question)", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage:
        "I'll do X, but should I also do Y?",
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

  it("does NOT fire for walls-of-text (>2000 chars; likely substantive)", () => {
    const longText =
      "I'll start by " + "a".repeat(2100);
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "normal",
      lastAssistantMessage: longText,
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });
});

describe("P-10 escalating-retry — detector precedence", () => {
  it("PLAN_YIELD wins over PLAN_ACK_ONLY when both conditions could fire", () => {
    // Post-approval turn + plan mode + chat without tool call: this
    // is exactly the PLAN_YIELD specific case. PLAN_YIELD's empty-text
    // condition wins by being more specific.
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

describe("P-10 escalating-retry — idempotency keys", () => {
  it("key includes sessionKey + detector for host counter scoping", () => {
    const d = decideEscalatingRetry(SESSION_KEY, {
      planMode: "plan",
      lastAssistantMessage: "I understand.",
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
      lastAssistantMessage: "I understand.",
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
      lastAssistantMessage: "I will do this.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    const b = decideEscalatingRetry("agent:other:abc", {
      planMode: "plan",
      lastAssistantMessage: "I will do this.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey);
  });
});

describe("P-10 escalating-retry — defensive", () => {
  it("returns undefined when no sessionKey", () => {
    const d = decideEscalatingRetry(undefined, {
      planMode: "plan",
      lastAssistantMessage: "I will do this.",
      madeToolCall: false,
      isPostApprovalTurn: false,
    });
    expect(d).toBeUndefined();
  });
});
