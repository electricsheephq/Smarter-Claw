/**
 * `exit_plan_mode` agent tool.
 *
 * host_ref: src/agents/tools/exit-plan-mode-tool.ts (in-host source-of-truth
 *           at commit ea04ea52c7).
 *
 * # What this does
 *
 * The agent calls `exit_plan_mode(title, plan, summary?, ...archetype)` to
 * PROPOSE the current plan for user approval. The plugin:
 *   1. Validates title is present + clamps to 80 chars (matches in-host)
 *   2. Validates plan steps (at most one `in_progress`)
 *   3. Parses optional archetype fields (analysis / assumptions / risks /
 *      verification / references) with trim + drop-blank-entries
 *   4. Computes the payloadHash (Invariant 3 duplicate-detection input)
 *   5. Mints an approvalId (security boundary token)
 *   6. Persists approval-pending state via PlanModeStore (the 10-invariant
 *      race-fix anchor)
 *   7. Returns a structured result for the model + downstream UI
 *
 * # Schema scope
 *
 * Full in-host schema — including the 5 archetype fields
 * (analysis / assumptions / risks / verification / references). Each
 * field description is byte-identical to in-host.
 *
 * # In-host vs plugin port
 *
 * Same as enter_plan_mode: in-host the runner intercepts the tool
 * call and applies state transitions. Plugin port calls
 * PlanModeStore.persistApprovalRequest from the tool body directly.
 *
 * # Surgical-port rationale (2026-05-12)
 *
 * Wave-1 audit slice S1 found:
 *   - title was schema-optional with no runtime check, so the agent's
 *     chat narration leaked into the approval card title slot
 *   - 80-char title clamp absent
 *   - archetype field descriptions stripped from the schema (so the
 *     model didn't know when to use them)
 *   - archetype field VALUES dropped from the tool result `details`
 *   - description text was a short paraphrase missing STOP AFTER,
 *     WAIT FOR SUBAGENTS, chat-text-banned, and reference-card pointer
 *
 * This file ports the full in-host schema + description + handler
 * verbatim where possible; plugin adaptations are limited to:
 *   - Plugin-side status names ("approval-requested" vs in-host
 *     "approval_requested") for consistency with the eva-live-smokes
 *     + session-action wiring
 *   - Skipping the subagent-gate (depends on host-internal
 *     `getAgentRunContext`; the gateway-side gate at sessions-patch.ts
 *     remains authoritative and is unchanged)
 *   - Persistence via PlanModeStore.persistApprovalRequest instead of
 *     in-host's `persistPlanApprovalRequest` helper
 */

import { Type } from "typebox";
import { newPlanApprovalId } from "../helpers/approval-id.js";
import { computePlanPayloadHash } from "../helpers/payload-hash.js";
import {
  describeExitPlanModeTool,
  EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
} from "../plan-mode/tool-descriptions.js";
import { PlanModeStore } from "../state/store.js";
import type { PlanStep } from "../types.js";
import {
  PLAN_STEP_STATUSES,
  type PlanStepStatus,
  ToolInputError,
  readStringParam,
} from "./common.js";

export interface CreateExitPlanModeToolInput {
  store: PlanModeStore;
}

interface ToolContext {
  sessionKey?: string;
}

