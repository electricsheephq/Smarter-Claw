/**
 * Plan-mode system-prompt injection composer.
 *
 * **Parity contract**: byte-identical port of the in-host inline block
 * at `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-runner/run/attempt.ts:689-749`
 * (commit `ea04ea52c7`). Two branches:
 *
 *   1. `buildPlanModeActiveSystemContext()` — for when planMode === "plan".
 *      Includes: header, "session IS in plan mode RIGHT NOW" preamble,
 *      ACTION CONTRACT (3 numbered steps + ack-without-tool-call=defect),
 *      Investigation Phase (read-only tools + LOGS heuristic +
 *      ask_user_question guidance), Hard Rules, separator,
 *      PLAN_ARCHETYPE_PROMPT, PLAN_MODE_REFERENCE_CARD.
 *
 *   2. `buildPlanModeAvailableSystemContext()` — for when plan-mode
 *      feature is enabled but the session is NOT in plan mode. Tells
 *      the agent it CAN enter plan mode when the user asks for one.
 *
 * # Surgical-port rationale (2026-05-12)
 *
 * Wave-1 audit slice S4 found:
 *   - ACTION CONTRACT block missing entirely (the 3-step contract +
 *     "acknowledgement-without-tool-call as a defect" steer)
 *   - Investigation phase guidance missing (read-only tools list,
 *     critical LOGS heuristic — "start at the END (tail)" — and
 *     ask_user_question guidance)
 *   - "This session IS in plan mode RIGHT NOW" preamble missing
 *   - PLAN MODE AVAILABLE branch entirely absent
 *
 * Each clause exists because of a documented live-test failure mode.
 * Do not prune.
 *
 * # Why this is in the SYSTEM PROMPT
 *
 * The prompt-cache-key is the byte-prefix of the system context. The
 * full block needs to be byte-identical to the in-host emission so
 * that any future parity-harness Layer-1 diff catches drift, AND so
 * that prompt-cache hits work when the plugin runs alongside the
 * in-host (the per-session prompt key matches).
 *
 * host_ref: src/agents/pi-embedded-runner/run/attempt.ts:689-749
 */

import { PLAN_ARCHETYPE_PROMPT } from "./archetype-prompt.js";
import { PLAN_MODE_REFERENCE_CARD } from "./reference-card.js";

// ---------------------------------------------------------------------------
// Building blocks — sub-constants kept exposed for byte-level test pinning.
// Don't refactor away: tests in tests/prompt/plan-mode-injection.test.ts
// assert against these individually to catch drift surgically.
// ---------------------------------------------------------------------------

const PLAN_MODE_HEADER = "═══ PLAN MODE ACTIVE ═══";
const PLAN_MODE_SEPARATOR = "═════════════════════════";

// In-host attempt.ts:695 — preamble that pins "you ARE in plan mode".
const PLAN_MODE_PREAMBLE =
  "This session IS in plan mode RIGHT NOW. Every user message in this session is a plan-mode message. Your action selection on this turn must reflect that.";

// In-host attempt.ts:697-702 — the ACTION CONTRACT.
const PLAN_MODE_ACTION_CONTRACT = [
  "ACTION CONTRACT — when the user says anything that requests a plan, iteration, revision, or 'try again' / 'iterate' / 'fresh' / 'next attempt':",
  "1. Briefly acknowledge in one short sentence (optional).",
  '2. CALL `exit_plan_mode(title="…", summary="…", plan=[...])` IN THE SAME TURN. `title` and `plan` are required; non-trivial plans should also include `analysis`, `assumptions`, `risks`, `verification`.',
  "3. Stop after the tool call. Do NOT respond with any further chat text in that turn.",
  "",
  "If you skip step 2 — if you respond with chat-only acknowledgement — you have failed the plan-mode contract and the user has to re-prompt you, which they should not have to do. Treat acknowledgement-without-tool-call as a defect, not as 'staying conversational'.",
].join("\n");

// In-host attempt.ts:704-708 — Investigation phase guidance (including
// the load-bearing LOGS heuristic and ask_user_question rule).
const PLAN_MODE_INVESTIGATION_PHASE = [
  "Investigation phase (when needed):",
  "- Use read-only tools first (read, web_search, web_fetch, lcm_grep, lcm_describe, lcm_expand_query). Track investigation in update_plan.",
  "- For LOGS: start at the END (tail), use grep + time-window filters. Reading the first 100/400 lines of a multi-MB rolling log is almost always wrong — start with `tail -n 100`, then narrow by marker (e.g. `grep '[plan-mode/'`) or timestamp. Only widen to full file if the recent slice is insufficient.",
  "- Use `ask_user_question` ONLY for tradeoffs you can't resolve via local investigation.",
  "- Then call exit_plan_mode with the proposed plan, then STOP (no chat text after the tool call).",
].join("\n");

