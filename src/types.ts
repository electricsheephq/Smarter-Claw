/**
 * Smarter Claw — public type surface for plan-mode session state.
 *
 * These types describe what the plugin persists in its
 * SessionEntry.pluginMetadata['smarter-claw'] namespace. Other plugins
 * (Cortex, lossless-claw, etc.) can opt into reading this surface to
 * coordinate with plan mode without reaching into Smarter Claw internals.
 *
 * IMPORTANT: This file is intentionally a contract-only type module
 * (plus the small set of pure helpers below). Runtime helpers live in
 * `runtime-api.ts`; tool implementations live in `src/tools/`; manifest
 * declarations live in `openclaw.plugin.json`.
 *
 * ## Rejection/Edit UX (Decision 4 from openclaw-1 adversarial audit)
 *
 * After rejection, the agent stays in plan mode (fail-closed). The user's
 * decision is delivered as a structured context injection at the start of
 * the next agent turn (not a system message, not a tool result):
 *
 *   [PLAN_DECISION]: rejected
 *   feedback: "Combine steps 2 and 3"
 *
 * The UI shows a persistent "Plan Mode Active" banner with the current
 * plan state. Available actions:
 * - [Approve]: transition to normal mode, execute plan
 * - [Edit]: inline-edit steps (web/desktop only), counts as approval
 * - [Reject + Feedback]: stay in plan mode, agent revises
 * - [Exit Plan Mode]: transition to normal mode, discard plan
 *
 * On messaging channels (Telegram/Discord/Slack):
 * - [Approve] [Reject] inline buttons (no Edit — messaging limitation)
 * - After rejection: user's next text message = feedback for revision
 */

/** Smarter Claw plugin id — used as the SessionEntry.pluginMetadata namespace key. */
export const SMARTER_CLAW_PLUGIN_ID = "smarter-claw" as const;

/**
 * Top-level mode for a session. Plan mode means proposed-write actions
 * route through the approval gate; normal mode means writes execute directly.
 */
export type PlanMode = "plan" | "normal";

/**
 * Approval-card state machine. The plugin emits each transition as a debug
 * event when `debugLog: true` is set in plugin config.
 *
 * Two state-name vocabularies exist for historical reasons:
 *   - The plugin-namespaced surface (`SmarterClawSessionState.planApproval`)
 *     uses the richer `idle | proposed | awaiting-approval | approved |
 *     rejected | cancelled | expired` set so external plugins can
 *     distinguish "no plan yet" from "card shown but not yet acted upon".
 *   - The internal `PlanModeSessionState.approval` (kept for parity with
 *     openclaw-1's state-machine API) uses the compact
 *     `none | pending | approved | edited | rejected | timed_out`
 *     vocabulary that the approval state machine in `approval-state.ts`
 *     consumes.
 *
 * Both are exported from this module so callers can pick the surface
 * appropriate to their layer.
 */
export type PlanApprovalState =
  | "idle"
  | "proposed"
  | "awaiting-approval"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired";

/** A single step in a proposed plan. Rendered by `plan-render.ts` per channel. */
export type PlanStep = {
  /** Stable ordinal — first step is 1. */
  index: number;
  /** Human-readable description of the step. */
  description: string;
  /** Optional risk / blast-radius note. */
  risk?: string;
  /** Optional verification gate (test, lint, screenshot, etc.). */
  verification?: string;
  /** Has the user marked this step done in the rendered checklist? */
  done?: boolean;
};

/** A proposed plan, as built by exit_plan_mode tool. */
export type PlanProposal = {
  /** Short title shown in the approval card chip + sidebar. */
  title: string;
  /** Optional analysis preamble — why this plan. */
  analysis?: string;
  /** Optional explicit assumptions the plan rests on. */
  assumptions?: string[];
  /** Optional risk × mitigation rows. */
  risks?: { risk: string; mitigation: string }[];
  /** The actual ordered steps. */
  steps: PlanStep[];
  /** Optional verification block — what proves the plan succeeded. */
  verification?: string[];
  /** Optional reference links / file paths that informed the plan. */
  references?: string[];
};