const SCHEMA = Type.Object(
  {
    // PR-9 Tier 1: explicit plan title field. Without this the agent's
    // chat text above the tool call became the de-facto title (brittle —
    // sometimes the agent's narration leaked in instead of a real title).
    // Title is required-ish at the schema level but tolerated when
    // omitted (the runtime falls back to a clear required-error message
    // — see the runtime guard below).
    title: Type.Optional(
      Type.String({
        description:
          "Concise plan name (under 80 chars). Used as the approval-card header, " +
          "the sidebar title, and (when persisted) the markdown filename slug. " +
          'Examples: "Migrate VM provisioning to golden snapshot", ' +
          '"Fix websocket reconnect race in PR-67721". ' +
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
          "Optional one-line summary surfaced in the approval prompt (UI / channel renderers).",
      }),
    ),
    // PR-10 plan-archetype fields — all optional and backwards-compatible.
    // The plan-archetype system-prompt fragment (see plan-mode/plan-archetype-prompt.ts)
    // tells the agent when these are required vs nice-to-have.
    analysis: Type.Optional(
      Type.String({
        description:
          "Markdown body explaining current state, chosen approach, and rationale. " +
          "Multi-paragraph; this is the part of the plan that gives the user enough " +
          "context to evaluate the proposal without re-reading every transcript turn. " +
          "Required for non-trivial multi-file changes; can be omitted for one-shot fixes.",
      }),
    ),
    assumptions: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Explicit assumptions made during planning. Each entry is one sentence. " +
          'Examples: "Tests will pass on first run after the new path lands", ' +
          '"`packages/auth` retains its current public exports". ' +
          "If any assumption is wrong, the plan needs revision — surface them.",
      }),
    ),
    risks: Type.Optional(
      Type.Array(
        Type.Object(
          {
            risk: Type.String({
              description: "What could go wrong (one sentence).",
            }),
            mitigation: Type.String({
              description: "How the plan reduces or contains the risk.",
            }),
          },
          { additionalProperties: false },
        ),
        {
          description:
            "Risk register: things that could go wrong + how the plan mitigates each. " +
            "Use this to surface known unknowns before approval.",
        },
      ),
    ),
    verification: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Concrete steps that will confirm the plan succeeded. " +
          'Examples: "`pnpm test src/agents/...` passes", ' +
          '"VM 127263714 responds to SSH within 60s", ' +
          '"Telegram approval card renders inline buttons for kind=plugin". ' +
          "Required for tasks where premature closure has cost; covers Wave B1 closure-gate criteria.",
      }),
    ),
    references: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Optional list of file paths, URLs, PR numbers, or doc references the plan builds on. " +
          'Examples: "src/agents/plan-mode/types.ts:42", "PR #67538", "docs/agents/prompt-stack-spec.md". ' +
          "Renders as a Reference section in the persisted markdown.",
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Validate the plan steps. Throws ToolInputError on schema violations
 * the agent can recover from; the agent sees the error message and
 * can call again with corrections.
 *
 * host_ref: src/agents/tools/exit-plan-mode-tool.ts:154-195 (readPlanSteps)
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

/**
 * PR-10: parse the optional archetype fields from `exit_plan_mode` args.
 * Each field is parsed defensively (trim + drop blank entries) so a
 * malformed agent payload doesn't poison the approval card. Returns an
 * object with only the parsed fields populated; missing/invalid fields
 * stay undefined (caller spreads them conditionally).
 *
 * host_ref: src/agents/tools/exit-plan-mode-tool.ts:417-478
 *           (readPlanArchetypeFields)
 */
function readPlanArchetypeFields(params: Record<string, unknown>): {
  analysis?: string;
  assumptions?: string[];
  risks?: Array<{ risk: string; mitigation: string }>;
  verification?: string[];
  references?: string[];
} {
  const out: ReturnType<typeof readPlanArchetypeFields> = {};
  const rawAnalysis = readStringParam(params, "analysis");
  if (rawAnalysis && rawAnalysis.trim().length > 0) {
    out.analysis = rawAnalysis.trim();
  }
  const rawAssumptions = params.assumptions;
  if (Array.isArray(rawAssumptions)) {
    const cleaned = rawAssumptions
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (cleaned.length > 0) {
      out.assumptions = cleaned;
    }
  }
  const rawRisks = params.risks;
  if (Array.isArray(rawRisks)) {
    const cleaned: Array<{ risk: string; mitigation: string }> = [];
    for (const entry of rawRisks) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const e = entry as Record<string, unknown>;
      const risk = typeof e.risk === "string" ? e.risk.trim() : "";
      const mitigation =
        typeof e.mitigation === "string" ? e.mitigation.trim() : "";
      if (risk.length > 0 && mitigation.length > 0) {
        cleaned.push({ risk, mitigation });
      }
    }
    if (cleaned.length > 0) {
      out.risks = cleaned;
    }
  }
  const rawVerification = params.verification;
  if (Array.isArray(rawVerification)) {
    const cleaned = rawVerification
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (cleaned.length > 0) {
      out.verification = cleaned;
    }
  }
  const rawReferences = params.references;
  if (Array.isArray(rawReferences)) {
    const cleaned = rawReferences
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (cleaned.length > 0) {
      out.references = cleaned;
    }
  }
  return out;
}

