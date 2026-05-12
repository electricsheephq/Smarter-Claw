/**
 * `exit_plan_mode` agent tool.
 *
 * host_ref: src/agents/tools/exit-plan-mode-tool.ts (in-host source-of-truth)
 *
 * # What this does
 *
 * The agent calls `exit_plan_mode(title, plan, summary?)` to PROPOSE
 * the current plan for user approval. The plugin:
 *   1. Validates the plan steps (at most one `in_progress`)
 *   2. Computes the payloadHash (Invariant 3 duplicate-detection input)
 *   3. Mints an approvalId (security boundary token)
 *   4. Persists approval-pending state via PlanModeStore (the 10-invariant
 *      race-fix anchor)
 *   5. Returns a structured result for the model + downstream UI
 *
 * # Schema scope (P-4)
 *
 * P-4 ships the CORE schema: title, plan, summary. The archetype
 * fields (analysis / assumptions / risks / verification / references)
 * are PR-10 from the in-host tree and land here at P-8 (archetype
 * port). For P-4 we accept them as optional pass-through so the
 * agent's schema-aware call doesn't fail, but we don't enforce
 * required-ness or persist them yet.
 *
 * # In-host vs plugin port
 *
 * Same as enter_plan_mode: in-host the runner intercepts the tool
 * call and applies state transitions. Plugin port calls
 * PlanModeStore.persistApprovalRequest from the tool body directly.
 */

import { Type } from "typebox";
import { computePlanPayloadHash } from "../helpers/payload-hash.js";
import { newPlanApprovalId } from "../helpers/approval-id.js";
import { PlanModeStore } from "../state/store.js";
import {
  PLAN_STEP_STATUSES,
  type PlanStepStatus,
  ToolInputError,
  readStringParam,
} from "./common.js";
import type { PlanStep } from "../types.js";

export interface CreateExitPlanModeToolInput {
  store: PlanModeStore;
}

interface ToolContext {
  sessionKey?: string;
}

