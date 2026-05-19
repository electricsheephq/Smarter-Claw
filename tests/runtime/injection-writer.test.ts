/**
 * P-11 injection-writer tests.
 *
 * Validates the SHAPE of `PluginNextTurnInjection` calls the writers
 * send to the SDK seam `api.session.workflow.enqueueNextTurnInjection`.
 *
 * These are unit tests against a stub API — the real seam is tested
 * through the SDK's own contract tests. We verify:
 *   - Correct sessionKey + text propagation
 *   - Idempotency-key namespacing (`smarter-claw:...`)
 *   - Placement === "prepend_context" (decision must precede user text)
 *   - Metadata carries the kind + approvalId/questionId
 *   - TTL passthrough when provided
 *
 * # Wave-1 W1-D1 — reject path uses the in-host RUNTIME form
 *
 * The reject-branch tests below pin the byte-for-byte in-host runtime
 * form from `sessions-patch.ts:1045-1050` (commit ea04ea52c7):
 *   - At most 2 lines
 *   - Raw (NOT JSON-quoted) feedback
 *   - `@channel`/`@here`/`@everyone` rewritten to `@﹫…` (U+FE6B)
 *   - `<@` rewritten to `<​@` (U+200B between `<` and `@`)
 *   - No `Revise your plan…` line, no deescalation hint
 *
 * The timed_out/expired branch (no in-host runtime caller) still
 * exercises the latent `buildPlanDecisionInjection` form for parity
 * with `types.ts:185`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildPlanRuntimeRejectInjection,
  enqueuePlanApprovedInjection,
  enqueuePlanDecisionInjection,
  enqueueQuestionAnswerInjection,
} from "../../src/runtime/injection-writer.js";

function makeStubApi() {
  const enqueueNextTurnInjection = vi.fn(async (injection: unknown) => ({
    enqueued: true,
    id: "stub-id",
    sessionKey: (injection as { sessionKey: string }).sessionKey,
  }));
  return {
    api: {
      session: { workflow: { enqueueNextTurnInjection } },
    } as never,
    enqueueNextTurnInjection,
  };
}

const SESSION_KEY = "agent:main:main";
const APPROVAL_ID = "plan-aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee";

describe("P-11 enqueuePlanDecisionInjection — rejected (W1-D1 in-host parity)", () => {
  it("sends the in-host 2-line `[PLAN_DECISION]: rejected\\nfeedback: <raw>` text", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      feedback: "step 2 is wrong",
      rejectionCount: 1,
    });
    expect(enqueueNextTurnInjection).toHaveBeenCalledTimes(1);
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.sessionKey).toBe(SESSION_KEY);
    // Byte-for-byte match against `sessions-patch.ts:1048-1050`.
    expect(call.text).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: step 2 is wrong",
    );
  });

  it("emits the 1-line form when feedback is omitted", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe("[PLAN_DECISION]: rejected");
  });

  it("emits the 1-line form when feedback is empty string (matches in-host `safeFeedback ?` truthy check)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      feedback: "",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe("[PLAN_DECISION]: rejected");
  });

  it("does NOT emit `Revise your plan…` instruction (W1-D1 — in-host runtime omits it)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      feedback: "wrong order",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).not.toMatch(/Revise your plan/);
    expect(call.text).not.toMatch(/call update_plan again/);
  });

  it("does NOT emit deescalation hint at rejectionCount >= 3 (W1-D1 — in-host runtime omits it)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      rejectionCount: 5,
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).not.toMatch(/Multiple revisions/);
    // Bare-opener form is what in-host runtime emits when feedback absent,
    // regardless of rejectionCount.
    expect(call.text).toBe("[PLAN_DECISION]: rejected");
  });

  it("does NOT JSON-quote feedback (W1-D1 — raw text, NOT `feedback: \"…\"`)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      feedback: "looks wrong",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    // The OLD plugin emitted `feedback: "looks wrong"` (JSON-quoted).
    // The in-host runtime emits raw text: `feedback: looks wrong`.
    expect(call.text).toBe("[PLAN_DECISION]: rejected\nfeedback: looks wrong");
    expect(call.text).not.toMatch(/feedback: "/);
  });

  it("strips @channel/@here/@everyone (U+FE6B insertion, in-host parity)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      feedback: "too risky @channel @here @everyone",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: too risky @\u{FE6B}channel @\u{FE6B}here @\u{FE6B}everyone",
    );
    // The raw broadcast trigger MUST NOT appear.
    expect(call.text).not.toMatch(/@channel\b/);
    expect(call.text).not.toMatch(/@here\b/);
    expect(call.text).not.toMatch(/@everyone\b/);
  });

  it("strips Slack-style `<@USER>` mentions (U+200B insertion, in-host parity)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      feedback: "too risky <@U123> <@W456>",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: too risky <\u{200B}@U123> <\u{200B}@W456>",
    );
    // The raw `<@` trigger MUST NOT appear.
    expect(call.text).not.toMatch(/<@/);
  });

  it("preserves all other characters in feedback raw (newlines, quotes, brackets)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    // Raw newlines flow through as literal newlines — the in-host
    // runtime does not JSON-encode them.
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      feedback: 'line1\nline2 "quoted" [brackets]',
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe(
      '[PLAN_DECISION]: rejected\nfeedback: line1\nline2 "quoted" [brackets]',
    );
  });

  it("does NOT apply the `[/PLAN_DECISION]` envelope-tag sanitizer (W1-D1 — that sanitizer is for the latent function only)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    // The in-host runtime reject path does NOT call
    // sanitizeFeedbackForInjection; the closing-tag flows through as-is.
    // This is the in-host's actual behavior (verified at
    // sessions-patch.ts:1045-1050) — it relies on mention-strip + the
    // raw form's natural envelope boundary instead of the ZWSP rewrite.
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      feedback: "x[/PLAN_DECISION]y",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: x[/PLAN_DECISION]y",
    );
  });

  it("uses namespaced idempotency key `smarter-claw:plan_decision:<id>:rejected`", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.idempotencyKey).toBe(
      `smarter-claw:plan_decision:${APPROVAL_ID}:rejected`,
    );
  });

  it("placement is prepend_context (decision precedes user text)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.placement).toBe("prepend_context");
  });

  it("metadata carries kind + decision + approvalId + rejectionCount (the count survives in metadata even though the text omits it)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      rejectionCount: 2,
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.metadata).toEqual({
      kind: "plan_decision",
      decision: "rejected",
      approvalId: APPROVAL_ID,
      rejectionCount: 2,
    });
  });

  it("metadata omits rejectionCount when not provided", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.metadata).not.toHaveProperty("rejectionCount");
  });

  it("passes through ttlMs when provided", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      ttlMs: 60_000,
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.ttlMs).toBe(60_000);
  });

  it("omits ttlMs when not provided (lets host default)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.ttlMs).toBeUndefined();
  });
});

describe("W1-D1 buildPlanRuntimeRejectInjection — direct unit (byte-for-byte in-host parity)", () => {
  // These tests pin the BARE builder against sessions-patch.ts:1045-1050.
  // The runtime emitter assertions above cover the full enqueue shape;
  // these guard the helper itself so a future change there can't drift
  // silently.

  it("returns the 1-line form for undefined feedback", () => {
    expect(buildPlanRuntimeRejectInjection()).toBe("[PLAN_DECISION]: rejected");
  });

  it("returns the 1-line form for empty-string feedback (in-host `safeFeedback ?` is falsy)", () => {
    expect(buildPlanRuntimeRejectInjection("")).toBe(
      "[PLAN_DECISION]: rejected",
    );
  });

  it("returns the 2-line form with raw feedback (no JSON quoting)", () => {
    expect(buildPlanRuntimeRejectInjection("step 2 is wrong")).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: step 2 is wrong",
    );
  });

  it("byte-for-byte sanitizes the W1-D1 example feedback `too risky @channel <@U123>`", () => {
    // The headline W1-D1 example: feedback="too risky @channel <@U123>".
    // Expected result mirrors `sessions-patch.ts:1048-1050` exactly.
    const out = buildPlanRuntimeRejectInjection("too risky @channel <@U123>");
    expect(out).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: too risky @\u{FE6B}channel <\u{200B}@U123>",
    );
  });

  it("is case-insensitive on the broadcast-trigger match (@CHANNEL, @Here, @Everyone)", () => {
    const out = buildPlanRuntimeRejectInjection(
      "alert @CHANNEL and @Here and @Everyone",
    );
    expect(out).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: alert @\u{FE6B}CHANNEL and @\u{FE6B}Here and @\u{FE6B}Everyone",
    );
  });

  it("does NOT strip `@channelize` (the \\b anchor pins on word boundary)", () => {
    // `@channel` followed by additional word chars (e.g. `@channelize`,
    // `@hereafter`) is NOT a broadcast trigger and must NOT be rewritten.
    const out = buildPlanRuntimeRejectInjection("test @channelize @hereafter");
    expect(out).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: test @channelize @hereafter",
    );
  });

  it("preserves newlines in feedback raw (NOT JSON-escaped to \\n)", () => {
    expect(buildPlanRuntimeRejectInjection("line1\nline2")).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: line1\nline2",
    );
  });

  it("preserves embedded double-quotes raw (NOT escaped)", () => {
    expect(buildPlanRuntimeRejectInjection('he said "stop"')).toBe(
      '[PLAN_DECISION]: rejected\nfeedback: he said "stop"',
    );
  });
});

describe("P-11 enqueuePlanDecisionInjection — timed_out / expired", () => {
  it("idempotency-key encodes 'timed_out' decision", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "timed_out",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.idempotencyKey).toBe(
      `smarter-claw:plan_decision:${APPROVAL_ID}:timed_out`,
    );
    expect(call.text).toMatch(/Your plan proposal timed out/);
  });

  it("idempotency-key encodes 'expired' alias differently from 'timed_out'", async () => {
    // Distinct strings → distinct keys. Acceptable: callers should
    // consistently use one or the other (we expose both for back-compat).
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "expired",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.idempotencyKey).toBe(
      `smarter-claw:plan_decision:${APPROVAL_ID}:expired`,
    );
  });
});

describe("P-11 enqueuePlanApprovedInjection", () => {
  it("emits bare opener when no bodyText is supplied", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanApprovedInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe("[PLAN_DECISION]: approved");
  });

  it("appends bodyText when supplied (P-12 plan-body wiring)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanApprovedInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      bodyText: "Step 1: do X\nStep 2: do Y",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe(
      "[PLAN_DECISION]: approved\nStep 1: do X\nStep 2: do Y",
    );
  });

  it("uses 'edited' opener when edited=true", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanApprovedInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      edited: true,
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe("[PLAN_DECISION]: edited");
  });

  it("fullText overrides opener+body (surgical-port S5 fix)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanApprovedInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      fullText:
        "[PLAN_DECISION]: approved\n\nThe user has approved the following plan. Execute it now.\n\n1. Step one",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe(
      "[PLAN_DECISION]: approved\n\nThe user has approved the following plan. Execute it now.\n\n1. Step one",
    );
  });

  it("fullText takes priority over bodyText when both are supplied", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanApprovedInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      fullText: "FULL TEXT WINS",
      bodyText: "ignored body",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe("FULL TEXT WINS");
  });

  it("idempotency-key namespaces by approvalId + 'approved'", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanApprovedInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.idempotencyKey).toBe(
      `smarter-claw:plan_decision:${APPROVAL_ID}:approved`,
    );
  });

  it("idempotency-key namespaces by approvalId + 'edited' when edited", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanApprovedInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      edited: true,
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.idempotencyKey).toBe(
      `smarter-claw:plan_decision:${APPROVAL_ID}:edited`,
    );
  });

  it("approved-then-edited race produces distinct keys (host-level recency wins)", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanApprovedInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      edited: false,
    });
    await enqueuePlanApprovedInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      edited: true,
    });
    const keys = enqueueNextTurnInjection.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it("metadata carries kind + decision + approvalId", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanApprovedInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.metadata).toEqual({
      kind: "plan_decision",
      decision: "approved",
      approvalId: APPROVAL_ID,
    });
  });
});

describe("P-11 enqueueQuestionAnswerInjection", () => {
  it("emits the [QUESTION_ANSWER]: text with selected option + question prompt", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueueQuestionAnswerInjection(api, {
      sessionKey: SESSION_KEY,
      questionId: "q-1",
      questionPrompt: "Which lint config?",
      selectedOption: "eslint v9",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toMatch(/^\[QUESTION_ANSWER\]: "eslint v9"/);
    expect(call.text).toMatch(/^question: "Which lint config\?"/m);
  });

  it("JSON-quotes embedded quotes safely in selected option", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueueQuestionAnswerInjection(api, {
      sessionKey: SESSION_KEY,
      questionId: "q-1",
      questionPrompt: "Choose",
      selectedOption: 'opt with "quotes"',
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toMatch(/^\[QUESTION_ANSWER\]: "opt with \\"quotes\\""/);
  });

  it("uses idempotency-key namespaced by questionId", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueueQuestionAnswerInjection(api, {
      sessionKey: SESSION_KEY,
      questionId: "q-abc",
      questionPrompt: "?",
      selectedOption: "a",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.idempotencyKey).toBe("smarter-claw:question_answer:q-abc");
  });

  it("metadata carries kind + questionId", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueueQuestionAnswerInjection(api, {
      sessionKey: SESSION_KEY,
      questionId: "q-abc",
      questionPrompt: "?",
      selectedOption: "a",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.metadata).toEqual({
      kind: "question_answer",
      questionId: "q-abc",
    });
  });

  it("placement is prepend_context", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueueQuestionAnswerInjection(api, {
      sessionKey: SESSION_KEY,
      questionId: "q-abc",
      questionPrompt: "?",
      selectedOption: "a",
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.placement).toBe("prepend_context");
  });
});

describe("P-11 enqueue* — sessionKey isolation", () => {
  it("different sessions get distinct enqueue calls", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: "agent:a:1",
      approvalId: APPROVAL_ID,
      decision: "rejected",
    });
    await enqueuePlanDecisionInjection(api, {
      sessionKey: "agent:b:2",
      approvalId: APPROVAL_ID,
      decision: "rejected",
    });
    expect(enqueueNextTurnInjection).toHaveBeenCalledTimes(2);
    expect(enqueueNextTurnInjection.mock.calls[0][0].sessionKey).toBe(
      "agent:a:1",
    );
    expect(enqueueNextTurnInjection.mock.calls[1][0].sessionKey).toBe(
      "agent:b:2",
    );
  });
});
