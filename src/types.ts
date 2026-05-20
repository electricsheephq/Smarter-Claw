/**
 * Plan-Mode public types.
 *
 * **Parity contract**: this file mirrors
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/plan-mode/types.ts`
 * at commit `ea04ea52c7`. Every type below has a `host_ref:` comment
 * pointing at the in-host line range it mirrors. Per the plan's
 * Guardrail #1: `host_ref: TBD` → PR not ready.
 *
 * Schema policy: additive-only for v1.x. Breaking changes require a
 * `__schemaVersion` bump (P-3 wires the stamping). Old session-extension
 * payloads must remain readable after a plugin upgrade.
 *
 * Design notes — Plan Mode UX (from in-host header at lines 4-43):
 *
 *   Plan mode is opt-in. When active, mutation tools are blocked until
 *   the user approves the agent's plan.
 *
 *   After rejection the agent stays in plan mode (fail-closed). The
 *   user's decision is delivered as a structured context injection at
 *   the start of the next agent turn — NOT a system message, NOT a
 *   tool result.
 *
 *   Web/desktop UI: persistent "Plan Mode Active" banner. Actions:
 *   [Approve], [Edit] (inline-edit = approval), [Reject + Feedback],
 *   [Exit Plan Mode].
 *
 *   Messaging channels (Telegram/Discord/Slack): [Approve][Reject]
 *   buttons; rejection + next message = feedback for revision.
 */

/**
 * Plan-mode high-level mode. Just two values:
 * - `"plan"`: mutations blocked, agent must propose a plan and get
 *   approval before doing real work.
 * - `"normal"`: default; mutations allowed.
 *
 * host_ref: `src/agents/plan-mode/types.ts:42`
 */
export type PlanMode = "plan" | "normal";

/**
 * Approval lifecycle states. NOT the same as PlanMode — a session can
 * be in `mode: "plan"` with several different approval states as the
 * user reviews / rejects / approves / times out.
 *
 * `"none"`: no plan proposed yet (default in plan mode immediately
 *   after `enter_plan_mode`).
 * `"pending"`: plan proposed via `exit_plan_mode`, waiting for user
 *   decision.
 * `"approved"`: user clicked Approve. Session transitions back to
 *   `mode: "normal"` and mutations resume.
 * `"edited"`: user inline-edited the plan and submitted. Counts as
 *   approval; session transitions to `mode: "normal"`.
 * `"rejected"`: user clicked Reject (with or without feedback).
 *   Session stays in plan mode; agent revises.
 * `"timed_out"`: timer expired with no decision. Session stays in
 *   plan mode; agent may re-propose when user returns.
 *
 * host_ref: `src/agents/plan-mode/types.ts:44-51`
 */
export type PlanApprovalState =
  | "none"
  | "pending"
  | "approved"
  | "edited"
  | "rejected"
  | "timed_out";

/**
 * Single step within a plan. Mirrors the shape that `update_plan` and
 * `exit_plan_mode` emit.
 *
 * - `step`: the imperative description of the work (e.g. "Bump
 *   eslint to 9.x").
 * - `status`: lifecycle state of the step. The in-host runtime
 *   normalizes status enums; we mirror the same set.
 * - `activeForm`: present-continuous version of `step` (e.g.
 *   "Bumping eslint to 9.x"). Used by some UI surfaces.
 *
 * host_ref: shape derived from
 *   `src/agents/pi-embedded-subscribe.handlers.tools.ts:148,1870-1874`
 *   (`lastPlanSteps: Array<{ step, status, activeForm? }>`)
 */
export interface PlanStep {
  step: string;
  status: string;
  activeForm?: string;
}

