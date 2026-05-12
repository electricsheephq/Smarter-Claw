/**
 * Escalating-retry detection CONSTANTS — verbatim port from in-host.
 *
 * **Parity contract**: byte-identical port of the relevant exports +
 * private constants from
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-runner/run/incomplete-turn.ts:66-267`
 * (commit `ea04ea52c7`).
 *
 * # Why split this out
 *
 * The in-host's `incomplete-turn.ts` is ~1070 LOC because it interrogates
 * `EmbeddedRunAttemptResult` (toolMetas, replayMetadata, itemLifecycle)
 * — internals the runner owns but the plugin SDK doesn't expose. The
 * plugin's detection operates at the COARSE turn boundary
 * (`before_agent_finalize` event). Porting the whole 1070 LOC would
 * fail to compile against the SDK surface, and most of it (toolMeta
 * inspection, replayMetadata side-effect tracking) is gateway-internal.
 *
 * What DOES translate cleanly: the instruction strings (the bytes the
 * agent sees), the regex constants (planning-narration patterns), and
 * the escalation-level mapping (retry-count → instruction-tier). All
 * three live here as VERBATIM exports so:
 *   - Tests can pin them against the in-host source-of-truth
 *   - Future parity-harness Layer-1 diffs catch drift surgically
 *   - The plugin's coarse detector picks the right escalation tier
 *
 * # Surgical-port rationale (2026-05-12)
 *
 * Wave-1 audit slice S7 found the plugin had only THREE ad-hoc
 * instruction strings (one per detector, no escalation tiers). The
 * in-host has FIRM and FINAL escalations for PLANNING_RETRY and
 * PLAN_ACK_ONLY and PLAN_YIELD — these are the gradient that makes
 * the retry effective rather than nagging.
 *
 * host_ref: src/agents/pi-embedded-runner/run/incomplete-turn.ts:66-267
 */

// ---------------------------------------------------------------------------
// Regex constants for narration detection.
// Byte-identical to in-host lines 66-80.
// ---------------------------------------------------------------------------

export const PLANNING_ONLY_PROMISE_RE =
  /\b(?:i(?:'ll| will)|let me|i(?:'m| am)\s+going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|i can do that)\b/i;

