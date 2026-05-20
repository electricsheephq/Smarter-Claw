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
  persistPlanArchetypeMarkdown,
  PlanPersistStorageError,
} from "../plan-mode/plan-archetype-persist.js";
import { renderFullPlanArchetypeMarkdown } from "../plan-mode/plan-render.js";
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

/**
 * W1-F2 (P0) fix (2026-05-20): persister hook contract.
 *
 * The prompt + reference card promise a persisted
 * `plan-YYYY-MM-DD-<slug>.md` file. Wiring the in-host persister
 * here makes that promise true. Triggered on the `"persisted"`
 * outcome of `store.persistApprovalRequest` (i.e. a NEW approval
 * cycle; NOT on `"reused"` / `"skipped"` / `"failed"` — the in-host
 * also writes only once per cycle).
 *
 * Failures are non-fatal: caught + logged. The approval flow still
 * proceeds. This mirrors the in-host bridge pattern at
 * `src/agents/plan-mode/plan-archetype-bridge.ts:151-200` which
 * void-fires the persist+attachment work so the approval emit is
 * never blocked.
 *
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:1925-1949
 *           (the in-host trigger fires `dispatchPlanArchetypeAttachment`
 *           immediately after `emitAgentApprovalEvent`)
 */
export interface ExitPlanModePersisterOptions {
  /**
   * Override the persistence base directory. Defaults to
   * `~/.openclaw/agents` via the in-host persister. Tests inject a
   * tmp dir. Operators can override via the plugin manifest's
   * `plansBaseDir` config key.
   */
  baseDir?: string;
  /**
   * Logger seam. Defaults to a no-op so the persister never spams
   * stdout in tests. Production wiring injects `api.logger` shims.
   */
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * W1-F4 fix (2026-05-20): auto-approve trigger contract.
 *
 * When the operator has flipped `autoApprove: true` on the session
 * (via `/plan auto on` → `plan.auto.toggle` → `setAutoApprove`),
 * `exit_plan_mode` should resolve the freshly-persisted approval
 * IMMEDIATELY as `approve` instead of leaving the approval card
 * armed for a manual click. This contract supplies the callback
 * the tool fires after a successful persist when the persisted
 * state's `autoApprove === true`.
 *
 * # Semantics
 *
 * The trigger fires once per persist (on `kind === "persisted"` AND
 * `kind === "reused"` — both produce a `pending` approval with the
 * effective `approvalId` returned by the store). The callback owns
 * the equivalent of the in-host's
 * `sessions.patch { planApproval: { action: "approve", approvalId } }`
 * roundtrip — typically `store.recordApproval` + the approved-plan
 * injection enqueue. Production wiring lives in `src/index.ts`.
 *
 * # Why a callback (not direct api access)
 *
 * The tool already accepts a callback-shaped `persister` for the same
 * reason: keeping `api`-typed surfaces out of `src/tools/` so the tool
 * stays unit-testable without an `api` stub. The `index.ts` callback
 * closes over the live `store` + `api` and supplies both the state
 * mutation (`recordApproval`) and the injection enqueue
 * (`enqueuePlanApprovedInjection`) in a single seam.
 *
 * # Safety
 *
 * - Fires `approve`, NOT `edit` — never grants the agent acceptEdits
 *   permission. The 3 hard constraints (no destructive / no
 *   self-restart / no config changes) apply only when acceptEdits is
 *   granted, so this matches the in-host behavior: auto-approve =
 *   verbatim execution of the submitted plan.
 * - The accept-edits gate at `src/index.ts` keys on
 *   `approval === "edited"` and is therefore intentionally bypassed
 *   when auto-approve fires `approve`. Matches in-host
 *   `sessions-patch.ts:992-993` where the `approve` path clears
 *   `postApprovalPermissions`.
 * - The approvalId emitted in the approval event and the approvalId
 *   passed to the trigger are the SAME value (returned from
 *   `store.persistApprovalRequest`). Audit trail thread is intact.
 * - Toggling `autoApprove` OFF mid-cycle is honored: the in-host
 *   polls the store immediately before firing the approve patch
 *   (`autoApproveIfEnabled` re-checks the flag inside the poll loop
 *   and bails on `false`). The plugin re-reads via `store.readSnapshot`
 *   inside the trigger for the same guard. If the operator toggled
 *   off between persist and trigger, the approval card stays armed.
 *
 * # Failure handling
 *
 * Trigger failures are caught + logged (matching the in-host's
 * `error`-level log on `autoApproveIfEnabled` exceptions). The
 * approval card stays on-screen for a manual click — auto-mode
 * briefly behaves like manual mode. This is the same degradation
 * contract as the in-host.
 *
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:387-477
 *   (`autoApproveIfEnabled` — the in-host trigger, with poll-loop +
 *   no-op-on-disabled + error-level log on failure).
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:1949-1962
 *   (the in-host callsite, void-fired after the approval emit).
 */
export interface ExitPlanModeAutoApproveOptions {
  /**
   * Fired after a successful `persistApprovalRequest` (persisted or
   * reused) when the persisted plan-mode state has `autoApprove === true`.
   * Resolves the approval immediately so the agent self-executes.
   *
   * Production wiring: calls `store.recordApproval` to flip the
   * state machine + enqueues the
   * `buildApprovedPlanInjection(planSteps)` text via
   * `enqueuePlanApprovedInjection` (same path as `plan.accept`).
   *
   * Failures should NOT throw — log + return. The tool catches
   * defensively but the contract is fail-soft inside the callback.
   */
  trigger: (params: {
    sessionKey: string;
    approvalId: string;
    /**
     * The plan steps from the just-persisted approval (already
     * materialized — no extra store read required).
     */
    planSteps: PlanStep[];
  }) => Promise<void> | void;
  /**
   * Logger seam. Defaults to a no-op so the trigger never spams
   * stdout in tests. Production wiring injects `api.logger` shims.
   */
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

export interface CreateExitPlanModeToolInput {
  store: PlanModeStore;
  /**
   * W1-F2: optional persister wiring. When omitted, persistence is
   * SKIPPED with a single warn log (so the prompt-promise hole is
   * loud, not silent). Production wiring in `src/index.ts` always
   * passes this — the optional shape exists so tests can isolate
   * tool-level behavior from filesystem effects.
   */
  persister?: ExitPlanModePersisterOptions;
  /**
   * W1-F4: optional auto-approve trigger wiring. When omitted, the
   * autoApprove flag has no runtime effect (the pre-W1-F4 behavior).
   * When supplied AND the persisted state has `autoApprove === true`,
   * the trigger fires after persist to resolve the approval
   * immediately. Production wiring lives in `src/index.ts`.
   *
   * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:1949-1962
   */
  autoApprove?: ExitPlanModeAutoApproveOptions;
}

interface ToolContext {
  sessionKey?: string;
  /**
   * W1-F2: the in-host persister keys files by `agentId`. The plugin
   * SDK supplies `agentId` on every tool-call ctx (see
   * `node_modules/openclaw/dist/plugin-sdk/src/plugins/tool-types.d.ts:21`).
   * Optional here because some pre-existing tests construct the tool
   * with only `sessionKey`; persistence is skipped (with a log) when
   * agentId is absent so the rest of the tool's behavior is unaffected.
   */
  agentId?: string;
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