/**
 * Persisted pending `ask_user_question` state. Mirrors the in-host
 * `PendingInteraction` union's `kind: "question"` variant
 * (`src/config/sessions/types.ts:113-124` at commit `ea04ea52c7`),
 * but plugin-side and pruned to what the plugin actually needs to
 * resolve a `/plan answer <text>` cross-surface dispatch.
 *
 * # Why the plugin needs this (W1-F5)
 *
 * In-host: `ask_user_question` tool fires → runtime emits a
 * `kind: "plugin"` approval event → gateway's
 * `plan-snapshot-persister.ts:184-209` writes
 * `entry.pendingInteraction = { kind: "question", approvalId,
 * questionId, ... }`. `/plan answer` in
 * `src/auto-reply/reply/commands-plan.ts:312-318` reads
 * `liveSessionEntry.pendingInteraction.approvalId/questionId` and
 * dispatches `sessions.patch { planApproval: { action: "answer",
 * answer, approvalId, questionId } }`.
 *
 * In the plugin: the host's `pendingInteraction` is host-owned —
 * the plugin cannot write it (the runtime fields belong to the
 * plan-snapshot-persister, which subscribes to the `approval`
 * stream that is `bundled-plugin-only`; see
 * `docs/audits/parity-refresh/blocker-W1-F1.md` §2). So the
 * plugin stores its OWN question-state under
 * `pluginExtensions["smarter-claw"]["plan-mode"].pendingQuestion`,
 * written by the `ask_user_question` tool body directly. The plugin
 * never reads the host's `pendingInteraction` and never claims to.
 *
 * # Lifecycle
 *
 * - WRITE: by `ask_user_question` tool's `execute()` body on a
 *   `status: "question_submitted"` result, AFTER the tool's input
 *   validation passes. The `questionId` is the deterministic
 *   `q-${toolCallId}` (already minted on line 135 of
 *   `src/tools/ask-user-question.ts`).
 * - READ: by the `/plan answer` slash-command handler in
 *   `src/ui/slash-commands.ts` — looks up
 *   `store.readSnapshot(sessionKey).pendingQuestion` and uses the
 *   `questionId` + `questionPrompt` to build the `plan.answer`
 *   session-action payload.
 * - CLEAR: cleared on (a) successful `plan.answer` dispatch
 *   (idempotency — answering twice should be a no-op), (b)
 *   `exit_plan_mode` (the question is implicitly resolved when the
 *   agent proceeds to propose a plan), (c) `cancelPlanMode` /
 *   `exitPlanMode` (state reset).
 *
 * # Idempotency invariant
 *
 * Answering an already-answered question must be a no-op, not a
 * duplicate inject. Implementation: the `/plan answer` handler
 * checks `pendingQuestion` is present BEFORE dispatching; on
 * dispatch success the store CLEARS `pendingQuestion`. A second
 * `/plan answer` finds an empty slot → returns
 * "No pending question" instead of re-injecting.
 *
 * The injection-writer already deduplicates by
 * `idempotencyKey: smarter-claw:question_answer:<questionId>` (see
 * `src/runtime/injection-writer.ts:293`); the store-side clear is
 * the user-visible idempotency, the injection-side dedup is the
 * defense-in-depth.
 */
export interface PendingQuestion {
  /**
   * Deterministic question id minted as `q-${toolCallId}` by the
   * `ask_user_question` tool. Stable across replays, so the
   * `enqueueQuestionAnswerInjection` idempotency key
   * `smarter-claw:question_answer:<questionId>` is stable too.
   */
  questionId: string;
  /** The original question text, for re-rendering in `/plan answer` help. */
  questionPrompt: string;
  /** The N selectable options the agent offered. UI may render them
   *  inline; `/plan answer` validates against this set when
   *  `allowFreetext=false`. */
  options: string[];
  /** When true, accept any text as the answer; else only one of `options`. */
  allowFreetext: boolean;
  /** Unix ms timestamp of when the question was persisted. */
  askedAt: number;
}

/**
 * The full plan-mode session-extension payload. Stored under
 * `pluginExtensions["smarter-claw"]["plan-mode"]` on the host's session
 * row. UI clients read this via the session-extension projector
 * (registered at P-1 with `api.session.state.registerSessionExtension`).
 *
 * # Schema-stability rules
 *
 * - All fields except `mode`, `approval`, and `rejectionCount` are
 *   optional. New fields must remain optional (additive only) for v1.x.
 * - `__schemaVersion` (added at P-3) gates breaking changes; pre-version
 *   payloads default to schemaVersion=1.
 * - Removing a field requires a major version bump AND a migration
 *   path in P-3's PlanModeStore.
 *
 * host_ref: `src/agents/plan-mode/types.ts:51-98` (the in-host
 *   PlanModeSessionState interface)
 */
export interface PlanModeSessionState {
  /** Current mode. */
  mode: PlanMode;

  /** Current approval lifecycle state. */
  approval: PlanApprovalState;

  /** Unix ms timestamp of most recent `enter_plan_mode` call. */
  enteredAt?: number;

  /** Unix ms timestamp of most recent approval state confirmation. */
  confirmedAt?: number;

  /** Unix ms timestamp of any mutation to this state. */
  updatedAt?: number;

  /**
   * User feedback from the most-recent rejection. Cleared on approval.
   * Per in-host comment: "guides agent revision."
   *
   * SECURITY: when injected into the next turn's prompt as
   * `[PLAN_DECISION]: rejected\nfeedback: <JSON-quoted>`, feedback MUST
   * be passed through `sanitizeFeedbackForInjection` (defined in
   * helpers/sanitize.ts) to prevent envelope-closing attacks.
   */
  feedback?: string;

