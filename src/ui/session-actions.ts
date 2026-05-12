/**
 * Plan-Mode session actions — the operator-side API for resolving an
 * approval cycle.
 *
 * **Parity contract**: mirrors the semantics of the in-host
 * `resolvePlanApproval` dispatcher at
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/plan-mode/approval.ts:44-130`
 * (commit `ea04ea52c7`). The in-host version returns a pure state
 * transition; we route through PlanModeStore (which encapsulates the
 * write + audit) and then enqueue the corresponding pendingAgentInjection.
 *
 * # Action ids
 *
 * The host's session-action dispatcher addresses these by
 * (pluginId, actionId). We keep action ids stable across versions —
 * UI clients hard-code these strings.
 *
 *   - `plan.accept` — user approved the pending plan (verbatim).
 *   - `plan.edit`   — user inline-edited + submitted (counts as approval).
 *   - `plan.reject` — user rejected (with optional feedback).
 *   - `plan.cancel` — user wants out of plan mode entirely.
 *   - `plan.answer` — user answered a pending ask_user_question.
 *   - `plan.auto.toggle` — toggle auto-approve self-execution mode.
 *
 * # Stale-event guard
 *
 * Every approval action accepts an OPTIONAL `expectedApprovalId` in
 * payload. When provided, the handler verifies it matches the session's
 * current approvalId before mutating. Mismatch → action rejected as
 * stale (`ok: false`, code: "STALE_APPROVAL_ID"). This mirrors the
 * in-host's stale-event guard at approval.ts:64-72 — load-bearing for
 * channel-handler flows where UI state can lag behind server state.
 *
 * host_ref: src/agents/plan-mode/approval.ts:44-130 (stale + terminal
 *   guards), src/gateway/sessions-patch.ts (the dispatch surface that
 *   calls resolvePlanApproval + pendingAgentInjection writers).
 */

import type {
  OpenClawPluginApi,
  PluginSessionActionContext,
  PluginSessionActionRegistration,
  PluginSessionActionResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  enqueuePlanApprovedInjection,
  enqueuePlanDecisionInjection,
  enqueueQuestionAnswerInjection,
} from "../runtime/injection-writer.js";
import type { PlanModeStore } from "../state/store.js";

/**
 * Common error codes returned by `ok: false` results. UI clients can
 * use the code to render a specific error message.
 */
export const SESSION_ACTION_ERROR_CODES = {
  MISSING_SESSION_KEY: "MISSING_SESSION_KEY",
  STALE_APPROVAL_ID: "STALE_APPROVAL_ID",
  NOT_IN_PLAN_MODE: "NOT_IN_PLAN_MODE",
  NO_PENDING_APPROVAL: "NO_PENDING_APPROVAL",
  STORE_ERROR: "STORE_ERROR",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
} as const;

export type SessionActionErrorCode =
  (typeof SESSION_ACTION_ERROR_CODES)[keyof typeof SESSION_ACTION_ERROR_CODES];

function err(
  code: SessionActionErrorCode,
  message: string,
): PluginSessionActionResult {
  return { ok: false, error: message, code };
}

function requireSessionKey(
  ctx: PluginSessionActionContext,
): { ok: true; sessionKey: string } | { ok: false; result: PluginSessionActionResult } {
  if (!ctx.sessionKey) {
    return {
      ok: false,
      result: err(
        SESSION_ACTION_ERROR_CODES.MISSING_SESSION_KEY,
        "session-action requires a sessionKey",
      ),
    };
  }
  return { ok: true, sessionKey: ctx.sessionKey };
}

function readPayload(
  payload: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; result: PluginSessionActionResult } {
  if (payload === undefined || payload === null) {
    return { ok: true, value: {} };
  }
  if (typeof payload !== "object") {
    return {
      ok: false,
      result: err(
        SESSION_ACTION_ERROR_CODES.INVALID_PAYLOAD,
        "payload must be an object",
      ),
    };
  }
  return { ok: true, value: payload as Record<string, unknown> };
}

