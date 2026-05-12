/**
 * Shared persist helpers for the plan-mode tools.
 *
 * The four tools (enter_plan_mode, exit_plan_mode, ask_user_question,
 * plan_mode_status) all need to flip session state through the
 * runtime-api `persistSmarterClawState` helper. This module gives
 * them a uniform shape so each tool isn't reimplementing the load
 * → mutate → save round-trip.
 *
 * Returns are deliberately permissive — when the installer hasn't
 * run yet (no session-write API), persistSmarterClawState returns
 * `{ persisted: false, reason }` and the tools log + degrade to
 * advisory text instead of throwing.
 */

import {
  persistSmarterClawState,
  type PersistSmarterClawStateResult,
} from "../../runtime-api.js";
import { logPlanModeDebug } from "../debug-log.js";
import {
  newPlanApprovalId,
  type PlanProposal,
  type SmarterClawSessionState,
} from "../types.js";

export type ToolPersistContext = {
  agentId?: string;
  sessionKey?: string;
};

/**
 * Persist a state mutation. Returns the result so callers can adapt
 * their tool-result text depending on whether persistence actually
 * landed. Logs every persist attempt via the debug stream.
 */
export async function persistFromTool(
  ctx: ToolPersistContext,
  tool: string,
  update: (current: SmarterClawSessionState | undefined) => SmarterClawSessionState | undefined,
): Promise<PersistSmarterClawStateResult> {
  if (!ctx.agentId || !ctx.sessionKey) {
    const reason = "tool factory did not receive agentId/sessionKey from plugin context";
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey: ctx.sessionKey ?? "<missing>",
      tool: `${tool}:persist:no-ctx`,
      details: { reason },
    });
    return { persisted: false, reason };
  }
  const result = await persistSmarterClawState({
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    update,
  });
  logPlanModeDebug({
    kind: "tool_call",
    sessionKey: ctx.sessionKey,
    tool: `${tool}:persist:${result.persisted ? "ok" : "skipped"}`,
    details: result.persisted ? undefined : { reason: result.reason },
  });
  return result;
}

/** State factory: flip into plan mode, fresh cycle. */
export function enterPlanModeStateUpdate(
  current: SmarterClawSessionState | undefined,
): SmarterClawSessionState {
  const base: SmarterClawSessionState = current ?? {
    planMode: "normal",
    planApproval: "idle",
    autoApprove: false,
  };
  return {
    ...base,
    planMode: "plan",
    planApproval: "idle",
    pendingInteraction: undefined,
    pendingAgentInjections: [],
    // Reset escalating-retry counters on every fresh plan cycle so the
    // ack-only / planning-only / yield ladders re-start at "standard"
    // instead of inheriting "firm/final" from the previous cycle. Matches
    // openclaw-1 semantics where the counters lived in per-attempt
    // memory and were naturally fresh per cycle.
    retryCounters: undefined,
    cycleId: `cycle-${Date.now()}`,
  };
}

/** State factory: stash the proposed plan + arm the approval gate. */
export function exitPlanModeStateUpdate(
  proposal: PlanProposal,
): (current: SmarterClawSessionState | undefined) => SmarterClawSessionState {
  return (current) => {
    const base: SmarterClawSessionState = current ?? {
      planMode: "plan",
      planApproval: "idle",
      autoApprove: false,
    };
    const approvalId = newPlanApprovalId();
    return {
      ...base,
      planMode: "plan",
      planApproval: "awaiting-approval",
      lastPlanSteps: proposal,
      pendingInteraction: {
        kind: "approval",
        approvalId,
        deliveredAt: new Date().toISOString(),
      },
    };
  };
}

/** State factory: arm the pending-question approval id. */
export function askQuestionStateUpdate(
  current: SmarterClawSessionState | undefined,
): SmarterClawSessionState {
  const base: SmarterClawSessionState = current ?? {
    planMode: "plan",
    planApproval: "idle",
    autoApprove: false,
  };
  const approvalId = newPlanApprovalId();
  return {
    ...base,
    pendingQuestionApprovalId: approvalId,
    pendingInteraction: {
      kind: "question",
      approvalId,
      deliveredAt: new Date().toISOString(),
    },
  };
}
