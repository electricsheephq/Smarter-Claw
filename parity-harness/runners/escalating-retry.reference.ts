/**
 * Vendored reference for the escalating-retry instruction selectors +
 * constant strings.
 *
 * The in-host file (`src/agents/pi-embedded-runner/run/incomplete-turn.ts`)
 * is ~1070 LOC because it interrogates EmbeddedRunAttemptResult
 * internals. The plugin's port (`src/runtime/escalating-retry-constants.ts`)
 * pulls out ONLY the instruction-byte constants + the attempt-index
 * resolvers and exports them verbatim. THIS reference re-derives those
 * same constants + functions directly from the in-host source so the
 * harness can compare byte-by-byte.
 *
 * Strategy: re-export the exact in-host constants + resolveEscalatingPlanningRetryInstruction
 * here. The constants are pure string literals — easy to vendor verbatim.
 * The PLAN_ACK_ONLY + PLAN_YIELD resolvers are not exported from
 * in-host (they're internal to incomplete-turn.ts's resolveX functions),
 * but the constants ARE exported and the resolver shape is documented
 * (in-host's DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT=2 + DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT=2
 * implies a 2-tier escalation: standard → firm). The plugin's resolvers
 * implement that documented shape; the reference mirrors it.
 *
 * host_ref:
 *   - src/agents/pi-embedded-runner/run/incomplete-turn.ts:66-267 (constants)
 *   - src/agents/pi-embedded-runner/run/incomplete-turn.ts:731-739 (resolveEscalatingPlanningRetryInstruction)
 *
 * Anti-pattern guardrail: re-capture this from the in-host source if it
 * changes. Do NOT mirror plugin source.
 */

// ---------------------------------------------------------------------------
// Regex constants (in-host lines 66-80).
// ---------------------------------------------------------------------------

export const PLANNING_ONLY_PROMISE_RE_REF =
  /\b(?:i(?:'ll| will)|let me|i(?:'m| am)\s+going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|i can do that)\b/i;

