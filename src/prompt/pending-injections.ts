/**
 * Pending agent-injection composer + types.
 *
 * **Parity contract**: byte-identical port of
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/plan-mode/injections.ts:43-103`
 * + `composePromptWithPendingInjections` at `:347-360`
 * (commit `ea04ea52c7`). The plugin-port writers (queue management)
 * land at P-11 (rejection cycle injections) and P-8/9 (question-answer
 * + plan-decision); P-8 ships the READ-side compose contract.
 *
 * # The injection queue
 *
 * When the user approves/rejects/answers, the host runtime queues a
 * synthetic message tagged `[PLAN_DECISION]:` / `[QUESTION_ANSWER]:`
 * / `[PLAN_COMPLETE]:` to the session's `pendingAgentInjections`.
 * The next agent turn drains the queue and prepends the joined text
 * to the user's prompt so the model sees the decision FIRST.
 *
 * # The drain contract
 *
 * On every turn:
 *   1. Read `entry.pendingAgentInjections`
 *   2. Filter expired (compare `expiresAt` < now)
 *   3. Sort by `priority desc, createdAt asc`
 *   4. Cap at MAX_QUEUE_SIZE (oldest-first eviction, warn-logged)
 *   5. Compose with the user prompt via composePromptWithPendingInjections
 *   6. Clear the queue (the host's responsibility — this module is READ-only)
 *
 * P-8 ships steps 5 + the type contract. Steps 1-4 + queue mutation
 * land at P-11.
 */

/**
 * Synthetic-message kinds queued by the runtime for delivery to the
 * agent's next turn.
 *
 * host_ref: src/config/sessions/types.ts:155-163 (PendingAgentInjectionEntry)
 *   + injections.ts:52-65 (DEFAULT_INJECTION_PRIORITY enumerates the kinds)
 */
export type PendingAgentInjectionKind =
  | "plan_decision"
  | "plan_complete"
  | "question_answer"
  | "subagent_return"
  | "plan_intro"
  | "plan_nudge";

/**
 * One queued synthetic message.
 *
 * host_ref: src/config/sessions/types.ts:155-163 — exact field-by-field
 *   port of `PendingAgentInjectionEntry`.
 */
export interface PendingAgentInjectionEntry {
  /** Stable id for dedup + idempotency. */
  id: string;
  /** Optional approvalId binding — used by plan_decision entries to
   *  reference which approval cycle they resolve. */
  approvalId?: string;
  kind: PendingAgentInjectionKind;
  /** The literal text injected before the user prompt. Includes the
   *  `[PLAN_DECISION]:` / `[QUESTION_ANSWER]:` / etc. prefix. */
  text: string;
  /** Unix ms timestamp. */
  createdAt: number;
  /** Optional priority override. Higher drains first. Defaults to
   *  the DEFAULT_INJECTION_PRIORITY lookup. */
  priority?: number;
  /** Optional expiry — entries older than this are skipped. */
  expiresAt?: number;
}

/**
 * Default priority by kind. Writers may override on the entry.
 * Higher drains first; ties broken by createdAt ascending.
 *
 * host_ref: src/agents/plan-mode/injections.ts:52-65
 */
export const DEFAULT_INJECTION_PRIORITY: Record<
  PendingAgentInjectionKind,
  number
> = {
  plan_decision: 10,
  plan_complete: 9,
  question_answer: 8,
  subagent_return: 5,
  plan_intro: 3,
  plan_nudge: 1,
};

/**
 * Queue size cap. Drain happens every turn so a well-behaved session
 * should never approach this. Eviction is oldest-first with a warn so
 * operators can spot a stuck drain loop.
 *
 * host_ref: src/agents/plan-mode/injections.ts:66
 */
export const MAX_QUEUE_SIZE = 10;

/**
 * Compose the agent prompt with the drained injection queue.
 *
 * - Empty queue → returns userPrompt unchanged.
 * - Empty userPrompt (whitespace-only) → returns preamble alone.
 * - Otherwise → `${preamble}\n\n${trimmedUser}` (two blank lines
 *   between preamble and user prompt; trims user prompt to drop
 *   leading/trailing whitespace per in-host semantics).
 *
 * Byte-identical to the in-host. Tests pin this.
 *
 * host_ref: src/agents/plan-mode/injections.ts:347-360 —
 *   composePromptWithPendingInjections.
 */
export function composePromptWithPendingInjections(
  injections: readonly PendingAgentInjectionEntry[],
  userPrompt: string,
): string {
  if (injections.length === 0) {
    return userPrompt;
  }
  const preamble = injections.map((e) => e.text).join("\n\n");
  const trimmedUser = userPrompt.trim();
  if (trimmedUser.length === 0) {
    return preamble;
  }
  return `${preamble}\n\n${trimmedUser}`;
}