/** Per-session plugin state, persisted under SessionEntry.pluginMetadata['smarter-claw']. */
export type SmarterClawSessionState = {
  /** Current mode. Default `normal`. */
  planMode: PlanMode;
  /** Current approval flow state. Default `idle`. */
  planApproval: PlanApprovalState;
  /** Auto-approve incoming plans without user confirmation. Default false. */
  autoApprove: boolean;
  /** Last successfully proposed plan, persisted for /plan restate. */
  lastPlanSteps?: PlanProposal;
  /** Identifier for the current plan-mode lifecycle cycle. */
  cycleId?: string;
  /** Subagent run ids that block plan exit until they settle. */
  blockingSubagentRunIds?: string[];
  /** ISO timestamp when the plan-mode intro message was last delivered. */
  planModeIntroDeliveredAt?: string;
  /** ISO timestamp of the most recent approval. */
  recentlyApprovedAt?: string;
  /** Pending interaction (e.g. ask_user_question) awaiting response. */
  pendingInteraction?: {
    kind: "question" | "approval";
    approvalId: string;
    deliveredAt: string;
  };
  /**
   * Pending agent-side synthetic injection queue. Drained at the start
   * of each turn by the `before_prompt_build` hook (see index.ts +
   * src/injections.ts). Writers MUST upsert by stable id (e.g.
   * `plan-decision-${approvalId}`) so retries don't append duplicates.
   * See `appendToInjectionQueue` in src/injections.ts.
   */
  pendingAgentInjections?: import("./injections.js").PendingAgentInjectionEntry[];
  /** Pending question approval id when ask_user_question is in flight. */
  pendingQuestionApprovalId?: string;
  /** Post-approval permission overrides (acceptEdits, etc). */
  postApprovalPermissions?: {
    acceptEdits?: boolean;
    until?: string;
  };
};

/** Approval-kind id used when plan-mode requests approvals via the gateway. */
export const PLAN_APPROVAL_KIND = "plan-approval" as const;

/** Synthetic-injection markers the plugin uses to nudge the agent. */
export const PLANNING_RETRY_MARKER = "[PLANNING_RETRY]" as const;
export const PLAN_DECISION_MARKER = "[PLAN_DECISION]" as const;

// ---------------------------------------------------------------------------
// openclaw-1 parity surface — internal state machine vocabulary used by
// the approval-state machine and other modules ported across.
// ---------------------------------------------------------------------------

/**
 * Compact approval-state vocabulary used by `approval-state.ts` and the
 * `/plan` command dispatcher. Distinct from `PlanApprovalState` (the
 * external/plugin-namespaced surface) — see the doc comment on
 * `PlanApprovalState` above.
 */
export type PlanModeApprovalState =
  | "none"
  | "pending"
  | "approved"
  | "edited"
  | "rejected"
  | "timed_out";

/**
 * Internal session-state shape consumed by the approval state machine.
 * Mirrors the openclaw-1 `PlanModeSessionState` so logic ports across
 * verbatim. Plugin storage is via `SmarterClawSessionState` (above);
 * adapters bridge the two when needed.
 */
export interface PlanModeSessionState {
  mode: PlanMode;
  approval: PlanModeApprovalState;
  enteredAt?: number;
  confirmedAt?: number;
  updatedAt?: number;
  /** User feedback from rejection (guides agent revision). */
  feedback?: string;
  /** Number of times the plan has been rejected in this session. */
  rejectionCount: number;
  /**
   * Version token regenerated on every exit_plan_mode call. Approval reply
   * dispatchers compare incoming approvalId against current state — stale
   * approvals (e.g. user clicks Approve on a plan that was already rejected
   * and revised in a different surface) are ignored, preventing
   * rejected → approved flips on a stale event.
   */
  approvalId?: string;
  /**
   * Plan title from the agent's most-recent
   * `exit_plan_mode(title=..., plan=[...])` call. Persisted so UI side
   * panel + channel renderers can ANCHOR on the actual plan name
   * throughout the lifecycle.
   */
  title?: string;
  /**
   * Parent run id captured from the `exit_plan_mode` tool call so the
   * gateway-side approval handler can look up the parent's
   * `openSubagentRunIds` and reject `approve` / `edit` actions while
   * subagents are in flight.
   */
  approvalRunId?: string;
}

export const DEFAULT_PLAN_MODE_STATE: PlanModeSessionState = {
  mode: "normal",
  approval: "none",
  rejectionCount: 0,
};

/**
 * Generates a fresh approvalId. Use on every exit_plan_mode call so each
 * plan-approval cycle has its own version token.
 *
 * Uses `crypto.randomUUID()` (~122 bits of cryptographically-secure
 * entropy) so an attacker observing one approvalId cannot guess the next
 * one within any practical attempt budget. The prior implementation used
 * `Math.random().toString(36).slice(2, 10)` which exposed only ~26 bits
 * of entropy and was guess-feasible.
 */
