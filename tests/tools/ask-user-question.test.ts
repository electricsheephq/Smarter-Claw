/**
 * P-8 ask_user_question tool tests.
 *
 * Covers input validation + structured result shape. The full
 * question→answer wiring (pendingAgentInjections write on user reply)
 * lands at P-11 and is exercised by Eva live-smoke #3.
 */

import { describe, expect, it } from "vitest";
import { createAskUserQuestionTool } from "../../src/tools/ask-user-question.js";

const SESSION_KEY = "agent:main:main";

function build() {
  const factory = createAskUserQuestionTool();
  return factory({ sessionKey: SESSION_KEY });
}

describe("P-8 ask_user_question — shape", () => {
  it("name + label set", () => {
    const t = build();
    expect(t.name).toBe("ask_user_question");
    expect(t.label).toBe("Ask User Question");
  });

  it("description mentions clarifying question + 2-6 options + does NOT exit plan mode", () => {
    const t = build();
    expect(t.description).toMatch(/clarifying question/);
    expect(t.description).toMatch(/2-6/);
    expect(t.description).toMatch(/does NOT exit plan mode/i);
  });

  it("description carries the in-host structured clauses (W1-A3 verbatim port)", () => {
    const t = build();
    // The prior paraphrase dropped these; the verbatim in-host
    // description restores the structured guidance.
    expect(t.description).toMatch(/USE FOR:/);
    expect(t.description).toMatch(/DO NOT USE FOR:/);
    expect(t.description).toMatch(/allowFreetext/);
    expect(t.description).toMatch(/\[QUESTION_ANSWER\]:/);
  });

  it("schema enforces additionalProperties: false", () => {
    const t = build();
    const params = t.parameters as { additionalProperties?: boolean };
    expect(params.additionalProperties).toBe(false);
  });
});

describe("P-8 ask_user_question — input validation", () => {
  it("rejects missing question", async () => {
    const t = build();
    const r = await t.execute("call-1", { options: ["a", "b"] });
    expect((r.details as { status: string }).status).toBe("invalid-input");
    expect(r.content[0]?.text).toMatch(/question/i);
  });

  it("rejects empty question", async () => {
    const t = build();
    const r = await t.execute("call-1", { question: "", options: ["a", "b"] });
    expect((r.details as { status: string }).status).toBe("invalid-input");
  });

  it("rejects whitespace-only question", async () => {
    const t = build();
    const r = await t.execute("call-1", {
      question: "   ",
      options: ["a", "b"],
    });
    expect((r.details as { status: string }).status).toBe("invalid-input");
  });

  it("rejects missing options", async () => {
    const t = build();
    const r = await t.execute("call-1", { question: "Q?" });
    expect((r.details as { status: string }).status).toBe("invalid-input");
    expect(r.content[0]?.text).toMatch(/options/);
  });

  it("rejects single-option array", async () => {
    const t = build();
    const r = await t.execute("call-1", { question: "Q?", options: ["only"] });
    expect((r.details as { status: string }).status).toBe("invalid-input");
  });

  it("rejects >6 options (UI cap)", async () => {
    const t = build();
    const r = await t.execute("call-1", {
      question: "Q?",
      options: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect((r.details as { status: string }).status).toBe("invalid-input");
    expect(r.content[0]?.text).toMatch(/at most 6/);
  });

  it("rejects duplicate options (ambiguous routing)", async () => {
    const t = build();
    const r = await t.execute("call-1", {
      question: "Q?",
      options: ["same", "same"],
    });
    expect((r.details as { status: string }).status).toBe("invalid-input");
    expect(r.content[0]?.text).toMatch(/duplicate/i);
  });

  it("trims option whitespace + filters empty options", async () => {
    const t = build();
    const r = await t.execute("call-1", {
      question: "Q?",
      options: ["  opt 1  ", "opt 2", "", "   "],
    });
    // After trimming + filtering empties, we get 2 valid options.
    expect((r.details as { status: string }).status).toBe(
      "question_submitted",
    );
    expect((r.details as { options: string[] }).options).toEqual([
      "opt 1",
      "opt 2",
    ]);
  });
});

describe("P-8 ask_user_question — happy path", () => {
  it("accepts a valid 2-option question", async () => {
    const t = build();
    const r = await t.execute("call-1", {
      question: "Continue?",
      options: ["yes", "no"],
    });
    expect((r.details as { status: string }).status).toBe(
      "question_submitted",
    );
  });

  it("echoes question + options + allowFreetext in details", async () => {
    const t = build();
    const r = await t.execute("call-1", {
      question: "1 PR or 3?",
      options: ["1 PR", "3 PRs", "depends"],
      allowFreetext: true,
    });
    const details = r.details as {
      question: string;
      options: string[];
      allowFreetext: boolean;
    };
    expect(details.question).toBe("1 PR or 3?");
    expect(details.options).toEqual(["1 PR", "3 PRs", "depends"]);
    expect(details.allowFreetext).toBe(true);
  });

  it("defaults allowFreetext to false", async () => {
    const t = build();
    const r = await t.execute("call-1", {
      question: "Q?",
      options: ["a", "b"],
    });
    const details = r.details as { allowFreetext: boolean };
    expect(details.allowFreetext).toBe(false);
  });

  it("questionId is deterministic from toolCallId (cache stability)", async () => {
    const t = build();
    const r1 = await t.execute("stable-call-id", {
      question: "Q?",
      options: ["a", "b"],
    });
    const r2 = await t.execute("stable-call-id", {
      question: "Q?",
      options: ["a", "b"],
    });
    expect((r1.details as { questionId: string }).questionId).toBe(
      (r2.details as { questionId: string }).questionId,
    );
    expect((r1.details as { questionId: string }).questionId).toBe(
      "q-stable-call-id",
    );
  });

  it("text content summarizes the question + option count", async () => {
    const t = build();
    const r = await t.execute("call-1", {
      question: "Pick one",
      options: ["a", "b", "c"],
    });
    expect(r.content[0]?.text).toMatch(/Question submitted to user.*Pick one.*3 options/);
  });
});