export const PLANNING_ONLY_COMPLETION_RE =
  /\b(?:done|finished|implemented|updated|fixed|changed|ran|verified|found|here(?:'s| is) what|blocked by|the blocker is)\b/i;

export const PLANNING_ONLY_HEADING_RE = /^(?:plan|steps?|next steps?)\s*:/i;

export const PLANNING_ONLY_BULLET_RE = /^(?:[-*•]\s+|\d+[.)]\s+)/u;

export const PLANNING_ONLY_MAX_VISIBLE_TEXT = 700;

export const PLANNING_ONLY_ACTION_VERB_RE =
  /\b(?:inspect|investigate|check|look(?:\s+into|\s+at)?|read|search|find|debug|fix|patch|update|change|edit|write|implement|run|test|verify|review|analy(?:s|z)e|summari(?:s|z)e|explain|answer|show|share|report|prepare|capture|take|refactor|restart|deploy|ship)\b/i;

// ---------------------------------------------------------------------------
// Retry-limit defaults — byte-identical to in-host lines 96-101, 245, 267.
// ---------------------------------------------------------------------------

export const DEFAULT_PLANNING_ONLY_RETRY_LIMIT = 1;
export const STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT = 3;
export const DEFAULT_REASONING_ONLY_RETRY_LIMIT = 2;
export const DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT = 1;
export const DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT = 2;
export const DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT = 2;

// ---------------------------------------------------------------------------
// PLANNING_RETRY instructions (outside plan mode — agent narrated only).
// Byte-identical to in-host lines 151-156.
// ---------------------------------------------------------------------------

export const PLANNING_ONLY_RETRY_INSTRUCTION =
  "[PLANNING_RETRY]: The previous assistant turn only described the plan. Do not restate the plan. Act now: take the first concrete tool action you can. If a real blocker prevents action, reply with the exact blocker in one sentence.";

export const PLANNING_ONLY_RETRY_INSTRUCTION_FIRM =
  "[PLANNING_RETRY]: CRITICAL: You have described the plan multiple times without acting. You MUST call a tool in this turn. No more planning or narration. If a real blocker prevents action, state the exact blocker in one sentence. Otherwise, call the first tool NOW.";

export const PLANNING_ONLY_RETRY_INSTRUCTION_FINAL =
  "[PLANNING_RETRY]: Final reminder: this is the third planning-only turn. Please call a tool now to make progress. If a real blocker prevents action, state the exact blocker in one sentence so the user can unblock you.";

// ---------------------------------------------------------------------------
// REASONING_ONLY / EMPTY_RESPONSE instructions (no PLAN_* tag — outside
// plan-mode tag taxonomy). Byte-identical to in-host lines 157-160.
// ---------------------------------------------------------------------------

export const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

export const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";

// ---------------------------------------------------------------------------
// ACK_EXECUTION / AUTO_CONTINUE fast-path instructions. Byte-identical
// to in-host lines 161-166.
// ---------------------------------------------------------------------------

export const ACK_EXECUTION_FAST_PATH_INSTRUCTION =
  "The latest user message is a short approval to proceed. Do not recap or restate the plan. Start with the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";

export const AUTO_CONTINUE_FAST_PATH_INSTRUCTION =
  "The system is auto-continuing. Do not recap or restate the plan. Start with the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";

export const STRICT_AGENTIC_BLOCKED_TEXT =
  "Agent stopped after repeated plan-only turns without taking a concrete action. No concrete tool action or external side effect advanced the task.";

// ---------------------------------------------------------------------------
// PLAN_ACK_ONLY instructions (in plan mode, agent narrated without
// calling exit_plan_mode or an investigative tool).
// Byte-identical to in-host lines 226-243.
// ---------------------------------------------------------------------------

export const PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION =
  "[PLAN_ACK_ONLY]: Plan mode is active and you're still in the PLANNING phase (no user " +
  "approval yet). Your previous response stopped without calling " +
  "exit_plan_mode OR a read-only investigative tool. Brief progress " +
  "updates are fine, but they must NOT end the turn — keep calling tools " +
  "after them. The next response MUST either: (a) continue planning " +
  "investigation with a read-only tool (read, lcm_grep, lcm_describe, " +
  "lcm_expand_query, grep, glob, ls, find, web_search, web_fetch, " +
  "update_plan), or (b) call exit_plan_mode(title=..., plan=[...]) " +
  "with the proposed plan. A status line followed by another tool call " +
  "is the right pattern; a status line alone is treated as yielding " +
  "without acting.";

export const PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM =
  "[PLAN_ACK_ONLY]: CRITICAL: plan mode is active and you have acknowledged twice without calling " +
  "exit_plan_mode. You MUST call exit_plan_mode(plan=[...]) in this turn. No more " +
  "chat-only acknowledgements. If a real blocker prevents producing a plan, state " +
  "the exact blocker in one sentence so the user can unblock you.";

// ---------------------------------------------------------------------------
// PLAN_APPROVED_YIELD instructions (post-approval, agent yielded the
// turn without main-lane execution). Byte-identical to in-host lines
// 254-265.
// ---------------------------------------------------------------------------

export const PLAN_APPROVED_YIELD_RETRY_INSTRUCTION =
  "[PLAN_YIELD]: Your plan was just approved and mutating tools were unlocked. You yielded the turn " +
  "without taking any main-lane action — but the approval flow explicitly told you to " +
  "continue through every step without pausing. Continue executing the plan now. Only " +
  "yield if you actually need a subagent's result for the next step you are about to " +
  "take, AND state in one sentence which step is blocked on which result.";

export const PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM =
  "[PLAN_YIELD]: CRITICAL: you yielded again immediately after plan approval. Continue main-lane " +
  "execution of the approved plan. If a subagent result is genuinely required for the " +
  "next step, perform that step's prerequisite reads inline instead of orchestrating. " +
  "Do not yield unless a real blocker requires the user to intervene.";

// ---------------------------------------------------------------------------
// Investigative-tool catalog. When the agent calls one of these in plan
// mode, the PLAN_ACK_ONLY detector should NOT fire (the agent IS
// investigating, just doing it without exit_plan_mode yet — fine).
//
// Byte-identical to in-host lines 203-217 (PLAN_MODE_INVESTIGATIVE_TOOL_NAMES).
// ---------------------------------------------------------------------------

export const PLAN_MODE_INVESTIGATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "lcm_grep",
  "lcm_describe",
  "lcm_expand_query",
  "lcm_expand",
  "grep",
  "glob",
  "ls",
  "find",
  "web_search",
  "web_fetch",
  "update_plan",
  "enter_plan_mode",
]);

// ---------------------------------------------------------------------------
// Escalation resolver — picks the right instruction tier based on
// attempt index. Byte-identical to in-host
// `resolveEscalatingPlanningRetryInstruction` at lines 731-739.
// ---------------------------------------------------------------------------

/**
 * Returns an escalating retry instruction based on the current attempt number.
 * Attempt 0 = first retry (standard), 1 = firm, 2+ = final warning.
 *
 * host_ref: src/agents/pi-embedded-runner/run/incomplete-turn.ts:731-739
 */
export function resolveEscalatingPlanningRetryInstruction(
  attemptIndex: number,
): string {
  if (attemptIndex <= 0) {
    return PLANNING_ONLY_RETRY_INSTRUCTION;
  }
  if (attemptIndex === 1) {
    return PLANNING_ONLY_RETRY_INSTRUCTION_FIRM;
  }
  return PLANNING_ONLY_RETRY_INSTRUCTION_FINAL;
}

/**
 * PLAN_ACK_ONLY escalation. Attempt 0 = standard, 1+ = firm.
 *
 * host_ref: in-host pattern at incomplete-turn.ts (the FIRM variant is
 *   used after the standard has been tried — see DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT
 *   = 2 which implies a 2-step escalation).
 */
export function resolveEscalatingPlanAckOnlyInstruction(
  attemptIndex: number,
): string {
  if (attemptIndex <= 0) {
    return PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION;
  }
  return PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM;
}

/**
 * PLAN_YIELD escalation. Attempt 0 = standard, 1+ = firm.
 *
 * host_ref: DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT = 2 implies
 *   2-step escalation (standard → firm).
 */
export function resolveEscalatingPlanYieldInstruction(
  attemptIndex: number,
): string {
  if (attemptIndex <= 0) {
    return PLAN_APPROVED_YIELD_RETRY_INSTRUCTION;
  }
  return PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM;
}

// ---------------------------------------------------------------------------
// Detection helpers — coarse-grained narration detectors using the in-host
// regex constants. The full in-host detector also interrogates toolMetas
// and replayMetadata; those are gateway-side and don't translate. We
// use just the text-based signals here.
// ---------------------------------------------------------------------------

/**
 * Returns true when text matches the in-host's structured-planning
 * heuristic: heading + planning cue, OR 2+ bullet lines + planning cue.
 *
 * host_ref: incomplete-turn.ts:644-656 (hasStructuredPlanningOnlyFormat).
 */
export function hasStructuredPlanningOnlyFormat(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  const bulletLineCount = lines.filter((line) =>
    PLANNING_ONLY_BULLET_RE.test(line),
  ).length;
  const hasPlanningCueLine = lines.some((line) =>
    PLANNING_ONLY_PROMISE_RE.test(line),
  );
  const hasPlanningHeading = PLANNING_ONLY_HEADING_RE.test(lines[0] ?? "");
  return (
    (hasPlanningHeading && hasPlanningCueLine) ||
    (bulletLineCount >= 2 && hasPlanningCueLine)
  );
}

/**
 * Returns true when the text is planning-narration — agent describing
 * what they're going to do without acting. The text-only signals from
 * the in-host detector at incomplete-turn.ts:792-808.
 *
 * Returns false when:
 *   - text is empty / too long (skip walls)
 *   - text contains a code block (likely the agent IS executing)
 *   - text doesn't match PLANNING_ONLY_PROMISE_RE AND lacks structured format
 *   - text doesn't match an action verb (e.g. "I'll think about this")
 *   - text matches the COMPLETION_RE (e.g. "done", "fixed it")
 *
 * host_ref: incomplete-turn.ts:792-808 (resolvePlanningOnlyRetryInstruction
 *   text-checking branch).
 */
export function isPlanningOnlyNarrationText(
  text: string | undefined,
): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > PLANNING_ONLY_MAX_VISIBLE_TEXT) return false;
  if (trimmed.includes("```")) return false;
  const hasStructuredFormat = hasStructuredPlanningOnlyFormat(trimmed);
  if (!PLANNING_ONLY_PROMISE_RE.test(trimmed) && !hasStructuredFormat) {
    return false;
  }
  if (!hasStructuredFormat && !PLANNING_ONLY_ACTION_VERB_RE.test(trimmed)) {
    return false;
  }
  if (PLANNING_ONLY_COMPLETION_RE.test(trimmed)) {
    return false;
  }
  return true;
}
