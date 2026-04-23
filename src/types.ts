/**
 * Smarter Claw — public type surface for plan-mode session state.
 *
 * These types describe what the plugin persists in its
 * SessionEntry.pluginMetadata['smarter-claw'] namespace. Other plugins
 * (Cortex, lossless-claw, etc.) can opt into reading this surface to
 * coordinate with plan mode without reaching into Smarter Claw internals.
 *
 * IMPORTANT: This file is intentionally a contract-only type module.
 * Runtime helpers live in `runtime-api.ts`; tool implementations live in
 * `src/tools/`; manifest declarations live in `openclaw.plugin.json`.
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
  /** Pending agent-side synthetic injection queued for next turn. */
  pendingAgentInjection?: {
    kind: "plan-decision" | "planning-retry";
    body: string;
    queuedAt: string;
  };
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
