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
 * Each detector picks an escalating instruction tier based on the
 * SDK's per-key attempt counter. Tiers are byte-identical to in-host:
 *
 *   - PLANNING_RETRY: standard (0) → firm (1) → final (2+)
 *   - PLAN_ACK_ONLY: standard (0) → firm (1+)
 *   - PLAN_YIELD: standard (0) → firm (1+)
 *
 * Instruction strings + regex constants + escalation resolvers live in
 * `./escalating-retry-constants.ts` so a future parity-harness Layer-1
 * diff catches drift surgically.
 *
 * # Surgical-port rationale (2026-05-12)
 *
 * Wave-1 audit slice S7 found:
 *   - Plugin had 3 ad-hoc instruction strings (no FIRM/FINAL tiers)
 *   - Plugin's narration detection was a naive `["I'll ", "Let me "]`
 *     array — missing the in-host's nuanced regex + structured-format
 *     heuristic
 *   - No PLANNING_ONLY_COMPLETION_RE guard (don't retry when agent
 *     says "done" / "fixed")
 *   - No max-length guard (retry on walls of text)
 *   - No code-block bypass (retry when agent IS showing code)
 *
 * This PR re-ports the BYTES + escalation tiers + nuanced regex
 * detection. The full toolMeta-level analysis (which Counts plan-only
 * tool calls vs real ones) stays gateway-side because the SDK seam
 * doesn't expose that signal. Documented as the remaining gap.
 *
 * host_ref: in-host escalating-retry from PR-7 + iter-3 D2 at
 *   pi-embedded-runner/run/incomplete-turn.ts (instruction constants
 *   verbatim; toolMeta detection deferred to gateway).
 */

import type { PlanMode } from "../types.js";
import {
  isPlanningOnlyNarrationText,
  PLANNING_ONLY_COMPLETION_RE,
  resolveEscalatingPlanAckOnlyInstruction,
  resolveEscalatingPlanningRetryInstruction,
  resolveEscalatingPlanYieldInstruction,
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION,
  PLAN_APPROVED_YIELD_RETRY_INSTRUCTION,
  DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT,
  DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT,
} from "./escalating-retry-constants.js";

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
  /** Did the agent emit a tool call this turn? **W1-E6 (#102) — known
   *  unreliable.** The `before_agent_finalize` event has no native
   *  signal for this and the runtime currently leaves `messages?:
   *  unknown[]` unpopulated, so `src/index.ts` derives this from
   *  `stopHookActive`, which per Claude Code's Stop-hook spec
   *  signals hook re-entrancy and is `false` for normal first-pass
   *  turns regardless of tool use. Tests pin the detector's
   *  algorithm by setting this directly; production wiring spuriously
   *  fires on real tool-use turns. See
   *  `docs/audits/parity-refresh/blocker-W1-E6.md`. */
  madeToolCall: boolean;
  /** True if the immediately-prior turn was a [PLAN_DECISION]: approved
   *  injection (so a yield here is the "PLAN_YIELD" antipattern). */
  isPostApprovalTurn: boolean;
  /** Optional: number of times THIS detector has fired for this cycle.
   *  Drives the FIRM/FINAL escalation. The host's
   *  before_agent_finalize counter is queried by idempotencyKey; the
   *  plugin reads it through the prior-decision metadata. When
   *  undefined, treats as 0 (first attempt). */
  attemptIndex?: number;
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
 *
 * host_ref: in-host's incomplete-turn.ts dispatch — PLAN_YIELD checked
 *   first via post-approval grace window, then PLAN_ACK_ONLY for in-
 *   mode chat-only, then PLANNING_RETRY for the normal-mode case.
 */
export function decideEscalatingRetry(
  sessionKey: string | undefined,
  signal: TurnSignal,
): RetryDecision | undefined {
  if (!sessionKey) return undefined;

  const attemptIndex = signal.attemptIndex ?? 0;

  // PLAN_YIELD: post-approval turn that yielded with no execution.
  // Most specific — check first. The in-host has a grace window
  // (POST_APPROVAL_YIELD_GRACE_MS) AND a toolMeta check; we use the
  // coarse "no tool call + no assistant text" signal here.
  if (
    signal.isPostApprovalTurn &&
    !signal.madeToolCall &&
    !signal.lastAssistantMessage?.trim()
  ) {
    return {
      detector: "PLAN_YIELD",
      instruction: resolveEscalatingPlanYieldInstruction(attemptIndex),
      idempotencyKey: idempotencyKey(sessionKey, "PLAN_YIELD"),
      maxAttempts: DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT,
    };
  }

  // PLAN_ACK_ONLY: in plan mode, agent narrated without acting.
  // Skip when text says "done" / "fixed" etc. — the agent may have
  // ended the work via reasoning and the retry would be a nag.
  if (
    signal.planMode === "plan" &&
    !signal.madeToolCall &&
    !!signal.lastAssistantMessage?.trim() &&
    !PLANNING_ONLY_COMPLETION_RE.test(signal.lastAssistantMessage)
  ) {
    return {
      detector: "PLAN_ACK_ONLY",
      instruction: resolveEscalatingPlanAckOnlyInstruction(attemptIndex),
      idempotencyKey: idempotencyKey(sessionKey, "PLAN_ACK_ONLY"),
      maxAttempts: DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT,
    };
  }

  // PLANNING_RETRY: outside plan mode, agent narrated planning-only
  // turn (chat text but no tool call). Uses the in-host's nuanced
  // detector: requires PLANNING_ONLY_PROMISE_RE match (or structured
  // format with bullets + heading) + an action verb + not a
  // completion signal + not a code block + not too long.
  if (
    signal.planMode === "normal" &&
    !signal.madeToolCall &&
    isPlanningOnlyNarrationText(signal.lastAssistantMessage)
  ) {
    return {
      detector: "PLANNING_RETRY",
      instruction: resolveEscalatingPlanningRetryInstruction(attemptIndex),
      idempotencyKey: idempotencyKey(sessionKey, "PLANNING_RETRY"),
      maxAttempts: 3,
    };
  }

  return undefined;
}

function idempotencyKey(sessionKey: string, detector: RetryDetector): string {
  // Simple stable key — the host's before_agent_finalize will count
  // retries for the same key. Don't include lastAssistantMessage
  // hash; we WANT the retry counter to span variants ("I'll do X"
  // and "I'll handle Y" both count toward the cap).
  return `smarter-claw:${detector}:${sessionKey}`;
}

// Re-export the constants so callers can pin them in tests without
// reaching into the constants module directly.
export {
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION,
  PLAN_APPROVED_YIELD_RETRY_INSTRUCTION,
} from "./escalating-retry-constants.js";