export function createExitPlanModeTool(opts: CreateExitPlanModeToolInput) {
  return (ctx: ToolContext) => ({
    label: "Exit Plan Mode",
    name: "exit_plan_mode",
    description: describeExitPlanModeTool(),
    parameters: SCHEMA,
    execute: async (
      _toolCallId: string,
      args: unknown,
      _signal?: AbortSignal,
    ) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const summary = readStringParam(params, "summary");

      // PR-9 Tier 1 + Bug 2/6 fix: title is REQUIRED. Without it the
      // approval card defaults to "Active Plan" / "Plan approval
      // requested" which is uninformative for the user reviewing the
      // plan and unhelpful for the persisted markdown filename slug
      // (would become `plan-YYYY-MM-DD-untitled.md`). Reject the call
      // with a clear actionable error so the agent retries with a
      // proper title on the next attempt — schema enforcement is the
      // cleanest signal vs a silent fallback.
      //
      // Order matters: title check runs BEFORE plan validation so the
      // agent sees the title-required error first (most common omission)
      // rather than fixing a plan, retrying, then hitting title-required.
      // Byte-identical to in-host exit-plan-mode-tool.ts:213-231.
      const rawTitle = readStringParam(params, "title");
      const trimmedTitle = rawTitle?.trim();
      if (!trimmedTitle) {
        const err = new ToolInputError(
          "exit_plan_mode requires a `title` field — a concise plan name " +
            "(under 80 chars) used as the approval-card header, sidebar " +
            "title, and persisted markdown filename slug. " +
            'Example: title: "Refactor websocket reconnect race". ' +
            "Re-call exit_plan_mode with the title field included.",
        );
        return {
          content: [
            { type: "text" as const, text: `exit_plan_mode: ${err.message}` },
          ],
          details: { status: "invalid-input" as const, error: err.message },
        };
      }
      const title = trimmedTitle.slice(0, 80);

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

      // PR-10 archetype fields. All optional; readPlanArchetypeFields
      // does the parsing + sanitization (trim + drop blank entries).
      const archetype = readPlanArchetypeFields(params);

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

      // Map store outcome → tool result. Plugin uses hyphenated status
      // names (vs in-host underscore) for consistency with the rest of
      // the plugin status vocabulary + the eva-live-smokes assertions.
      let statusText: string;
      let status:
        | "approval-requested"
        | "duplicate-detected"
        | "not-in-plan-mode"
        | "failed";
      switch (r.kind) {
        case "persisted":
          status = "approval-requested";
          statusText = title
            ? `Plan submitted for approval — ${title} (${steps.length} ${steps.length === 1 ? "step" : "steps"}).`
            : `Plan submitted for approval (${steps.length} ${steps.length === 1 ? "step" : "steps"}).`;
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
          plan: steps,
          ...(title ? { title } : {}),
          ...(summary ? { summary } : {}),
          // PR-10 archetype fields. Spread only when the agent supplied
          // them — keeps the tool result minimal for simple plans.
          ...(archetype.analysis ? { analysis: archetype.analysis } : {}),
          ...(archetype.assumptions && archetype.assumptions.length > 0
            ? { assumptions: archetype.assumptions }
            : {}),
          ...(archetype.risks && archetype.risks.length > 0
            ? { risks: archetype.risks }
            : {}),
          ...(archetype.verification && archetype.verification.length > 0
            ? { verification: archetype.verification }
            : {}),
          ...(archetype.references && archetype.references.length > 0
            ? { references: archetype.references }
            : {}),
        },
      };
    },
  });
}

// Re-export the display-summary constant so callers needing parity
// with the in-host preset can import it from a stable location.
export { EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY };
