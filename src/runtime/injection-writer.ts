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
 *
 * # Wave-1 W1-D1 — reject path uses the in-host RUNTIME form
 *
 * The runtime reject path (the live emitter for `plan.reject`) builds
 * the injection inline in the in-host at `sessions-patch.ts:1045-1050`
 * — a thin 2-line form with raw (NOT JSON-quoted) feedback and Slack-
 * style `@channel`/`<@U…>` mention-stripping. `buildPlanDecisionInjection`
 * (in-host `types.ts:185`) is NOT the runtime emitter — it has zero
 * non-test callers in the in-host tree. The plugin previously wired
 * `buildPlanDecisionInjection` as the live reject emitter, producing
 * extra instruction lines + JSON-quoted feedback + a different sanitizer.
 *
 * `buildPlanRuntimeRejectInjection` below ports the in-host runtime
 * reject form byte-for-byte. `buildPlanDecisionInjection` remains
 * exported (mirroring its in-host latent status) for parity-test pinning
 * but is no longer wired into the runtime reject path.
 *
 * host_ref: src/gateway/sessions-patch.ts:1043-1056 — the in-host
 *   runtime reject emit site (commit ea04ea52c7).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildPlanDecisionInjection } from "../prompt/plan-decision-injection.js";

/**
 * Sanitize user-supplied feedback for safe embedding in the runtime
 * reject injection. Byte-faithful port of the in-host sanitizer at
 * `sessions-patch.ts:1045-1047`:
 *
 *   1. `@(channel|here|everyone)\b` → `@﹫$1` (U+FE6B SMALL
 *      COMMERCIAL AT before the keyword) — neutralizes the Slack /
 *      Discord broadcast trigger while keeping the text visually
 *      recognizable in audit logs.
 *   2. `<@` → `<​@` (U+200B ZERO WIDTH SPACE inserted between
 *      `<` and `@`) — neutralizes `<@U123>` user-mention syntax
 *      similarly.
 *
 * This is DIFFERENT from `sanitizeFeedbackForInjection` in
 * `src/helpers/sanitize.ts`, which neutralizes the
 * `[/PLAN_DECISION]` envelope-closing tag (the in-host's runtime
 * reject path does NOT JSON-quote the feedback, so the envelope-tag
 * sanitizer is not applied here — newlines flow through raw).
 *
 * host_ref: src/gateway/sessions-patch.ts:1045-1047 (commit ea04ea52c7).
 */
function sanitizeRuntimeRejectFeedback(raw: string): string {
  return raw
    .replace(/@(channel|here|everyone)\b/gi, "@\u{FE6B}$1")
    .replace(/<@/g, "<\u{200B}@");
}

/**
 * Build the in-host runtime reject injection — the byte-for-byte port
 * of `sessions-patch.ts:1048-1050`. At most 2 lines:
 *
 *   `[PLAN_DECISION]: rejected`
 *   `feedback: <raw, mention-stripped text>`    (only if feedback truthy)
 *
 * Feedback is NOT JSON-quoted — embedded newlines flow through as
 * literal newlines (the in-host runtime accepts this; the model reads
 * the multi-line form as the user's literal feedback).
 *
 * host_ref: src/gateway/sessions-patch.ts:1045-1050 (commit ea04ea52c7).
 */
export function buildPlanRuntimeRejectInjection(feedback?: string): string {
  const safeFeedback = sanitizeRuntimeRejectFeedback(feedback ?? "");
  return safeFeedback
    ? `[PLAN_DECISION]: rejected\nfeedback: ${safeFeedback}`
    : `[PLAN_DECISION]: rejected`;
}

