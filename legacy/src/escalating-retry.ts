/**
 * Escalating retry suite — the heart of the openclaw-1 plan-mode work
 * the operator debugged for 2 weeks. Detects three behavioral failure
 * modes that GPT-5.4 falls into and re-prompts the agent with
 * progressively firmer instructions until it acts.
 *
 *   1. PLANNING_ONLY    — agent narrates "I'll do X" without calling any tool.
 *      Escalation: standard → firm → final (3 levels).
 *      Original: PR-7 PR-8.
 *
 *   2. PLAN_MODE_ACK_ONLY — in plan mode, agent says "I'll plan now"
 *      / "opening a fresh plan cycle" then ends the turn without calling
 *      exit_plan_mode OR a read-only investigative tool.
 *      Escalation: standard → firm (2 levels).
 *      Original: PR-8 follow-up "behavior-selection drift" fix.
 *
 *   3. PLAN_APPROVED_YIELD — immediately after plan approval, agent
 *      yields the turn without taking any main-lane action (despite the
 *      approval injection saying "do not pause between steps").
 *      Escalation: standard → firm (2 levels).
 *      Original: PR-8 follow-up Round 2 "post-approval orchestration drift" fix.
 *
 * ## Plugin port note (2026-04-24)
 *
 * The openclaw-1 implementation lived in
 * `src/agents/pi-embedded-runner/run/incomplete-turn.ts` (987 lines)
 * with deep integration into the Pi runner's per-attempt result type
 * (`EmbeddedRunAttemptResult`). For the Smarter-Claw plugin port we
 * preserve the behavior bytes-perfect for the constants + the pure
 * detection helpers, and re-author the resolvers to operate on the
 * coarser `agent_end` lifecycle event surface (which gives us the full
 * `messages` array post-turn, the same shape Pi handed to the original
 * resolvers via `assistantTexts` + `toolMetas`).
 *
 * ## Per-cycle counters
 *
 * The original tracked retry attempts in-memory inside the runner's
 * attempt loop. The plugin tracks them in
 * `SmarterClawSessionState.retryCounters` so they survive across runs
 * (an ack-only stall that survives a session restart still counts as
 * the second attempt, not a fresh first attempt).
 */

import type { SmarterClawSessionState } from "./types.js";

// ---------------------------------------------------------------------------
// Constants — VERBATIM from openclaw-1 incomplete-turn.ts
// (These string contents are part of the proven behavior — changing
// them is a behavioral regression. The 2-week debug cycle anchored the
// model on these exact phrasings.)
// ---------------------------------------------------------------------------

export const PLANNING_ONLY_RETRY_INSTRUCTION =
  "[PLANNING_RETRY]: The previous assistant turn only described the plan. Do not restate the plan. Act now: take the first concrete tool action you can. If a real blocker prevents action, reply with the exact blocker in one sentence.";

export const PLANNING_ONLY_RETRY_INSTRUCTION_FIRM =
  "[PLANNING_RETRY]: CRITICAL: You have described the plan multiple times without acting. You MUST call a tool in this turn. No more planning or narration. If a real blocker prevents action, state the exact blocker in one sentence. Otherwise, call the first tool NOW.";

export const PLANNING_ONLY_RETRY_INSTRUCTION_FINAL =
  "[PLANNING_RETRY]: Final reminder: this is the third planning-only turn. Please call a tool now to make progress. If a real blocker prevents action, state the exact blocker in one sentence so the user can unblock you.";

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

export const PLAN_APPROVED_YIELD_RETRY_INSTRUCTION =
  "[PLAN_YIELD]: Your plan was just approved and mutating tools were unlocked. You yielded the turn " +
  "without taking any main-lane action — but the approval flow explicitly told you to " +
  "continue through every step without pausing. Continue executing the plan now. Only " +
  "yield if you actually need a subagent's result for the next step you are about to " +
  "take, AND state in one sentence which step is blocked on which result.";

export const PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM =
  "[PLAN_YIELD]: CRITICAL: you yielded again immediately after plan approval. Continue main-lane " +
  "execution now. The plan was approved; mutations are unlocked. If a step genuinely needs " +
  "a subagent result, state in one sentence which step needs which result. Otherwise call " +
  "the next tool NOW.";

export const DEFAULT_PLANNING_ONLY_RETRY_LIMIT = 1;
export const DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT = 2;
export const DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT = 2;

/** 5 minutes. Past this, ack-only detector stops firing post-approval. */
export const POST_APPROVAL_ACK_ONLY_GRACE_MS = 5 * 60_000;
/** 2 minutes. Past this, yield-during-approved detector stops firing. */
export const POST_APPROVAL_YIELD_GRACE_MS = 2 * 60_000;
/** Visible-text cap above which the ack-only detector bails (assume agent already wrote the plan inline). */
export const PLAN_MODE_ACK_ONLY_MAX_VISIBLE_TEXT = 1500;

/**
 * Read-only / planning-supportive tools that satisfy the "investigation
 * happened this turn" check. Verbatim from openclaw-1 — keep in sync
 * with the LCM (`lossless-claw`) public tool surface; the LCM family
 * was a maintainer-confirmed addition after the initial cut missed it.
 */
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

/**
 * Normalized ack-execution prompts the openclaw-1 detector treats as
 * "user said go ahead, start executing." Used by `isLikelyExecutionAckPrompt`
 * to skip the planning-only retry when the prompt is a deliberate
 * approval signal rather than a fresh planning trigger.
 *
 * Verbatim from openclaw-1. Multilingual on purpose — the corpus
 * matters for the international testers we had on Discord/Telegram.
 */
const ACK_EXECUTION_NORMALIZED_SET = new Set<string>([
  "ok",
  "okay",
  "ok do it",
  "okay do it",
  "do it",
  "go ahead",
  "please do",
  "sounds good",
  "sounds good do it",
  "ship it",
  "fix it",
  "make it so",
  "yes do it",
  "yep do it",
  "تمام",
  "حسنا",
  "حسنًا",
  "امض قدما",
  "نفذها",
  "mach es",
  "leg los",
  "los geht s",
  "weiter",
  "やって",
  "進めて",
  "そのまま進めて",
  "allez y",
  "vas y",
  "fais le",
  "continue",
  "hazlo",
  "adelante",
  "sigue",
  "faz isso",
  "vai em frente",
  "pode fazer",
]);

// ---------------------------------------------------------------------------
// Detection helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Lowercase + strip punctuation/symbols + collapse whitespace.
 * Used for case- and punctuation-insensitive matching against
 * `ACK_EXECUTION_NORMALIZED_SET`.
 */
function normalizeAckPrompt(raw: string): string {
  return raw
    .trim()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Returns true when the user's prompt is a SHORT EXECUTION ACK
 * ("ok", "do it", "تمام", etc.). Used to bypass the planning-only
 * retry: if the user just said "go", we shouldn't re-prompt the
 * agent to plan more.
 *
 * Hard caps: max 80 chars, no newlines, no question marks. Long
 * prompts or multi-line prompts are out of scope (those are real
 * task prompts, not bare execution acks).
 */
export function isLikelyExecutionAckPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80 || trimmed.includes("\n") || trimmed.includes("?")) {
    return false;
  }
  return ACK_EXECUTION_NORMALIZED_SET.has(normalizeAckPrompt(trimmed));
}

/**
 * Result of "did the agent narrate a plan instead of acting?" detection.
 */
export type PlanningOnlyPlanDetails = {
  explanation: string;
  steps: string[];
};

const PLANNING_ONLY_BULLET_RE = /^(?:[-*•]\s+|\d+[.)]\s+)/u;
const PLANNING_ONLY_HEADING_RE = /^(?:plan|steps?|next steps?)\s*:/i;
const PLANNING_ONLY_PROMISE_RE =
  /\b(?:i(?:'ll| will)|let me|i(?:'m| am)\s+going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|i can do that)\b/i;

/**
 * Strict structured-plan-format check (verbatim from openclaw-1's
 * `hasStructuredPlanningOnlyFormat`). Returns true when the text either:
 *   - has a "Plan:" / "Steps:" heading PLUS a planning cue ("I'll", "let me"), or
 *   - has 2+ bullet/numbered lines PLUS a planning cue
 *
 * Without this guard, the planning_only detector false-fires on every
 * single-sentence assistant reply that happens to contain "I'll" — way
 * too noisy. The strict format gate matches openclaw-1's narrowing
 * after PR-7 review feedback.
 */
function hasStructuredPlanningOnlyFormat(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  const bulletLineCount = lines.filter((line) => PLANNING_ONLY_BULLET_RE.test(line)).length;
  const hasPlanningCueLine = lines.some((line) => PLANNING_ONLY_PROMISE_RE.test(line));
  const hasPlanningHeading = PLANNING_ONLY_HEADING_RE.test(lines[0] ?? "");
  return (hasPlanningHeading && hasPlanningCueLine) || (bulletLineCount >= 2 && hasPlanningCueLine);
}

/**
 * Best-effort split of "I'll do X. Then Y. Then Z." prose into discrete
 * step strings. Bullet/numbered lists win over sentence splits when both
 * are present. Returns up to 4 steps (the cap matches the original).
 */
function extractPlanningOnlySteps(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bulletLines = lines
    .map((line) => line.replace(/^[-*•]\s+|^\d+[.)]\s+/u, "").trim())
    .filter(Boolean);
  if (bulletLines.length >= 2) {
    return bulletLines.slice(0, 4);
  }
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((step) => step.trim())
    .filter(Boolean)
    .slice(0, 4);
}

/**
 * Parse a planning-only assistant response into {explanation, steps}.
 * Returns null when the input is empty.
 *
 * Used to enrich the retry instruction with the agent's prior plan so
 * the model has context about what it just narrated (rather than
 * starting from scratch on the retry turn).
 */
export function extractPlanningOnlyPlanDetails(text: string): PlanningOnlyPlanDetails | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    explanation: trimmed,
    steps: extractPlanningOnlySteps(trimmed),
  };
}

// ---------------------------------------------------------------------------
// Escalating-instruction selectors
// ---------------------------------------------------------------------------

/**
 * Pick the right PLANNING_ONLY retry instruction based on how many
 * times this cycle has already triggered.
 *   attemptIndex 0  → standard
 *   attemptIndex 1  → firm
 *   attemptIndex 2+ → final
 *
 * Verbatim escalation table from openclaw-1.
 */
export function resolveEscalatingPlanningRetryInstruction(attemptIndex: number): string {
  if (attemptIndex <= 0) return PLANNING_ONLY_RETRY_INSTRUCTION;
  if (attemptIndex === 1) return PLANNING_ONLY_RETRY_INSTRUCTION_FIRM;
  return PLANNING_ONLY_RETRY_INSTRUCTION_FINAL;
}

/**
 * Pick the right PLAN_MODE_ACK_ONLY retry instruction.
 *   retryAttemptIndex 0  → standard
 *   retryAttemptIndex 1+ → firm
 */
export function resolveEscalatingPlanModeAckOnlyInstruction(retryAttemptIndex: number): string {
  return retryAttemptIndex >= 1
    ? PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM
    : PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION;
}

/**
 * Pick the right PLAN_APPROVED_YIELD retry instruction.
 *   retryAttemptIndex 0  → standard
 *   retryAttemptIndex 1+ → firm
 */
export function resolveEscalatingPlanApprovedYieldInstruction(retryAttemptIndex: number): string {
  return retryAttemptIndex >= 1
    ? PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM
    : PLAN_APPROVED_YIELD_RETRY_INSTRUCTION;
}

// ---------------------------------------------------------------------------
// Plugin-side resolver: runs from `agent_end` lifecycle hook with
// access to the full message array post-turn (vs original which had
// per-attempt EmbeddedRunAttemptResult). This is the coarser version
// of `resolvePlanModeAckOnlyRetryInstruction` from openclaw-1.
// ---------------------------------------------------------------------------

export type RetryDecision =
  | {
      kind: "plan_mode_ack_only" | "plan_approved_yield" | "planning_only";
      instruction: string;
      attemptIndex: number;
    }
  | { kind: "skip"; reason: string };

export interface AgentEndContext {
  /** Full message array from PluginHookAgentEndEvent (post-turn). */
  messages: unknown[];
  /** Current Smarter-Claw session state (post-turn). */
  state: SmarterClawSessionState | undefined;
  /** Wall-clock now in ms; injectable for tests. */
  nowMs?: number;
}

/**
 * Top-level resolver: walks the post-turn message array, decides which
 * (if any) of the three retry detectors should fire, and returns the
 * instruction text + attempt index so the caller can:
 *   1. Enqueue the instruction in `pendingAgentInjections`.
 *   2. Bump the matching counter in `state.retryCounters`.
 *
 * Returns `{ kind: "skip", reason }` when no detector fires (the
 * common case — most turns end normally).
 */
export function resolveRetryDecision(ctx: AgentEndContext): RetryDecision {
  const state = ctx.state;
  const now = ctx.nowMs ?? Date.now();
  const lastAssistant = findLastAssistantMessage(ctx.messages);
  if (!lastAssistant) {
    return { kind: "skip", reason: "no last assistant message" };
  }
  const visibleText = extractVisibleText(lastAssistant);
  const toolNames = collectTurnToolNames(ctx.messages);

  // Cheap pre-check: the agent already submitted a plan this turn —
  // none of the three detectors apply.
  if (toolNames.includes("exit_plan_mode")) {
    return { kind: "skip", reason: "exit_plan_mode fired this turn" };
  }

  const planModeActive = state?.planMode === "plan";
  const recentlyApprovedAtMs = state?.recentlyApprovedAt
    ? new Date(state.recentlyApprovedAt).getTime()
    : undefined;
  const withinAckGrace =
    typeof recentlyApprovedAtMs === "number" &&
    now - recentlyApprovedAtMs < POST_APPROVAL_ACK_ONLY_GRACE_MS;
  const withinYieldGrace =
    typeof recentlyApprovedAtMs === "number" &&
    now - recentlyApprovedAtMs < POST_APPROVAL_YIELD_GRACE_MS;

  // Detector 1: plan_mode_ack_only — plan mode active (or recently
  // approved within grace) AND the agent did not call exit_plan_mode
  // AND did not call any investigative tool.
  if (planModeActive || withinAckGrace) {
    const calledInvestigativeTool = toolNames.some(
      (n) =>
        PLAN_MODE_INVESTIGATIVE_TOOL_NAMES.has(n) &&
        n !== "update_plan" &&
        n !== "enter_plan_mode",
    );
    const calledNonPlanTool = toolNames.some((n) => !PLAN_MODE_INVESTIGATIVE_TOOL_NAMES.has(n));
    const textLength = visibleText.length;
    if (
      !calledInvestigativeTool &&
      !calledNonPlanTool &&
      textLength > 0 &&
      textLength <= PLAN_MODE_ACK_ONLY_MAX_VISIBLE_TEXT
    ) {
      const attemptIndex = state?.retryCounters?.planModeAckOnly ?? 0;
      if (attemptIndex < DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT) {
        return {
          kind: "plan_mode_ack_only",
          instruction: resolveEscalatingPlanModeAckOnlyInstruction(attemptIndex),
          attemptIndex,
        };
      }
      return { kind: "skip", reason: "plan_mode_ack_only retry limit reached" };
    }
  }

  // Detector 2: plan_approved_yield — within yield grace post-approval
  // AND the agent yielded without taking any main-lane action.
  // "Main-lane" = anything other than update_plan or yield itself.
  if (withinYieldGrace && state?.planApproval === "approved") {
    const calledMainLaneTool = toolNames.some((n) => n !== "update_plan");
    if (!calledMainLaneTool) {
      const attemptIndex = state?.retryCounters?.planApprovedYield ?? 0;
      if (attemptIndex < DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT) {
        return {
          kind: "plan_approved_yield",
          instruction: resolveEscalatingPlanApprovedYieldInstruction(attemptIndex),
          attemptIndex,
        };
      }
      return { kind: "skip", reason: "plan_approved_yield retry limit reached" };
    }
  }

  // Detector 3: planning_only — agent narrated a multi-step plan
  // without calling any tool. Outside-plan-mode equivalent of detector
  // 1. Stricter than the ack-only detector to avoid false-firing on
  // every single-sentence chat reply: requires at least 2 distinct
  // steps AND a planning cue (matches openclaw-1's
  // hasStructuredPlanningOnlyFormat: bulletLineCount >= 2 OR planning
  // heading + planning cue).
  if (!planModeActive && toolNames.length === 0 && visibleText.length > 0) {
    if (hasStructuredPlanningOnlyFormat(visibleText)) {
      const planDetails = extractPlanningOnlyPlanDetails(visibleText);
      if (planDetails && planDetails.steps.length >= 2) {
        const attemptIndex = state?.retryCounters?.planningOnly ?? 0;
        if (attemptIndex <= 2) {
          return {
            kind: "planning_only",
            instruction: resolveEscalatingPlanningRetryInstruction(attemptIndex),
            attemptIndex,
          };
        }
        return { kind: "skip", reason: "planning_only escalation cap reached" };
      }
    }
  }

  return { kind: "skip", reason: "no detector matched" };
}

// ---------------------------------------------------------------------------
// AgentMessage shape adapters (loose — host AgentMessage differs across
// versions; keep parsing defensive)
// ---------------------------------------------------------------------------

function findLastAssistantMessage(messages: unknown[]): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (rec.role === "assistant") return rec;
  }
  return null;
}

function extractVisibleText(message: Record<string, unknown>): string {
  // Try the most common shapes:
  //   { content: "string" }
  //   { content: [{ type: "text", text: "..." }, ...] }
  //   { text: "string" }
  const direct = message.content;
  if (typeof direct === "string") return direct.trim();
  if (Array.isArray(direct)) {
    const parts: string[] = [];
    for (const block of direct) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
    return parts.join("\n").trim();
  }
  if (typeof message.text === "string") return message.text.trim();
  return "";
}

function collectTurnToolNames(messages: unknown[]): string[] {
  // Walk back from the end until we hit a non-assistant non-tool message
  // (i.e., the start of the current turn). Collect every toolName along
  // the way.
  const names: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (rec.role === "user" || rec.role === "system") break;
    const toolName =
      (rec.toolName as string | undefined) ??
      (rec.tool_name as string | undefined) ??
      (typeof rec.tool === "object" && rec.tool !== null
        ? ((rec.tool as Record<string, unknown>).name as string | undefined)
        : undefined);
    if (typeof toolName === "string" && toolName.length > 0) {
      names.push(toolName);
    }
  }
  return names;
}