export const PLANNING_ONLY_COMPLETION_RE_REF =
  /\b(?:done|finished|implemented|updated|fixed|changed|ran|verified|found|here(?:'s| is) what|blocked by|the blocker is)\b/i;

export const PLANNING_ONLY_HEADING_RE_REF = /^(?:plan|steps?|next steps?)\s*:/i;

export const PLANNING_ONLY_BULLET_RE_REF = /^(?:[-*•]\s+|\d+[.)]\s+)/u;

export const PLANNING_ONLY_MAX_VISIBLE_TEXT_REF = 700;

export const PLANNING_ONLY_ACTION_VERB_RE_REF =
  /\b(?:inspect|investigate|check|look(?:\s+into|\s+at)?|read|search|find|debug|fix|patch|update|change|edit|write|implement|run|test|verify|review|analy(?:s|z)e|summari(?:s|z)e|explain|answer|show|share|report|prepare|capture|take|refactor|restart|deploy|ship)\b/i;

// ---------------------------------------------------------------------------
// Retry-limit defaults (in-host lines 96-101, 245, 267).
// ---------------------------------------------------------------------------

export const DEFAULT_PLANNING_ONLY_RETRY_LIMIT_REF = 1;
export const STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT_REF = 3;
export const DEFAULT_REASONING_ONLY_RETRY_LIMIT_REF = 2;
export const DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT_REF = 1;
export const DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT_REF = 2;
export const DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT_REF = 2;

// ---------------------------------------------------------------------------
// PLANNING_RETRY instructions (in-host lines 151-156).
// ---------------------------------------------------------------------------

export const PLANNING_ONLY_RETRY_INSTRUCTION_REF =
  "[PLANNING_RETRY]: The previous assistant turn only described the plan. Do not restate the plan. Act now: take the first concrete tool action you can. If a real blocker prevents action, reply with the exact blocker in one sentence.";

export const PLANNING_ONLY_RETRY_INSTRUCTION_FIRM_REF =
  "[PLANNING_RETRY]: CRITICAL: You have described the plan multiple times without acting. You MUST call a tool in this turn. No more planning or narration. If a real blocker prevents action, state the exact blocker in one sentence. Otherwise, call the first tool NOW.";

export const PLANNING_ONLY_RETRY_INSTRUCTION_FINAL_REF =
  "[PLANNING_RETRY]: Final reminder: this is the third planning-only turn. Please call a tool now to make progress. If a real blocker prevents action, state the exact blocker in one sentence so the user can unblock you.";

// ---------------------------------------------------------------------------
// REASONING_ONLY / EMPTY_RESPONSE (in-host lines 157-160).
// ---------------------------------------------------------------------------

export const REASONING_ONLY_RETRY_INSTRUCTION_REF =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

export const EMPTY_RESPONSE_RETRY_INSTRUCTION_REF =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";

// ---------------------------------------------------------------------------
// ACK_EXECUTION / AUTO_CONTINUE (in-host lines 161-166).
// ---------------------------------------------------------------------------

export const ACK_EXECUTION_FAST_PATH_INSTRUCTION_REF =
  "The latest user message is a short approval to proceed. Do not recap or restate the plan. Start with the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";

export const AUTO_CONTINUE_FAST_PATH_INSTRUCTION_REF =
  "The system is auto-continuing. Do not recap or restate the plan. Start with the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";

export const STRICT_AGENTIC_BLOCKED_TEXT_REF =
  "Agent stopped after repeated plan-only turns without taking a concrete action. No concrete tool action or external side effect advanced the task.";

// ---------------------------------------------------------------------------
// PLAN_ACK_ONLY (in-host lines 226-243).
// ---------------------------------------------------------------------------

export const PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_REF =
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

export const PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM_REF =
  "[PLAN_ACK_ONLY]: CRITICAL: plan mode is active and you have acknowledged twice without calling " +
  "exit_plan_mode. You MUST call exit_plan_mode(plan=[...]) in this turn. No more " +
  "chat-only acknowledgements. If a real blocker prevents producing a plan, state " +
  "the exact blocker in one sentence so the user can unblock you.";

// ---------------------------------------------------------------------------
// PLAN_APPROVED_YIELD (in-host lines 254-265).
// ---------------------------------------------------------------------------

export const PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_REF =
  "[PLAN_YIELD]: Your plan was just approved and mutating tools were unlocked. You yielded the turn " +
  "without taking any main-lane action — but the approval flow explicitly told you to " +
  "continue through every step without pausing. Continue executing the plan now. Only " +
  "yield if you actually need a subagent's result for the next step you are about to " +
  "take, AND state in one sentence which step is blocked on which result.";

export const PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM_REF =
  "[PLAN_YIELD]: CRITICAL: you yielded again immediately after plan approval. Continue main-lane " +
  "execution of the approved plan. If a subagent result is genuinely required for the " +
  "next step, perform that step's prerequisite reads inline instead of orchestrating. " +
  "Do not yield unless a real blocker requires the user to intervene.";

// ---------------------------------------------------------------------------
// Investigative tools (in-host lines 203-217).
// ---------------------------------------------------------------------------

export const PLAN_MODE_INVESTIGATIVE_TOOL_NAMES_REF: ReadonlySet<string> = new Set([
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
// Resolver functions (in-host lines 731-739 for planning-retry; PLAN_ACK_ONLY
// + PLAN_YIELD resolvers are internal in-host but their shape is pinned by
// the limit defaults: 2-tier standard→firm).
// ---------------------------------------------------------------------------

export function resolveEscalatingPlanningRetryInstructionReference(
  attemptIndex: number,
): string {
  if (attemptIndex <= 0) {
    return PLANNING_ONLY_RETRY_INSTRUCTION_REF;
  }
  if (attemptIndex === 1) {
    return PLANNING_ONLY_RETRY_INSTRUCTION_FIRM_REF;
  }
  return PLANNING_ONLY_RETRY_INSTRUCTION_FINAL_REF;
}

export function resolveEscalatingPlanAckOnlyInstructionReference(
  attemptIndex: number,
): string {
  if (attemptIndex <= 0) {
    return PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_REF;
  }
  return PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM_REF;
}

export function resolveEscalatingPlanYieldInstructionReference(
  attemptIndex: number,
): string {
  if (attemptIndex <= 0) {
    return PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_REF;
  }
  return PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM_REF;
}
