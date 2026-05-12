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
 */

import { describe, expect, it, vi } from "vitest";
import {
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

describe("P-11 enqueuePlanDecisionInjection — rejected", () => {
  it("sends the [PLAN_DECISION]: rejected text", async () => {
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
    expect(call.text).toMatch(/^\[PLAN_DECISION\]: rejected/);
    expect(call.text).toMatch(/feedback: "step 2 is wrong"/);
    expect(call.text).toMatch(/Revise your plan/);
  });

  it("emits the deescalation hint at rejectionCount >= 3", async () => {
    const { api, enqueueNextTurnInjection } = makeStubApi();
    await enqueuePlanDecisionInjection(api, {
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      decision: "rejected",
      rejectionCount: 3,
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toMatch(/Multiple revisions have been rejected/);
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

  it("metadata carries kind + decision + approvalId", async () => {
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