  /** Count of rejections in this session. At ≥3 the agent gets a
   *  deescalation hint ("Multiple revisions have been rejected.
   *  Consider asking the user to clarify...").
   *
   *  **W1-E1 watchdog deferral note**: this counter is also the
   *  primary signal a future turn-limit watchdog would consume to
   *  auto-exit plan mode on a runaway loop. The watchdog itself is
   *  deferred — neither the in-host has a parity reference nor does
   *  SDK 2026.5.18 expose a fit-for-purpose event-driven scheduler
   *  seam (`registerSessionSchedulerJob` is cleanup-only;
   *  `scheduleSessionTurn` is cron-driven). See
   *  `docs/audits/parity-refresh/blocker-W1-E1.md` for the
   *  investigation and the prerequisites that unblock the work
   *  (notably W1-F4 — wiring `autoApprove` so a loop can exist). */
  rejectionCount: number;

  /**
   * Version token regenerated on every `exit_plan_mode` call. Approval
   * reply dispatchers compare incoming approvalId against current
   * state — stale approvals are ignored, preventing
   * rejected → approved flips on a stale event.
   *
   * Use `newPlanApprovalId()` from helpers/approval-id.ts to mint
   * fresh IDs.
   *
   * host_ref: `src/agents/plan-mode/types.ts:62-69`
   */
  approvalId?: string;

  /** Plan title from the most recent `exit_plan_mode(title=...,
   *  plan=[...])` call. UI/channel renderers anchor on this throughout
   *  the lifecycle. */
  title?: string;

  /**
   * Parent run id captured from `exit_plan_mode`. Used by gateway-side
   * approval handler to reject `approve`/`edit` actions while
   * subagents are still in flight (looks up parent's
   * `openSubagentRunIds`).
   */
  approvalRunId?: string;

  /**
   * SHA-1 prefix (12 chars) of the most-recent exit_plan_mode payload
   * (title + summary + step text/status). Used by
   * `persistApprovalRequest` to detect duplicate exit_plan_mode
   * invocations: when the candidate hash matches the persisted hash AND
   * the cycle is still pending with a valid approvalId, the existing
   * approvalId is reused rather than rotating mid-cycle (which would
   * orphan in-flight approval cards).
   *
   * Compute with `computePlanPayloadHash` from helpers/payload-hash.ts.
   *
   * host_ref: `src/agents/plan-mode/types.ts:87-97` (Eva live-test
   *   2026-04-28 fix for Telegram /plan-accept duplicate-fire bug)
   */
  lastPlanPayloadHash?: string;

  /**
   * Persisted plan steps from the most recent `exit_plan_mode` call.
   * Mirrors the steps array so UI clients can render without
   * re-issuing the tool call. Cleared when plan-mode exits.
   *
   * host_ref: `src/agents/pi-embedded-subscribe.handlers.tools.ts:1870-1874`
   *   (the `lastPlanSteps` object shape on persistApprovalRequest's
   *    persisted payload)
   */
  lastPlanSteps?: PlanStep[];

  /**
   * Auto-approve toggle (added P-8). When true, the next
   * `exit_plan_mode` immediately transitions through approval
   * without waiting for user input — useful for trusted-loop flows
   * where the agent should self-execute approved plans (Eva's
   * iter-3 D5 use case).
   *
   * Toggled via the `/plan auto on|off` slash command (P-12 wires
   * the session-action handler). The runtime side that actually
   * fires auto-approve lands at P-11 alongside rejection-cycle
   * tracking.
   *
   * Optional + defaults to false at read time. Additive-only per
   * schema policy (CURRENT_SCHEMA_VERSION stays at 1).
   *
   * host_ref: `src/agents/plan-mode/auto-enable.ts` (in-host PR-10
   *   auto-mode wiring).
   */
  autoApprove?: boolean;

  /**
   * Pending `ask_user_question` interaction state. Written by the
   * `ask_user_question` tool body; read by the `/plan answer`
   * slash-command handler. See `PendingQuestion` for the full
   * lifecycle + idempotency invariant.
   *
   * Wave-1 W1-F5 fix (2026-05-20): closes the cross-surface
   * `/plan answer` gap for Telegram/Slack. Before this field
   * existed, the `/plan answer` slash command returned the
   * "known gap" message because the session-action's required
   * `{ questionId, questionPrompt, selectedOption }` payload had no
   * source. With this field populated by `ask_user_question`, the
   * slash command can build the payload from the persisted state.
   *
   * host_ref: `src/config/sessions/types.ts:104-124` (the in-host's
   *   `PendingInteraction` union — same shape, plugin-side mirror).
   */
  pendingQuestion?: PendingQuestion;
}

/**
 * Initial state for a fresh session. New sessions get this written
 * lazily on first plan-mode interaction (P-3 wires it).
 *
 * host_ref: `src/agents/plan-mode/types.ts:99-104`
 */
export const DEFAULT_PLAN_MODE_STATE: PlanModeSessionState = {
  mode: "normal",
  approval: "none",
  rejectionCount: 0,
};