// In-host attempt.ts:710-714 — Hard rules (5 lines).
const PLAN_MODE_HARD_RULES = [
  "Hard rules:",
  "- Mutating tools (write, edit, exec/bash with side-effects, apply_patch) are BLOCKED by the runtime — calling them wastes a turn.",
  "- Do NOT write the plan as a markdown list in chat — it MUST go through exit_plan_mode so the user gets Accept/Edit/Reject buttons.",
  "- Do NOT call enter_plan_mode (you're already in plan mode — it's a no-op).",
  "- After `exit_plan_mode` in this turn: STOP. Do not emit any further chat text. The next turn (after user approval) delivers `[PLAN_DECISION]: approved` and you can resume execution then. Trailing chat poisons the approval card lifecycle.",
].join("\n");

// In-host attempt.ts:735-748 — PLAN MODE AVAILABLE branch (when feature
// flag is on but the session is not currently in plan mode).
const PLAN_MODE_AVAILABLE_BODY = [
  "═══ PLAN MODE AVAILABLE ═══",
  "",
  "Plan mode is available on this session but not currently active. When the user asks for a NEW plan / debugging-plan / refactor-plan / 'next plan' / a plan-first workflow, call `enter_plan_mode` to start a fresh planning cycle. The runtime will arm the mutation gate and you should then:",
  "",
  "1. Investigate read-only (use update_plan for in-progress tracking).",
  "2. Call `exit_plan_mode` with the proposed plan to surface Accept/Edit/Reject buttons to the user.",
  "3. After approval, mutating tools unlock and you execute.",
  "",
  "If the user is already executing an approved plan and asks you to keep going, do NOT re-enter plan mode — just continue executing the work.",
  "",
  "If the user asks a simple question or for a quick non-planning answer, do NOT enter plan mode. Plan mode is for multi-step proposals that benefit from explicit user approval before mutations.",
  "",
  "═════════════════════════════", // 29 box-drawing chars — note: in-host uses 29 vs ACTIVE's 25
].join("\n");

// ---------------------------------------------------------------------------
// Public builders.
// ---------------------------------------------------------------------------

/**
 * Build the system-prompt addition for an active plan-mode session.
 *
 * The output bytes are part of the prompt-cache key (cache hits depend
 * on byte-identical prefix matches). Tests pin this.
 *
 * host_ref: src/agents/pi-embedded-runner/run/attempt.ts:692-732 — the
 *   in-host inline block when `params.planMode === "plan"`. Restored
 *   in full by the 2026-05-12 surgical re-port.
 */
export function buildPlanModeActiveSystemContext(): string {
  return [
    PLAN_MODE_HEADER,
    "",
    PLAN_MODE_PREAMBLE,
    "",
    PLAN_MODE_ACTION_CONTRACT,
    "",
    PLAN_MODE_INVESTIGATION_PHASE,
    "",
    PLAN_MODE_HARD_RULES,
    "",
    PLAN_MODE_SEPARATOR,
    "",
    // PR-10: append the decision-complete plan archetype standard so
    // the agent produces Opus-quality plans (analysis + assumptions +
    // risks + verification) instead of bare step lists.
    PLAN_ARCHETYPE_PROMPT,
    "",
    // Iter-3 D1: append the plan-mode reference card so the agent
    // ALWAYS sees the state diagram + tool contract + [PLAN_*]: tag
    // taxonomy + slash-command surface + common pitfalls + debugging
    // tips on every in-mode turn. Eliminates the 2-turn learning
    // curve on fresh installs.
    PLAN_MODE_REFERENCE_CARD,
  ].join("\n");
}

/**
 * Build the system-prompt addition for a session where plan-mode is
 * enabled but NOT currently active. Tells the agent it CAN enter
 * plan mode when the user requests one.
 *
 * host_ref: src/agents/pi-embedded-runner/run/attempt.ts:733-749 — the
 *   in-host inline block when `planMode !== "plan"` and the feature
 *   flag is enabled.
 */
export function buildPlanModeAvailableSystemContext(): string {
  return PLAN_MODE_AVAILABLE_BODY;
}

/**
 * Backward-compat alias for the active-mode builder. Kept so existing
 * callers (src/index.ts, tests) continue to work.
 */
export function buildPlanModeSystemContext(): string {
  return buildPlanModeActiveSystemContext();
}

/**
 * For tests + parity-harness: expose the building blocks so assertions
 * can pin individual sections without re-deriving.
 */
export const _testing = {
  PLAN_MODE_HEADER,
  PLAN_MODE_SEPARATOR,
  PLAN_MODE_PREAMBLE,
  PLAN_MODE_ACTION_CONTRACT,
  PLAN_MODE_INVESTIGATION_PHASE,
  PLAN_MODE_HARD_RULES,
  PLAN_MODE_AVAILABLE_BODY,
};
