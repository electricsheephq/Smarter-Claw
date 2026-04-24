/**
 * `[PLAN_STATUS]:` preamble auto-injected into executing-mode turns.
 *
 * # Why this exists (PR #70071 P2.12b — recovered via tracking issue #51)
 *
 * `plan_mode_status` is a tool the agent CAN call to get ground-truth
 * plan state, but in practice GPT-5.4 rarely does — the approved plan
 * text is already in its context window (from the [PLAN_DECISION]:
 * approved injection) and the model's terseness training biases it
 * to not spend a tool call on info it believes it already has.
 *
 * Live-validated failure mode (Eva, 2026-04-22 Baoyu flyer skills):
 *   - Eva did 4 of 6 steps' worth of work
 *   - Eva never called `update_plan` between those work chunks
 *   - At +1/+3/+5 nudge time, Eva returned NO_REPLY three times,
 *     claiming internally "all steps are marked complete"
 *   - `plan_mode_status` showed 1 in_progress + 3 pending + 2 completed
 *   - Agent had conflated "did the work" with "called update_plan on it"
 *
 * The preamble forces the truth into every turn so the agent can't
 * confuse "did the work" with "recorded the work".
 *
 * # What this module does
 *
 * On EVERY turn where the session has `planMode === "executing"`,
 * `buildExecutionStatusInjection` returns a compact `[PLAN_STATUS]:`
 * block that:
 *   - reads the SmarterClaw plugin state from the session entry
 *   - summarizes step counts (done vs remaining)
 *   - defers authority to `plan_mode_status` (the tool is the single
 *     source of truth; the preamble is a snapshot reminder, not a
 *     substitute)
 *
 * # Schema adaptation note
 *
 * Smarter-Claw's `PlanStep` shape uses `done?: boolean` rather than
 * openclaw-1's richer `status: "pending" | "in_progress" | "completed"
 * | "cancelled"` enum. The preamble adapts:
 *   - "completed" count = steps with `done === true`
 *   - "remaining" count = steps with `done !== true`
 *
 * No "in_progress" / "cancelled" sub-counts because the plugin's
 * step shape doesn't carry that distinction. The agent's behavior
 * goal is the same — call update_plan when you finish work.
 *
 * # Fail-open semantics
 *
 * Returns `undefined` when:
 *   - state isn't in executing mode (nothing to inject)
 *   - no plan steps recorded (nothing meaningful to summarize)
 *   - state read failed upstream (caller's responsibility — the
 *     caller already has access to the session-store; this module
 *     accepts the resolved state object directly)
 *
 * Any thrown exception is the caller's to catch — this module is
 * pure logic with no I/O. Wired into the plugin's `before_prompt_build`
 * hook in `index.ts` where caller-side error handling already exists.
 */

import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readSmarterClawState } from "../runtime-api.js";
import { getPlanModeCache, setPlanModeCache } from "./plan-mode-cache.js";
import type { SmarterClawSessionState, PlanStep } from "./types.js";

/** Soft cap on the plan title (so the preamble stays short for long titles). */
const PREAMBLE_TITLE_SOFT_CAP = 120;

/**
 * Build the execution-phase `[PLAN_STATUS]:` preamble, or return
 * `undefined` if the preamble would be a no-op.
 *
 * This module is pure logic — caller passes the already-resolved
 * SmarterClaw plugin state from the session entry. Caller-side I/O
 * (loadSessionStore, etc.) is already done by the before_prompt_build
 * hook before it reaches us.
 */