/**
 * Enqueue a `[PLAN_DECISION]:` injection. Returns the host's
 * enqueue result (`{ enqueued: boolean, id, sessionKey }`).
 *
 * @param api — the plugin API.
 * @param input — sessionKey + decision + optional feedback + rejectionCount.
 *
 * # Reject branch — in-host runtime parity (Wave-1 W1-D1)
 *
 * For `decision === "rejected"` the injection text is the in-host
 * runtime form from `sessions-patch.ts:1048-1050`: at most 2 lines,
 * raw (NOT JSON-quoted) feedback, with `@channel`/`@here`/`@everyone`
 * + `<@` mention-stripping. `rejectionCount` is NOT consumed by the
 * text builder (the in-host runtime omits the deescalation hint; the
 * count survives only as injection metadata so callers can still
 * observe the cycle).
 *
 * # Timed_out / expired branch — latent capability
 *
 * In-host has NO runtime emitter for `[PLAN_DECISION]: timed_out` —
 * `resolvePlanApproval(action: "timeout")` flips state but does not
 * appendToInjectionQueue. We retain the wire-format here (via the
 * latent `buildPlanDecisionInjection`) so a future timed_out runtime
 * caller has a parity-pinned target; today this branch has no
 * production caller.
 *
 * Idempotency: `smarter-claw:plan_decision:<approvalId>:<decision>`.
 * Approve-then-reject races become two distinct enqueues (DIFFERENT
 * decision string in the key); the agent sees both and the later one
 * wins by drain-time recency.
 *
 * host_ref: src/gateway/sessions-patch.ts:1043-1062 — the in-host
 *   runtime reject emit site (commit ea04ea52c7).
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
  // Reject path uses the in-host RUNTIME form (sessions-patch.ts:1045-1050).
  // The latent `buildPlanDecisionInjection` is in-host `types.ts:185` and
  // has zero non-test callers there — we preserve it as a parity mirror
  // for the timed_out/expired branches but NOT for the runtime reject.
  const text =
    input.decision === "rejected"
      ? buildPlanRuntimeRejectInjection(input.feedback)
      : buildPlanDecisionInjection(
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
 * Three ways to specify the injection content (in priority order):
 *
 *   1. `fullText` — caller has already built the complete injection
 *      text (e.g. via `buildApprovedPlanInjection(planSteps)` which
 *      includes the opener + preamble + step list). Used by plan.accept
 *      and plan.edit handlers to emit the full in-host-parity preamble.
 *
 *   2. `bodyText` — caller supplies just the body; we prepend
 *      `[PLAN_DECISION]: <decision>\n` automatically. Used by callers
 *      that have user-typed text to splice in (e.g. inline-edited
 *      plan body).
 *
 *   3. Neither — emit the bare one-line opener `[PLAN_DECISION]: approved`.
 *      Fallback for tests / harness paths that don't need the preamble.
 *
 * # In-host parity (surgical-port S5)
 *
 * The in-host emits the FULL `buildApprovedPlanInjection(planSteps)`
 * text — opener + "The user has approved..." + step list. The bare
 * opener path was a plugin shortcut that dropped the agent's
 * execution-guidance preamble. plan.accept now uses `fullText` with
 * the full preamble; the bare-opener path remains as a fallback only.
 *
 * host_ref: src/agents/plan-mode/approval.ts:185-238
 *   (buildApprovedPlanInjection + buildAcceptEditsPlanInjection)
 */
export async function enqueuePlanApprovedInjection(
  api: OpenClawPluginApi,
  input: {
    sessionKey: string;
    approvalId: string;
    edited?: boolean;
    /** Complete pre-built injection text (highest priority). Use this
     *  to emit `buildApprovedPlanInjection(planSteps)` etc. */
    fullText?: string;
    /** Optional body text; we prepend the `[PLAN_DECISION]:` opener.
     *  Used by inline-edit callers that have user-typed plan text. */
    bodyText?: string;
    ttlMs?: number;
  },
): Promise<{ enqueued: boolean; id: string; sessionKey: string }> {
  const decision = input.edited ? "edited" : "approved";
  const opener = `[PLAN_DECISION]: ${decision}`;
  let text: string;
  if (input.fullText !== undefined) {
    text = input.fullText;
  } else if (input.bodyText !== undefined) {
    text = `${opener}\n${input.bodyText}`;
  } else {
    text = opener;
  }
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
