/**
 * Escalating-retry detectors for incomplete agent turns.
 *
 * **Parity contract**: encodes the SEMANTIC contract of the in-host
 * incomplete-turn detection at
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-runner/run/incomplete-turn.ts`
 * (~1070 LOC). The plugin port uses the SDK's `before_agent_finalize`
 * hook which gives us a simplified event surface
 * (`{lastAssistantMessage, stopHookActive, ...}`) — much smaller than
 * the in-host runner's `EmbeddedRunAttemptResult`. We detect at the
 * coarse-grained turn boundary; precise toolMetas-level analysis stays
 * with the runner.
 *
 * # Three detectors
 *
 * - **PLAN_ACK_ONLY**: in plan mode + agent emitted assistant text BUT
 *   no tool call. The model "acknowledged" the instruction without
 *   acting. Inject `[PLAN_ACK_ONLY]:` retry.
 *
 * - **PLAN_YIELD**: just after `[PLAN_DECISION]: approved`, agent
 *   yields immediately (no execution). Inject `[PLAN_YIELD]:` retry.
 *
 * - **PLANNING_RETRY**: outside plan mode, agent narrated-only (chat,
 *   no tool call, no exit_plan_mode in the prior turn). Inject
 *   `[PLANNING_RETRY]:` retry.
 *
 * # Escalation levels (max 3 retries per cycle)
 *
 * The SDK's `before_agent_finalize` result accepts `maxAttempts`. We
 * use `idempotencyKey` keyed on (sessionKey, detector, lastAssistant
 * truncated hash) so the host counts retries for the same logical
 * situation and stops at level 3.
 *
 * host_ref: in-host escalating-retry semantics from PR-7 + iter-3 D2
 * landed across pi-embedded-runner/run/incomplete-turn.ts +
 * thinking.ts. Plugin port encodes the BEHAVIORAL contract; the
 * algorithmic details (toolMeta inspection, etc.) are runner-internal
 * and don't translate.
 */

import type { PlanMode } from "../types.js";

/**
 * Coarse-grained turn signal extracted from the
 * before_agent_finalize event + plugin's own plan-mode state.
 */
export interface TurnSignal {
  /** Current plan-mode mode (plan | normal). */
  planMode: PlanMode;
  /** The agent's last assistant message text. Undefined if the turn
   *  ended without any assistant text (e.g., immediate yield). */
  lastAssistantMessage?: string;
  /** Did the agent emit a tool call this turn? The hook event doesn't
   *  expose this directly — caller derives via post-message inspection
   *  or stopHookActive (active during tool-call paths). For P-10's
   *  scope we use `madeToolCall` as the inferred signal from
   *  stopHookActive: if stopHookActive is false AND lastAssistantMessage
   *  is non-empty, we assume the turn ended with chat-only. */
  madeToolCall: boolean;
  /** True if the immediately-prior turn was a [PLAN_DECISION]: approved
   *  injection (so a yield here is the "PLAN_YIELD" antipattern). */
  isPostApprovalTurn: boolean;
}

export type RetryDetector = "PLAN_ACK_ONLY" | "PLAN_YIELD" | "PLANNING_RETRY";

export interface RetryDecision {
  detector: RetryDetector;
  instruction: string;
  idempotencyKey: string;
  maxAttempts: number;
}

/**
 * Decide whether to issue an escalating retry. Returns undefined when
 * the turn is healthy.
 *
 * Priority order: PLAN_YIELD > PLAN_ACK_ONLY > PLANNING_RETRY. Higher
 * is more specific; only one detector fires per turn.
 */
export function decideEscalatingRetry(
  sessionKey: string | undefined,
  signal: TurnSignal,
): RetryDecision | undefined {
  if (!sessionKey) return undefined;

  // PLAN_YIELD: post-approval turn that yielded with no execution.
  // Most specific — check first.
  if (
    signal.isPostApprovalTurn &&
    !signal.madeToolCall &&
    !signal.lastAssistantMessage?.trim()
  ) {
    return {
      detector: "PLAN_YIELD",
      instruction:
        "[PLAN_YIELD]: Approval was granted but you didn't begin execution. " +
        "Continue with the plan — start the first pending step now.",
      idempotencyKey: idempotencyKey(sessionKey, "PLAN_YIELD"),
      maxAttempts: 3,
    };
  }

  // PLAN_ACK_ONLY: in plan mode, agent narrated without acting.
  if (
    signal.planMode === "plan" &&
    !signal.madeToolCall &&
    !!signal.lastAssistantMessage?.trim()
  ) {
    return {
      detector: "PLAN_ACK_ONLY",
      instruction:
        "[PLAN_ACK_ONLY]: You're in plan mode but your last turn was chat without a tool call. " +
        "Take the next concrete action: investigate (read/grep/web_search), update_plan, " +
        "ask_user_question, or exit_plan_mode with your proposal. Don't narrate without acting.",
      idempotencyKey: idempotencyKey(sessionKey, "PLAN_ACK_ONLY"),
      maxAttempts: 3,
    };
  }

  // PLANNING_RETRY: outside plan mode, agent narrated planning-only
  // turn (chat text but no tool call). Suggests the agent SHOULD have
  // entered plan mode for a non-trivial task.
  if (
    signal.planMode === "normal" &&
    !signal.madeToolCall &&
    isPlanningNarration(signal.lastAssistantMessage)
  ) {
    return {
      detector: "PLANNING_RETRY",
      instruction:
        "[PLANNING_RETRY]: Your last turn was narration about what you're going to do without taking action. " +
        "For non-trivial tasks consider enter_plan_mode and submitting a plan; " +
        "for trivial tasks, just call the appropriate tool. Don't describe the work — do it (or plan it first).",
      idempotencyKey: idempotencyKey(sessionKey, "PLANNING_RETRY"),
      maxAttempts: 3,
    };
  }

  return undefined;
}

/**
 * Heuristic: is the assistant message planning-only narration? Looks
 * for phrases like "I'll", "Let me", "First I'll" etc. without any
 * concrete action signals (no code blocks, no specific file paths
 * with file extensions, no tool-result style content).
 *
 * Intentionally conservative — false-negative (skipping a retry) is
 * better than false-positive (annoying the user with a retry on
 * a legitimately-narrative reply).
 */
function isPlanningNarration(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0 || t.length > 2000) return false; // skip empty + walls of text
  const planningStarters = [
    /^I'll /i,
    /^I will /i,
    /^Let me /i,
    /^First[,\s]/i,
    /^Here's my plan/i,
    /^My plan /i,
    /^The plan /i,
  ];
  const hasPlanningStart = planningStarters.some((re) => re.test(t));
  if (!hasPlanningStart) return false;
  // Heuristic anti-false-positive: don't retry if the message
  // contains a code block — likely the agent IS executing.
  if (/```/.test(t)) return false;
  // Don't retry on Q-style messages that end with a question mark.
  if (t.endsWith("?")) return false;
  return true;
}

function idempotencyKey(sessionKey: string, detector: RetryDetector): string {
  // Simple stable key — the host's before_agent_finalize will count
  // retries for the same key. Don't include lastAssistantMessage
  // hash; we WANT the retry counter to span variants ("I'll do X"
  // and "I'll handle Y" both count toward the cap).
  return `smarter-claw:${detector}:${sessionKey}`;
}