export function buildExecutionStatusInjection(
  state: SmarterClawSessionState | undefined,
): string | undefined {
  if (!state) {
    return undefined;
  }
  if (state.planMode !== "executing") {
    return undefined;
  }
  const lastPlan = state.lastPlanSteps;
  const steps: PlanStep[] = lastPlan?.steps ?? [];
  if (steps.length === 0) {
    return undefined;
  }

  // Smarter-Claw's PlanStep uses `done?: boolean`. Schema adapt:
  // completed = done === true; remaining = done !== true.
  let completed = 0;
  for (const s of steps) {
    if (s.done === true) {
      completed += 1;
    }
  }
  const remaining = steps.length - completed;

  // Find the first un-done step to surface as the "current" step the
  // agent is most likely working on. Heuristic: in plugin-step model
  // we don't have explicit in_progress, so the first non-done step
  // is the agent's current focus per the imperative-step plan model.
  const current = steps.find((s) => s.done !== true);
  const currentLine =
    current && current.description.length > 0
      ? `\n  Current step: "${truncate(current.description, PREAMBLE_TITLE_SOFT_CAP)}"`
      : "";

  const title = truncate(lastPlan?.title ?? "(untitled)", PREAMBLE_TITLE_SOFT_CAP);
  const preamble =
    `[PLAN_STATUS]: Executing approved plan "${title}". ` +
    `Steps: ${completed}/${steps.length} completed, ${remaining} remaining.` +
    currentLine +
    `\n  This snapshot is captured at turn-start and may be stale; ` +
    "call `plan_mode_status` to verify if uncertain. Before returning " +
    'NO_REPLY, call `update_plan` to mark any finished step "done" ' +
    "based on what was actually accomplished. close-on-complete fires " +
    "automatically once all steps are marked done.";
  return preamble;
}

/**
 * Convenience wrapper: prepend the `[PLAN_STATUS]:` preamble to a
 * prompt string if the session is in executing mode, or return
 * `prompt` unchanged otherwise.
 *
 * Mirrors openclaw-1's `prependExecutionStatusIfExecuting` so callers
 * that want "string in, string out" can use it inline without the
 * undefined-check ceremony.
 */
export function prependExecutionStatusIfExecuting(
  prompt: string,
  state: SmarterClawSessionState | undefined,
): string {
  const prefix = buildExecutionStatusInjection(state);
  if (!prefix) {
    return prompt;
  }
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return prefix;
  }
  return `${prefix}\n\n${prompt}`;
}

/**
 * Hook-style entry point for the plugin's `before_prompt_build` hook.
 * Mirrors the shape of `buildArchetypePromptResult` so it composes
 * cleanly with the existing parts-array concat in `index.ts`.
 *
 * Reads SmarterClaw state from the per-session cache (shared with
 * `before_tool_call` so the same disk read is reused across hooks
 * within a turn). Returns `{ appendSystemContext }` when the session
 * is in executing mode AND has steps to report on, otherwise
 * `undefined` (preamble would be a no-op).
 */
export interface ExecutionStatusHookContext {
  agentId?: string;
  sessionKey?: string;
}

export function buildExecutionStatusResult(
  ctx: ExecutionStatusHookContext,
): { appendSystemContext: string } | undefined {
  const sessionKey = ctx.sessionKey;
  if (!sessionKey) {
    return undefined;
  }
  let storePath: string | undefined;
  if (ctx.agentId) {
    try {
      storePath = resolveStorePath(undefined, { agentId: ctx.agentId });
    } catch {
      return undefined;
    }
  }
  if (!storePath) {
    return undefined;
  }
  // Reuse the same per-session cache the archetype hook + before_tool_call
  // hook use so all three share the same disk read per turn (#10
  // perf cache pattern).
  let entry: ReturnType<typeof resolveSessionStoreEntry>["existing"];
  const cached = getPlanModeCache(sessionKey);
  if (cached) {
    entry = cached.entry as typeof entry;
  } else {
    try {
      const store = loadSessionStore(storePath, { skipCache: true });
      entry = resolveSessionStoreEntry({ store: store ?? {}, sessionKey }).existing;
    } catch {
      return undefined;
    }
    setPlanModeCache(sessionKey, entry as Record<string, unknown> | undefined);
  }
  const planState = entry ? readSmarterClawState(entry) : undefined;
  const preamble = buildExecutionStatusInjection(planState);
  if (!preamble) {
    return undefined;
  }
  return { appendSystemContext: preamble };
}

/** Cap a string at `soft` chars with a trailing ellipsis. */
function truncate(text: string, soft: number): string {
  if (text.length <= soft) {
    return text;
  }
  return `${text.slice(0, Math.max(0, soft - 3))}...`;
}