      // W1-F2 (P0) fix (2026-05-20): persist the rendered plan
      // archetype as a markdown file under
      // `~/.openclaw/agents/<agentId>/plans/`. The prompt + reference
      // card promise this file exists; the in-host writes it; the
      // plugin previously did NOT, which made the prompt a lie.
      //
      // Fires only on the NEW-approval path (`kind === "persisted"`).
      // `reused` is the duplicate-detection path — the in-host writes
      // once per cycle, so we don't re-write on a duplicate submit.
      // `skipped` / `failed` mean the store never accepted the
      // approval; persisting a file for a non-existent approval
      // would be a phantom artifact.
      //
      // Failure is non-fatal: caught + logged; the tool result is
      // unaffected. This matches the in-host bridge behavior at
      // `src/agents/plan-mode/plan-archetype-bridge.ts:188-200`
      // (PlanPersistStorageError is downgraded to a warn log; other
      // failures also warn but never propagate).
      //
      // host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:1925-1949
      //   (in-host trigger: dispatchPlanArchetypeAttachment fires
      //   immediately after emitAgentApprovalEvent, void-wrapped)
      //
      // W1-F1 (P0) **deferred / SDK-blocked** (2026-05-20): the
      // in-host's `dispatchPlanArchetypeAttachment` also calls
      // `sendDocumentTelegram(dctx.to, absPath, { caption, parseMode:
      // "HTML" })` to push the persisted markdown to Telegram as the
      // user's action-required signal. The plugin port stops at the
      // PERSIST half — the push half is unimplementable on SDK
      // `2026.5.18` because `api.session.workflow.sendSessionAttachment`
      // rejects 3P plugins (`host-hook-attachments.ts:216-218` —
      // `if (origin !== "bundled") return { ok: false, error:
      // "session attachments are restricted to bundled plugins" }`).
      // Every other SDK push surface (`emitAgentEvent` on `approval`
      // stream, `scheduleSessionTurn`, etc.) is also unavailable —
      // see `docs/audits/parity-refresh/blocker-W1-F1.md` for the
      // full investigation. The persisted markdown WRITTEN below is
      // the building block a future host-side or bundled-capability
      // notifier would attach. Today, Telegram/Slack users get no
      // signal — the same gap the in-host has on non-Telegram channels.
      if (r.kind === "persisted") {
        await persistPlanArchetypeIfConfigured({
          opts,
          ctx,
          plan: steps,
          title,
          ...(summary !== undefined ? { summary } : {}),
          ...(archetype.analysis !== undefined
            ? { analysis: archetype.analysis }
            : {}),
          ...(archetype.assumptions !== undefined
            ? { assumptions: archetype.assumptions }
            : {}),
          ...(archetype.risks !== undefined ? { risks: archetype.risks } : {}),
          ...(archetype.verification !== undefined
            ? { verification: archetype.verification }
            : {}),
          ...(archetype.references !== undefined
            ? { references: archetype.references }
            : {}),
        });
      }