function readStringField(
  payload: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = payload[field];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBooleanField(
  payload: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const v = payload[field];
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Validate `expectedApprovalId` against the session's current state.
 * Returns the resolved approvalId on success.
 */
async function checkApprovalId(
  store: PlanModeStore,
  sessionKey: string,
  expectedApprovalId: string | undefined,
): Promise<{ ok: true; currentApprovalId: string } | { ok: false; result: PluginSessionActionResult }> {
  const snap = await store.readSnapshot(sessionKey);
  if (!snap || snap.mode !== "plan") {
    return {
      ok: false,
      result: err(
        SESSION_ACTION_ERROR_CODES.NOT_IN_PLAN_MODE,
        "session is not in plan mode",
      ),
    };
  }
  if (snap.approval !== "pending") {
    return {
      ok: false,
      result: err(
        SESSION_ACTION_ERROR_CODES.NO_PENDING_APPROVAL,
        `session has no pending approval (approval=${snap.approval})`,
      ),
    };
  }
  if (!snap.approvalId) {
    return {
      ok: false,
      result: err(
        SESSION_ACTION_ERROR_CODES.NO_PENDING_APPROVAL,
        "session has no approvalId on pending state",
      ),
    };
  }
  if (
    expectedApprovalId !== undefined &&
    expectedApprovalId !== snap.approvalId
  ) {
    return {
      ok: false,
      result: err(
        SESSION_ACTION_ERROR_CODES.STALE_APPROVAL_ID,
        `expectedApprovalId did not match current approvalId; event is stale`,
      ),
    };
  }
  return { ok: true, currentApprovalId: snap.approvalId };
}

export interface SessionActionsDeps {
  api: OpenClawPluginApi;
  store: PlanModeStore;
  /**
   * Optional logger override. Defaults to api.logger.
   */
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

/**
 * Build the full set of session-action registrations. Each returned
 * registration is passed to `api.session.controls.registerSessionAction`.
 *
 * Caller wires them in plugin index.ts (P-12):
 * ```
 *   for (const action of createPlanModeSessionActions({ api, store })) {
 *     api.session.controls.registerSessionAction(action);
 *   }
 * ```
 */
export function createPlanModeSessionActions(
  deps: SessionActionsDeps,
): PluginSessionActionRegistration[] {
  const { api, store } = deps;
  const log = deps.logger ?? {
    info: (msg: string) => api.logger.info(msg),
    warn: (msg: string) => api.logger.warn(msg),
  };

  // ---------- plan.accept ----------
  const acceptAction: PluginSessionActionRegistration = {
    id: "plan.accept",
    description: "Approve the pending plan and resume agent execution.",
    handler: async (ctx) => {
      const sk = requireSessionKey(ctx);
      if (!sk.ok) return sk.result;
      const p = readPayload(ctx.payload);
      if (!p.ok) return p.result;
      const expectedApprovalId = readStringField(p.value, "approvalId");
      const check = await checkApprovalId(store, sk.sessionKey, expectedApprovalId);
      if (!check.ok) return check.result;
      const persist = await store.recordApproval({
        sessionKey: sk.sessionKey,
        edited: false,
      });
      if (persist.kind === "failed") {
        return err(
          SESSION_ACTION_ERROR_CODES.STORE_ERROR,
          `recordApproval failed: ${persist.error.message}`,
        );
      }
      if (persist.kind === "skipped") {
        return err(
          SESSION_ACTION_ERROR_CODES.NO_PENDING_APPROVAL,
          `recordApproval skipped: ${persist.reason}`,
        );
      }
      const enqueue = await enqueuePlanApprovedInjection(api, {
        sessionKey: sk.sessionKey,
        approvalId: check.currentApprovalId,
        edited: false,
      });
      log.info(
        `[smarter-claw] plan.accept resolved sessionKey=${sk.sessionKey} approvalId=${check.currentApprovalId} enqueued=${enqueue.enqueued}`,
      );
      return {
        ok: true,
        result: {
          approval: "approved",
          approvalId: check.currentApprovalId,
          injectionId: enqueue.id,
        },
        continueAgent: true,
      };
    },
  };

  // ---------- plan.edit ----------
  const editAction: PluginSessionActionRegistration = {
    id: "plan.edit",
    description:
      "Submit an inline-edited plan as the approved plan; agent uses the edited body.",
    handler: async (ctx) => {
      const sk = requireSessionKey(ctx);
      if (!sk.ok) return sk.result;
      const p = readPayload(ctx.payload);
      if (!p.ok) return p.result;
      const expectedApprovalId = readStringField(p.value, "approvalId");
      const editedBody = readStringField(p.value, "body");
      const check = await checkApprovalId(store, sk.sessionKey, expectedApprovalId);
      if (!check.ok) return check.result;
      const persist = await store.recordApproval({
        sessionKey: sk.sessionKey,
        edited: true,
      });
      if (persist.kind === "failed") {
        return err(
          SESSION_ACTION_ERROR_CODES.STORE_ERROR,
          `recordApproval failed: ${persist.error.message}`,
        );
      }
      if (persist.kind === "skipped") {
        return err(
          SESSION_ACTION_ERROR_CODES.NO_PENDING_APPROVAL,
          `recordApproval skipped: ${persist.reason}`,
        );
      }
      const enqueue = await enqueuePlanApprovedInjection(api, {
        sessionKey: sk.sessionKey,
        approvalId: check.currentApprovalId,
        edited: true,
        ...(editedBody ? { bodyText: editedBody } : {}),
      });
      log.info(
        `[smarter-claw] plan.edit resolved sessionKey=${sk.sessionKey} approvalId=${check.currentApprovalId} enqueued=${enqueue.enqueued}`,
      );
      return {
        ok: true,
        result: {
          approval: "edited",
          approvalId: check.currentApprovalId,
          injectionId: enqueue.id,
        },
        continueAgent: true,
      };
    },
  };

  // ---------- plan.reject ----------
  const rejectAction: PluginSessionActionRegistration = {
    id: "plan.reject",
    description: "Reject the pending plan with optional feedback.",
    handler: async (ctx) => {
      const sk = requireSessionKey(ctx);
      if (!sk.ok) return sk.result;
      const p = readPayload(ctx.payload);
      if (!p.ok) return p.result;
      const expectedApprovalId = readStringField(p.value, "approvalId");
      const feedback = readStringField(p.value, "feedback");
      const check = await checkApprovalId(store, sk.sessionKey, expectedApprovalId);
      if (!check.ok) return check.result;
      const persist = await store.recordRejection({
        sessionKey: sk.sessionKey,
        ...(feedback ? { feedback } : {}),
      });
      if (persist.kind === "failed") {
        return err(
          SESSION_ACTION_ERROR_CODES.STORE_ERROR,
          `recordRejection failed: ${persist.error.message}`,
        );
      }
      if (persist.kind === "skipped") {
        return err(
          SESSION_ACTION_ERROR_CODES.NO_PENDING_APPROVAL,
          `recordRejection skipped: ${persist.reason}`,
        );
      }
      const enqueue = await enqueuePlanDecisionInjection(api, {
        sessionKey: sk.sessionKey,
        approvalId: check.currentApprovalId,
        decision: "rejected",
        ...(feedback ? { feedback } : {}),
        rejectionCount: persist.rejectionCount,
      });
      log.info(
        `[smarter-claw] plan.reject resolved sessionKey=${sk.sessionKey} approvalId=${check.currentApprovalId} rejectionCount=${persist.rejectionCount} enqueued=${enqueue.enqueued}`,
      );
      return {
        ok: true,
        result: {
          approval: "rejected",
          approvalId: check.currentApprovalId,
          rejectionCount: persist.rejectionCount,
          injectionId: enqueue.id,
        },
        continueAgent: true,
      };
    },
  };

  // ---------- plan.cancel ----------
  const cancelAction: PluginSessionActionRegistration = {
    id: "plan.cancel",
    description: "Exit plan mode without resolving the pending plan.",
    handler: async (ctx) => {
      const sk = requireSessionKey(ctx);
      if (!sk.ok) return sk.result;
      const result = await store.exitPlanMode({ sessionKey: sk.sessionKey });
      if (result.kind === "failed") {
        return err(
          SESSION_ACTION_ERROR_CODES.STORE_ERROR,
          `exitPlanMode failed: ${result.error.message}`,
        );
      }
      log.info(
        `[smarter-claw] plan.cancel resolved sessionKey=${sk.sessionKey} kind=${result.kind}`,
      );
      return {
        ok: true,
        result: { kind: result.kind },
        // Don't auto-continue the agent — the session is leaving plan
        // mode; the next turn is user-driven.
        continueAgent: false,
      };
    },
  };

  // ---------- plan.answer ----------
  const answerAction: PluginSessionActionRegistration = {
    id: "plan.answer",
    description:
      "Answer a pending ask_user_question. Payload: { questionId, questionPrompt, selectedOption }.",
    handler: async (ctx) => {
      const sk = requireSessionKey(ctx);
      if (!sk.ok) return sk.result;
      const p = readPayload(ctx.payload);
      if (!p.ok) return p.result;
      const questionId = readStringField(p.value, "questionId");
      const questionPrompt = readStringField(p.value, "questionPrompt");
      const selectedOption = readStringField(p.value, "selectedOption");
      if (!questionId || !questionPrompt || !selectedOption) {
        return err(
          SESSION_ACTION_ERROR_CODES.INVALID_PAYLOAD,
          "plan.answer requires { questionId, questionPrompt, selectedOption }",
        );
      }
      const enqueue = await enqueueQuestionAnswerInjection(api, {
        sessionKey: sk.sessionKey,
        questionId,
        questionPrompt,
        selectedOption,
      });
      log.info(
        `[smarter-claw] plan.answer resolved sessionKey=${sk.sessionKey} questionId=${questionId} enqueued=${enqueue.enqueued}`,
      );
      return {
        ok: true,
        result: { injectionId: enqueue.id },
        continueAgent: true,
      };
    },
  };

  // ---------- plan.auto.toggle ----------
  const autoToggleAction: PluginSessionActionRegistration = {
    id: "plan.auto.toggle",
    description:
      "Toggle auto-approve self-execution mode. Payload: { enabled: boolean }.",
    handler: async (ctx) => {
      const sk = requireSessionKey(ctx);
      if (!sk.ok) return sk.result;
      const p = readPayload(ctx.payload);
      if (!p.ok) return p.result;
      const enabled = readBooleanField(p.value, "enabled");
      if (enabled === undefined) {
        return err(
          SESSION_ACTION_ERROR_CODES.INVALID_PAYLOAD,
          "plan.auto.toggle requires { enabled: boolean }",
        );
      }
      // P-13: typed mutator wires the flag through PlanModeStore so
      // the runtime accept-edits-gate (gates/accept-edits-gate.ts) can
      // read it via readSnapshot when deciding whether to fire layer-2
      // hard constraints during post-approval execution.
      const result = await store.setAutoApprove({
        sessionKey: sk.sessionKey,
        enabled,
      });
      if (result.kind === "failed") {
        return err(
          SESSION_ACTION_ERROR_CODES.STORE_ERROR,
          `setAutoApprove failed: ${result.error.message}`,
        );
      }
      log.info(
        `[smarter-claw] plan.auto.toggle sessionKey=${sk.sessionKey} enabled=${enabled} kind=${result.kind}`,
      );
      return {
        ok: true,
        result: { enabled: result.enabled, kind: result.kind },
      };
    },
  };

  return [
    acceptAction,
    editAction,
    rejectAction,
    cancelAction,
    answerAction,
    autoToggleAction,
  ];
}