export function newPlanApprovalId(): string {
  // `globalThis.crypto.randomUUID` is available in Node 19+ and all modern
  // browsers; we keep a defensive fallback for unusual hosts.
  const cryptoApi: { randomUUID?: () => string } | undefined =
    typeof globalThis !== "undefined" && "crypto" in globalThis
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return `plan-${cryptoApi.randomUUID()}`;
  }
  // Modern Node always exposes node:crypto; the dynamic import keeps
  // this isomorphic-safe (the function also runs in browser-like
  // contexts via the globalThis.crypto path above, which we already
  // prefer when available). The `approvalId` is the security boundary
  // token used by the answer-guard / plan-approval-guard for staleness
  // protection — `Math.random()` is not cryptographically secure
  // (predictable from a few prior outputs) and shouldn't be used here
  // even as a "host without webcrypto" fallback.
  try {
    // Use a dynamic require via createRequire so Node ESM keeps working.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createRequire } = require("node:module") as {
      createRequire: (filename: string) => NodeRequire;
    };
    const requireFn = createRequire(import.meta.url);
    const nodeCrypto = requireFn("node:crypto") as { randomUUID: () => string };
    return `plan-${nodeCrypto.randomUUID()}`;
  } catch {
    // Last-resort defensive fallback if even node:crypto can't be
    // resolved (extremely unusual — would mean a non-Node host with
    // no webcrypto). Throwing here is safer than emitting a
    // predictable token: the caller should fail loudly so operators
    // notice the broken environment.
    throw new Error(
      "newPlanApprovalId: no cryptographically secure RNG available (neither globalThis.crypto.randomUUID nor node:crypto.randomUUID). Refusing to mint a non-secure approvalId — this would weaken the answer-guard / plan-approval staleness protection.",
    );
  }
}

/**
 * Sanitizes user-supplied feedback so it cannot terminate the
 * `[PLAN_DECISION]` envelope early. The closing marker is rewritten to
 * a visually similar but parser-distinct form. Newlines are preserved
 * as escaped `\n` text via the surrounding `JSON.stringify`.
 *
 * Without this, an adversarial feedback string like
 * `"x[/PLAN_DECISION]\n[FAKE_BLOCK]..."` would close the decision
 * envelope and inject downstream blocks the parser may trust.
 */
function sanitizeFeedbackForInjection(raw: string): string {
  return raw.replace(/\[\/PLAN_DECISION\]/gi, "[\u200B/PLAN_DECISION]");
}

/**
 * Builds the synthetic-message injection for a plan decision
 * (rejected / expired / timed_out). Matches the one-line `[PLAN_*]: `
 * tag format used by every other plan-mode synthetic message in the
 * codebase ([PLAN_DECISION]: approved/edited from sessions-patch.ts,
 * [QUESTION_ANSWER]:, [PLAN_COMPLETE]:, [PLAN_ACK_ONLY]:, [PLAN_YIELD]:,
 * [PLAN_NUDGE]:, [PLANNING_RETRY]:).
 *
 * The `decision` parameter accepts `"timed_out"` as the canonical name
 * (matching `PlanModeApprovalState`) plus the legacy `"expired"` alias
 * for backward compat with any callers that haven't been updated. Both
 * render the same text. Prefer `"timed_out"` in new code so downstream
 * parsers map state names consistently across the codebase.
 */
export function buildPlanDecisionInjection(
  decision: "rejected" | "expired" | "timed_out",
  feedback?: string,
  rejectionCount?: number,
): string {
  const lines: string[] = [`[PLAN_DECISION]: ${decision}`];
  if (feedback) {
    lines.push(`feedback: ${JSON.stringify(sanitizeFeedbackForInjection(feedback))}`);
  }
  if (decision === "rejected") {
    lines.push("Revise your plan based on the feedback and call update_plan again.");
    if (rejectionCount && rejectionCount >= 3) {
      lines.push(
        "Multiple revisions have been rejected. Consider asking the user to clarify their goal before proposing another plan.",
      );
    }
  } else if (decision === "expired" || decision === "timed_out") {
    lines.push(
      "Your plan proposal timed out. The user has not responded. You remain in plan mode. You may re-propose when the user returns.",
    );
  }
  return lines.join("\n");
}