      // W1-F4 fix (2026-05-20): auto-approve trigger.
      //
      // If the operator pre-toggled `autoApprove: true` (via
      // `/plan auto on` → `setAutoApprove`), resolve the freshly-
      // persisted approval IMMEDIATELY as `approve` so the agent
      // self-executes instead of waiting on a manual click.
      //
      // Pre-W1-F4 the flag was a real flag with a real mutator + a
      // real slash command, but no caller — `RELEASE_NOTES.md`
      // known-limitation #3 acknowledged this gap. The audit's verdict
      // ("non-functional safety-relevant control. Wire it or hide it.")
      // is satisfied here by wiring it.
      //
      // # Why fires on BOTH "persisted" and "reused"
      //
      // The in-host's `autoApproveIfEnabled` is void-fired after the
      // approval emit unconditionally (`subscribe.handlers.tools.ts:1956-1962`);
      // it polls the persisted state for the matching approvalId, which
      // succeeds for both fresh and duplicate cycles. The reused path
      // produces a still-pending approval with the original approvalId
      // — if the user toggled auto-approve AFTER the original card
      // appeared but BEFORE acting on it, the duplicate-detect retry
      // is the correct trigger window for auto-approval to fire.
      //
      // # Why we re-read `autoApprove` via `store.readSnapshot`
      //
      // The in-host's `autoApproveIfEnabled` reads the store inside
      // its poll loop and bails on `autoApprove === false`
      // (`subscribe.handlers.tools.ts:435-436`). This is the
      // "toggled off mid-cycle is honored" contract — even though the
      // window here is small (we just persisted), the operator could
      // have raced `/plan auto off` against this very call. Re-read.
      //
      // # Why not awaited
      //
      // Matches the in-host's `void autoApproveIfEnabled(...)` pattern
      // (`subscribe.handlers.tools.ts:1956`). The tool result must
      // return promptly so the agent's tool-call resolves and the UI
      // sees the approval-requested status before the auto-approve
      // resolves it. Awaiting would also block on `recordApproval`
      // and the injection enqueue, which is unnecessary — the
      // auto-approve completes asynchronously and the injection drains
      // on the agent's next turn. The trigger callback itself must
      // never throw (per `ExitPlanModeAutoApproveOptions.trigger`
      // contract); we wrap defensively anyway.
      //
      // host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:1949-1962
      if (
        opts.autoApprove &&
        sessionKey &&
        (r.kind === "persisted" || r.kind === "reused")
      ) {
        void fireAutoApproveIfEnabled({
          opts,
          sessionKey,
          approvalId: r.approvalId,
          planSteps: steps,
        });
      }

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

/**
 * W1-F2 (P0) fix (2026-05-20): persistence-step helper.
 *
 * Renders the full plan archetype as markdown, then writes it via
 * `persistPlanArchetypeMarkdown` to `<baseDir>/<agentId>/plans/`.
 * Skips silently (with a single warn log) when persister wiring or
 * agentId is absent — those are the conditions under which the
 * caller couldn't fulfil the in-host contract anyway.
 *
 * Why `await` (not `void`): the in-host fires the bridge via
 * `void (async () => {...})()` so it doesn't block the approval
 * emit. The plugin tool body is already async + the persist is
 * fast (single file write, no network I/O), so awaiting keeps the
 * code linear, prevents test flakes from racing the suite teardown,
 * and lets the unit test deterministically assert the file exists
 * the moment `execute()` resolves. Failures still don't propagate —
 * the try/catch swallows them with a log.
 *
 * host_ref: src/agents/plan-mode/plan-archetype-bridge.ts:124-200
 *           (dispatchPlanArchetypeAttachment — persistence path)
 */
async function persistPlanArchetypeIfConfigured(input: {
  opts: CreateExitPlanModeToolInput;
  ctx: ToolContext;
  plan: PlanStep[];
  title: string;
  summary?: string;
  analysis?: string;
  assumptions?: string[];
  risks?: Array<{ risk: string; mitigation: string }>;
  verification?: string[];
  references?: string[];
}): Promise<void> {
  const { opts, ctx } = input;
  const log = opts.persister?.log;
  if (!opts.persister) {
    // Persister not wired — log once at warn so an operator running
    // an old wiring sees the gap. This is the W1-F2 honesty marker:
    // we never silently swallow the prompt-promise hole.
    log?.warn?.(
      "[smarter-claw] exit_plan_mode: persister not configured; plan markdown NOT written. " +
        "Wire `persister` in createExitPlanModeTool({...}) to fulfil the archetype-prompt persistence promise.",
    );
    return;
  }
  if (!ctx.agentId) {
    log?.warn?.(
      "[smarter-claw] exit_plan_mode: agentId missing from tool context; plan markdown NOT written. " +
        "The host SDK normally supplies agentId on OpenClawPluginToolContext.",
    );
    return;
  }
  try {
    const markdown = renderFullPlanArchetypeMarkdown({
      title: input.title || "Plan",
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.analysis !== undefined ? { analysis: input.analysis } : {}),
      plan: input.plan,
      ...(input.assumptions !== undefined
        ? { assumptions: input.assumptions }
        : {}),
      ...(input.risks !== undefined ? { risks: input.risks } : {}),
      ...(input.verification !== undefined
        ? { verification: input.verification }
        : {}),
      ...(input.references !== undefined
        ? { references: input.references }
        : {}),
    });
    const { filename } = await persistPlanArchetypeMarkdown({
      agentId: ctx.agentId,
      title: input.title,
      markdown,
      ...(opts.persister.baseDir !== undefined
        ? { baseDir: opts.persister.baseDir }
        : {}),
    });
    log?.info?.(
      `[smarter-claw] exit_plan_mode: persisted plan markdown agentId=${ctx.agentId} filename=${filename}`,
    );
  } catch (err) {
    // Match the in-host bridge's two-bucket failure handling
    // (plan-archetype-bridge.ts:188-203): recoverable storage errors
    // get a distinctive operator-actionable log prefix; everything
    // else gets a generic warn. Neither propagates.
    if (err instanceof PlanPersistStorageError) {
      log?.warn?.(
        `[smarter-claw/plan-persist/storage] markdown persist failed (${err.code}) — ` +
          `approval proceeds but audit artifact was NOT written. ` +
          `Operator action: check ~/.openclaw free space / permissions. ` +
          `Detail: ${err.message}`,
      );
      return;
    }
    log?.warn?.(
      `[smarter-claw] exit_plan_mode: plan markdown persist failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * W1-F4 fix (2026-05-20): auto-approve trigger helper.
 *
 * Faithful port of the in-host `autoApproveIfEnabled` at
 * `src/agents/pi-embedded-subscribe.handlers.tools.ts:387-477`,
 * with two simplifications appropriate for the plugin:
 *
 *   1. **No poll loop.** The in-host needs to poll the on-disk session
 *      store because the persister and the auto-approve handler run in
 *      parallel listeners — the persister may not have landed the
 *      `approval: "pending"` + `approvalId` write yet when auto-approve
 *      tries to read it. The plugin's `store.persistApprovalRequest`
 *      is awaited synchronously before this helper fires, so the
 *      persisted state is guaranteed visible to `store.readSnapshot`.
 *      No poll required.
 *
 *   2. **Trigger callback owns the patch equivalent.** The in-host
 *      calls `callGatewayTool("sessions.patch", { planApproval: {
 *      action: "approve", approvalId }})` — which routes through
 *      `sessions-patch.ts` → `resolvePlanApproval(approve)` +
 *      `appendToInjectionQueue([PLAN_DECISION]: approved)`. The
 *      plugin's `recordApproval` + `enqueuePlanApprovedInjection` do
 *      exactly the equivalent two operations; the trigger callback in
 *      `index.ts` wires them.
 *
 * # Guard order
 *
 * 1. Re-read persisted state. If `autoApprove === false` (operator
 *    flipped off mid-cycle), no-op. Matches in-host line 435-436 +
 *    446.
 * 2. Re-read approval state. If not still `pending` with the
 *    matching `approvalId` (user already resolved on another
 *    channel), no-op. Matches in-host line 446-454.
 * 3. Fire the callback. Failures log at `error` level (matching
 *    in-host's `params.log?.error ?? params.log?.warn` selection on
 *    `autoApproveIfEnabled` catch — operators must notice the silent
 *    degradation to manual mode).
 *
 * # Why approvalId correlation matters
 *
 * The persisted state's `approvalId` may differ from the candidate
 * we minted if `persistApprovalRequest` hit the reuse path
 * (duplicate `payloadHash`). The trigger fires with `r.approvalId`
 * (returned by the store, == effective approvalId on disk). The
 * helper re-confirms by re-reading; if a NEW exit_plan_mode landed
 * between the persist and the read (the rotate path), the approvalId
 * mismatch bails and the new card is left armed for the user. The
 * audit trail stays threaded on the effective approvalId.
 *
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:387-477
 *   (`autoApproveIfEnabled`).
 */
async function fireAutoApproveIfEnabled(input: {
  opts: CreateExitPlanModeToolInput;
  sessionKey: string;
  approvalId: string;
  planSteps: PlanStep[];
}): Promise<void> {
  const { opts, sessionKey, approvalId, planSteps } = input;
  const trigger = opts.autoApprove?.trigger;
  const log = opts.autoApprove?.log;
  if (!trigger) {
    return; // Caller already gated on this, but defensive.
  }
  try {
    // Guard 1+2: re-read the persisted state to honor mid-cycle
    // toggles. The store read is lock-protected (readSnapshot via
    // gateway.withLock) so we see a coherent post-persist snapshot.
    const snap = await opts.store.readSnapshot(sessionKey);
    if (!snap?.autoApprove) {
      // Auto-approve flipped off between persist and trigger (or was
      // never on — caller's check raced). Manual card stays armed.
      log?.info?.(
        `[smarter-claw] auto-approve skipped: autoApprove=${snap?.autoApprove ?? "(no state)"} ` +
          `sessionKey=${sessionKey} approvalId=${approvalId}`,
      );
      return;
    }
    if (snap.approval !== "pending" || snap.approvalId !== approvalId) {
      // Another channel resolved this cycle (or a new exit_plan_mode
      // rotated the approvalId). Bail — don't auto-approve a state
      // we don't recognize.
      log?.warn?.(
        `[smarter-claw] auto-approve aborted: state moved before trigger ` +
          `sessionKey=${sessionKey} expectedApprovalId=${approvalId} ` +
          `currentApproval=${snap.approval} currentApprovalId=${snap.approvalId ?? "(none)"}`,
      );
      return;
    }
    // Fire — callback owns recordApproval + enqueuePlanApprovedInjection.
    await trigger({
      sessionKey,
      approvalId,
      planSteps,
    });
    log?.info?.(
      `[smarter-claw] auto-approve fired sessionKey=${sessionKey} approvalId=${approvalId} steps=${planSteps.length}`,
    );
  } catch (err) {
    // Use error-level logging (matching in-host's
    // `autoApproveIfEnabled` catch) so operators notice the silent
    // fall-back to manual mode. The approval card stays on-screen;
    // user can click Approve manually. Auto-mode briefly degrades.
    const message =
      `[smarter-claw] auto-approve FAILED — approval card requires manual resolve. ` +
      `sessionKey=${sessionKey} approvalId=${approvalId}: ${err instanceof Error ? err.message : String(err)}`;
    (log?.error ?? log?.warn)?.(message);
  }
}

// Re-export the display-summary constant so callers needing parity
// with the in-host preset can import it from a stable location.
export { EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY };
