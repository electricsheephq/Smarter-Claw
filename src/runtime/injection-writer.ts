/**
 * Plan-mode → pendingAgentInjections writer.
 *
 * **Parity contract**: encodes the WRITE side of the in-host
 * pendingAgentInjections protocol. Counterpart to the READ side in
 * `src/prompt/pending-injections.ts` (P-8) and the decision-text
 * builder in `src/prompt/plan-decision-injection.ts` (P-11).
 *
 * # The SDK seam
 *
 * `api.session.workflow.enqueueNextTurnInjection(injection)` enqueues
 * a synthetic context injection for the next agent turn in a session.
 * The host owns queue management (priority, dedup by idempotencyKey,
 * cap, expiry); we just hand it text + an idempotency key.
 *
 * In-host equivalent: `appendPendingAgentInjection` at
 *   `src/agents/plan-mode/injections.ts` — which writes directly to
 *   `entry.pendingAgentInjections`. The SDK wraps that with a
 *   plugin-attributed enqueue path that adds pluginId + createdAt to
 *   the record and routes the host's drain logic per-plugin.
 *
 * # Idempotency key strategy
 *
 * Different injection kinds have different dedup semantics:
 *
 *   - `plan_decision` resolves a specific approvalId — keyed on
 *     `(approvalId, decision)`. If a user double-clicks Approve, the
 *     second enqueue dedupes via the same key. If they Reject then
 *     Approve (race), DIFFERENT keys → both enqueue (the second
 *     wins by recency at drain time).
 *
 *   - `question_answer` resolves a specific questionId — keyed on
 *     `(questionId)`. Same dedup story; answering twice yields ONE
 *     drained entry.
 *
 *   - `plan_complete` is sessionKey-scoped (one per session-lifetime).
 *
 * The host's `idempotencyKey` is per-plugin-per-session, so we
 * namespace ours with `smarter-claw:plan:<approvalId>:<decision>`
 * etc. to avoid colliding with any future writer.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildPlanDecisionInjection } from "../prompt/plan-decision-injection.js";

/**
 * Enqueue a `[PLAN_DECISION]:` injection. Returns the host's
 * enqueue result (`{ enqueued: boolean, id, sessionKey }`).
 *
 * @param api — the plugin API.
 * @param input — sessionKey + decision + optional feedback + rejectionCount.
 *
 * Idempotency: `smarter-claw:plan_decision:<approvalId>:<decision>`.
 * Approve-then-reject races become two distinct enqueues (DIFFERENT
 * decision string in the key); the agent sees both and the later one
 * wins by drain-time recency.
 *
 * host_ref: src/agents/plan-mode/injections.ts:120-170 (in-host
 *   appendPendingAgentInjection callsites for plan-decision entries).
 */
export async function enqueuePlanDecisionInjection(
  api: OpenClawPluginApi,
  input: {
    sessionKey: string;
    approvalId: string;
    decision: "rejected" | "expired" | "timed_out";
    feedback?: string;
    rejectionCount?: number;
    /** Optional explicit TTL ms. Defaults to host's default. */
    ttlMs?: number;
  },
): Promise<{ enqueued: boolean; id: string; sessionKey: string }> {
  const text = buildPlanDecisionInjection(
    input.decision,
    input.feedback,
    input.rejectionCount,
  );
  const idempotencyKey = `smarter-claw:plan_decision:${input.approvalId}:${input.decision}`;
  return api.session.workflow.enqueueNextTurnInjection({
    sessionKey: input.sessionKey,
    text,
    idempotencyKey,
    // Plan-decision is a USER decision — placed AHEAD of the user's
    // text so the model sees the decision context first. prepend_context
    // is the right placement.
    placement: "prepend_context",
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    metadata: {
      kind: "plan_decision",
      decision: input.decision,
      approvalId: input.approvalId,
      ...(input.rejectionCount !== undefined
        ? { rejectionCount: input.rejectionCount }
        : {}),
    },
  });
}

/**
 * Enqueue a `[PLAN_DECISION]: approved` (or `: edited`) injection.
 *
 * Note: in-host, approved/edited carries the FULL approved-plan
 * preamble (the steps list + "mark cancelled if blocked" instruction).
 * For P-11 we ship the one-line opener; the full preamble lands when
 * the session-action handler at P-12 wires the body.
 *
 * host_ref: src/agents/plan-mode/approval.ts:195-244
 *   (buildApprovedPlanInjection — full body to be ported at P-12).
 */
export async function enqueuePlanApprovedInjection(
  api: OpenClawPluginApi,
  input: {
    sessionKey: string;
    approvalId: string;
    edited?: boolean;
    /** Optional already-built body text (P-12 wiring); defaults to
     *  the bare opener for now. */
    bodyText?: string;
    ttlMs?: number;
  },
): Promise<{ enqueued: boolean; id: string; sessionKey: string }> {
  const decision = input.edited ? "edited" : "approved";
  const opener = `[PLAN_DECISION]: ${decision}`;
  const text = input.bodyText ? `${opener}\n${input.bodyText}` : opener;
  const idempotencyKey = `smarter-claw:plan_decision:${input.approvalId}:${decision}`;
  return api.session.workflow.enqueueNextTurnInjection({
    sessionKey: input.sessionKey,
    text,
    idempotencyKey,
    placement: "prepend_context",
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    metadata: {
      kind: "plan_decision",
      decision,
      approvalId: input.approvalId,
    },
  });
}

/**
 * Enqueue a `[QUESTION_ANSWER]:` injection. The agent's previous
 * turn called `ask_user_question`; the user answered; we drain the
 * answer back to the agent in the next turn.
 *
 * The answer payload is included verbatim — no sanitization needed
 * because the user's choices come from the agent's own pre-defined
 * options list (the only free-form value is the optional "Other..."
 * text input which the SDK validates).
 *
 * @param input.questionId — stable id minted from the tool call so
 *   we can dedup double-answers.
 * @param input.selectedOption — the user's choice (one of the
 *   pre-defined options, or the free-form Other text).
 * @param input.questionPrompt — the original question text (for
 *   the agent's context).
 *
 * host_ref: src/agents/tools/ask-user-question.ts question→answer
 *   wiring (in-host iter-3 D5).
 */
export async function enqueueQuestionAnswerInjection(
  api: OpenClawPluginApi,
  input: {
    sessionKey: string;
    questionId: string;
    questionPrompt: string;
    selectedOption: string;
    ttlMs?: number;
  },
): Promise<{ enqueued: boolean; id: string; sessionKey: string }> {
  const text =
    `[QUESTION_ANSWER]: ${JSON.stringify(input.selectedOption)}\n` +
    `question: ${JSON.stringify(input.questionPrompt)}`;
  const idempotencyKey = `smarter-claw:question_answer:${input.questionId}`;
  return api.session.workflow.enqueueNextTurnInjection({
    sessionKey: input.sessionKey,
    text,
    idempotencyKey,
    placement: "prepend_context",
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    metadata: {
      kind: "question_answer",
      questionId: input.questionId,
    },
  });
}