const SCHEMA = Type.Object(
  {
    title: Type.Optional(
      Type.String({
        description:
          "Concise plan name (under 80 chars). Used as the approval-card header. " +
          'Examples: "Migrate VM provisioning to golden snapshot", "Fix websocket reconnect race". ' +
          "Do NOT put plan content here — that goes in `plan` and `summary`.",
      }),
    ),
    plan: Type.Array(
      Type.Object(
        {
          step: Type.String({ description: "Short plan step." }),
          status: Type.String({
            enum: [...PLAN_STEP_STATUSES],
            description:
              'One of "pending", "in_progress", "completed", or "cancelled".',
          }),
          activeForm: Type.Optional(
            Type.String({
              description:
                'Present-continuous form shown while in_progress (e.g. "Running tests").',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        description:
          "The plan being proposed for approval. At most one step may be in_progress.",
      },
    ),
    summary: Type.Optional(
      Type.String({
        description:
          "Optional one-line summary surfaced in the approval prompt.",
      }),
    ),
    // PR-10 archetype fields — accepted but not yet persisted (P-8).
    analysis: Type.Optional(Type.String()),
    assumptions: Type.Optional(Type.Array(Type.String())),
    risks: Type.Optional(
      Type.Array(
        Type.Object(
          {
            risk: Type.String(),
            mitigation: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    verification: Type.Optional(Type.Array(Type.String())),
    references: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const TOOL_DESCRIPTION =
  "Propose the current plan for user approval. The user gets " +
  "Approve / Reject buttons. On Approve, mutations resume and the " +
  "agent executes the plan. On Reject with feedback, the agent stays " +
  "in plan mode and revises. Always call this AFTER `enter_plan_mode` " +
  "+ any read-only investigation; never respond with the plan as " +
  "chat text (the user won't see the approval card).";

/**
 * Validate the plan steps. Throws ToolInputError on schema violations
 * the agent can recover from; the agent sees the error message and
 * can call again with corrections.
 *
 * host_ref: src/agents/tools/exit-plan-mode-tool.ts:155-200 (readPlanSteps)
 */
function readPlanSteps(params: Record<string, unknown>): PlanStep[] {
  const rawPlan = params.plan;
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    throw new ToolInputError(
      "plan required (cannot exit plan mode without a proposal)",
    );
  }
  const steps = rawPlan.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ToolInputError(`plan[${index}] must be an object`);
    }
    const stepParams = entry as Record<string, unknown>;
    const step = readStringParam(stepParams, "step", {
      required: true,
      label: `plan[${index}].step`,
    });
    const status = readStringParam(stepParams, "status", {
      required: true,
      label: `plan[${index}].status`,
    });
    if (!PLAN_STEP_STATUSES.includes(status as PlanStepStatus)) {
      throw new ToolInputError(
        `plan[${index}].status must be one of ${PLAN_STEP_STATUSES.join(", ")}`,
      );
    }
    const activeForm = readStringParam(stepParams, "activeForm");
    // Build the step record explicitly to avoid optional-spread
    // allocations + keep TS happy on the discriminated union.
    const stepRecord: PlanStep = {
      step: step!,
      status: status as PlanStepStatus,
    };
    if (activeForm) {
      stepRecord.activeForm = activeForm;
    }
    return stepRecord;
  });
  const inProgressCount = steps.filter(
    (entry) => entry.status === "in_progress",
  ).length;
  if (inProgressCount > 1) {
    throw new ToolInputError(
      "plan can contain at most one in_progress step",
    );
  }
  return steps;
}

export function createExitPlanModeTool(opts: CreateExitPlanModeToolInput) {
  return (ctx: ToolContext) => ({
    label: "Exit Plan Mode",
    name: "exit_plan_mode",
    description: TOOL_DESCRIPTION,
    parameters: SCHEMA,
    execute: async (
      _toolCallId: string,
      args: unknown,
      _signal?: AbortSignal,
    ) => {
      const params = (args ?? {}) as Record<string, unknown>;
      let steps: PlanStep[];
      try {
        steps = readPlanSteps(params);
      } catch (err) {
        if (err instanceof ToolInputError) {
          return {
            content: [
              { type: "text" as const, text: `exit_plan_mode: ${err.message}` },
            ],
            details: { status: "invalid-input" as const, error: err.message },
          };
        }
        throw err; // unexpected — propagate
      }
      const title = readStringParam(params, "title");
      const summary = readStringParam(params, "summary");

      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "exit_plan_mode: no sessionKey resolvable in this context; " +
                "cannot persist approval state. This indicates a plugin wiring issue.",
            },
          ],
          details: { status: "no-session" as const },
        };
      }

      const approvalIdCandidate = newPlanApprovalId();
      const payloadHash = computePlanPayloadHash({
        title,
        summary,
        steps,
      });

      const r = await opts.store.persistApprovalRequest({
        sessionKey,
        approvalId: approvalIdCandidate,
        title,
        payloadHash,
        lastPlanSteps: steps,
      });

      // Map store outcome → tool result.
      let statusText: string;
      let status:
        | "approval-requested"
        | "duplicate-detected"
        | "not-in-plan-mode"
        | "failed";
      switch (r.kind) {
        case "persisted":
          status = "approval-requested";
          statusText =
            `Plan submitted for approval (${steps.length} ${steps.length === 1 ? "step" : "steps"}). ` +
            "Waiting for user Approve/Reject.";
          break;
        case "reused":
          status = "duplicate-detected";
          statusText =
            `Plan duplicate detected (payloadHash=${payloadHash}); reused existing approval card. ` +
            "If the user has already approved, you may proceed; otherwise wait.";
          break;
        case "skipped":
          status = "not-in-plan-mode";
          statusText =
            "exit_plan_mode called while session is NOT in plan mode. " +
            "Call enter_plan_mode first if you intend to propose a plan.";
          break;
        case "failed":
          status = "failed";
          statusText =
            "exit_plan_mode encountered an error persisting the approval. " +
            `Cause: ${r.error.message}. The candidate approvalId was ${r.approvalId}; ` +
            "downstream UI may or may not have received it.";
          break;
      }

      return {
        content: [{ type: "text" as const, text: statusText }],
        details: {
          status,
          approvalId: r.approvalId,
          payloadHash,
          stepCount: steps.length,
          ...(title ? { title } : {}),
          ...(summary ? { summary } : {}),
        },
      };
    },
  });
}
