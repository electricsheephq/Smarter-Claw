/**
 * tool_result_persist hook handler — fires after tool results land in
 * the agent transcript. We use it to:
 *
 * 1. **Snapshot persist** for `update_plan`: when the agent calls
 *    update_plan with new step statuses, mirror the steps onto
 *    SmarterClawSessionState.lastPlanSteps so the UI sidebar +
 *    /plan restate / /plan view reflect the live progress.
 *
 * 2. **Archetype-on-disk persist** for `exit_plan_mode`: when the
 *    agent submits a plan, write the canonical
 *    `~/.openclaw/agents/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md`
 *    file via `archetype-persist.persistPlanArchetypeMarkdown`. This
 *    is the audit-trail artifact operators reach for when reviewing
 *    a plan after-the-fact.
 *
 * Both branches read tool params + result text out of the
 * `PluginHookToolResultPersistEvent.message` (which has the
 * post-execution shape with content + structured details). We're
 * conservative about parsing — invalid shapes are silently ignored
 * (the hook returns `undefined` so the host treats it as a no-op).
 */

import {
  persistSmarterClawState,
  type PersistSmarterClawStateResult,
} from "../runtime-api.js";
import { persistPlanArchetypeMarkdown } from "./archetype-persist.js";
import { appendToInjectionQueue } from "./injections.js";
import { renderFullPlanArchetypeMarkdown } from "./plan-render.js";
import { logPlanModeDebug } from "./debug-log.js";
import { shouldAutoClosePlan } from "./snapshot-persister.js";
import type { PlanProposal, PlanStep, SmarterClawSessionState } from "./types.js";

export type ToolResultPersistContext = {
  agentId?: string;
  sessionKey?: string;
};

/**
 * Loose AgentMessage / event shape — kept generic so we don't constrain
 * on the host's full type. The hook receives `message` with at least
 * `toolName?`, `params?`, `details?`, `text?`. The `tools/*` modules in
 * this plugin already produce details with `status: "approval_requested"`
 * + plan + archetype fields for exit_plan_mode, and `update_plan`'s
 * details follow the same shape.
 */
type LooseAgentMessage = {
  toolName?: string;
  toolCallId?: string;
  params?: Record<string, unknown>;
  details?: Record<string, unknown>;
  content?: unknown;
};

type LooseEvent = {
  toolName?: string;
  toolCallId?: string;
  message?: LooseAgentMessage;
  isSynthetic?: boolean;
};

export interface HandleToolResultPersistResult {
  /**
   * The hook's return contract supports replacing the persisted
   * message; we never do — we only side-effect (disk write + state
   * patch) and return undefined so the host stores the original.
   */
  message?: undefined;
}

export async function handleToolResultPersist(
  event: LooseEvent,
  ctx: ToolResultPersistContext,
): Promise<HandleToolResultPersistResult | undefined> {
  const toolName = event.toolName ?? event.message?.toolName;
  // Tracer log fires for EVERY tool_result_persist invocation regardless
  // of branch — diagnostics for "is this hook firing at all?". Cheap.
  logPlanModeDebug({
    kind: "tool_call",
    sessionKey: ctx.sessionKey ?? "",
    tool: `tool_result_persist:received:${toolName ?? "<unknown>"}:syn=${event.isSynthetic ?? "?"}`,
  });
  if (!toolName) return undefined;
  if (event.isSynthetic) return undefined; // Don't react to host-emitted synthetic results.

  const sessionKey = ctx.sessionKey;
  const agentId = ctx.agentId;
  if (!sessionKey || !agentId) return undefined;

  if (toolName === "update_plan") {
    await handleUpdatePlanPersist({ event, agentId, sessionKey });
  } else if (toolName === "exit_plan_mode") {
    await handleExitPlanModePersist({ event, agentId, sessionKey });
  }
  return undefined;
}

/**
 * update_plan side: mirror the new step list onto SmarterClawSessionState.lastPlanSteps
 * (preserving title/etc that exit_plan_mode set on the proposal). The
 * mutation gate doesn't fire on update_plan (it's allowlisted), so the
 * hook is the only path that updates lastPlanSteps when only update_plan
 * was called (e.g., agent in plan mode tracking progress without re-
 * submitting via exit_plan_mode).
 *
 * Parity port #4 (2026-04-24): also runs the auto-close + [PLAN_COMPLETE]
 * logic from the openclaw-1 plan-snapshot-persister. The plugin SDK
 * doesn't expose `onAgentEvent` so we can't wire `startPlanSnapshotPersister`
 * directly — instead we fold the equivalent close-on-complete behavior
 * into the existing `tool_result_persist` hook handler. When every step
 * reaches a terminal status (completed/cancelled) AND the cycle is in
 * an approved state (or within the post-approval grace window), flip
 * planMode → "normal" and enqueue a `[PLAN_COMPLETE]` injection so the
 * agent's NEXT turn knows to summarize + stop. Mirrors
 * snapshot-persister.handlePlanEvent's close-on-complete branch.
 */
async function handleUpdatePlanPersist(args: {
  event: LooseEvent;
  agentId: string;
  sessionKey: string;
}): Promise<void> {
  const params = (args.event.message?.params ?? args.event.message?.details ?? {}) as Record<string, unknown>;
  const rawPlan = params.plan;
  if (!Array.isArray(rawPlan)) return;
  const steps = parsePlanStepsFromTool(rawPlan);
  if (steps.length === 0) return;

  // Pre-compute "are all steps terminal?" using the raw plan's status
  // field (the parsed PlanStep loses the cancelled/completed
  // distinction by mapping both to `done`). Covers the auto-close
  // signal the plan-snapshot-persister used.
  const allTerminal = rawPlan.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    const status = typeof e.status === "string" ? e.status : "";
    return status === "completed" || status === "cancelled";
  });

  await persistFromHook({
    sessionKey: args.sessionKey,
    agentId: args.agentId,
    tool: "update_plan",
    update: (current) => {
      const base = ensureBase(current);
      const existingProposal = base.lastPlanSteps;
      const next: SmarterClawSessionState = {
        ...base,
        lastPlanSteps: existingProposal
          ? { ...existingProposal, steps }
          : { title: "Untitled plan", steps },
      };

      // Parity port #4 close-on-complete branch. Only fire when:
      //   - The agent just emitted a fully-terminal plan,
      //   - shouldAutoClosePlan agrees (approved/edited cycle, or
      //     within the post-deletion grace window).
      // When suppressed, the agent still needs to call exit_plan_mode
      // explicitly (matches the openclaw-1 persister's "auto-close
      // suppressed" log).
      if (allTerminal) {
        const recentlyApprovedAtMs = base.recentlyApprovedAt
          ? Date.parse(base.recentlyApprovedAt) || undefined
          : undefined;
        const canClose = shouldAutoClosePlan({
          approval:
            base.planApproval === "approved" || base.planApproval === "rejected"
              ? base.planApproval
              : base.planApproval === "awaiting-approval"
                ? "pending"
                : undefined,
          recentlyApprovedAt: recentlyApprovedAtMs,
        });
        if (canClose) {
          // Flip planMode to normal + enqueue [PLAN_COMPLETE] injection.
          const completionStepCount = steps.length;
          const completionInjectionText =
            `[PLAN_COMPLETE]: ${completionStepCount} step${completionStepCount === 1 ? "" : "s"} ` +
            `completed. Post a brief summary of what was done and stop. The plan has been ` +
            `auto-closed; the user can start a new plan cycle if needed.`;
          const queueHost = { pendingAgentInjections: next.pendingAgentInjections };
          appendToInjectionQueue(queueHost, {
            id: `plan-complete-${args.sessionKey}-${Date.now()}`,
            kind: "plan_complete",
            text: completionInjectionText,
            createdAt: Date.now(),
          });
          return {
            ...next,
            planMode: "normal",
            planApproval: "idle",
            pendingAgentInjections: queueHost.pendingAgentInjections,
          };
        }
      }
      return next;
    },
  });
}

/**
 * exit_plan_mode side: write the canonical markdown artifact to disk.
 * The session-state mutation already happened inside the tool body
 * (via tool-state-helpers.exitPlanModeStateUpdate); the hook handles
 * the side-effect that needs the post-persist signal (fs write happens
 * AFTER the session record is durable so a crash mid-write doesn't
 * leave an orphan markdown without a session entry pointing at it).
 */
async function handleExitPlanModePersist(args: {
  event: LooseEvent;
  agentId: string;
  sessionKey: string;
}): Promise<void> {
  const details = (args.event.message?.details ?? {}) as Record<string, unknown>;
  const title = typeof details.title === "string" ? details.title : "Untitled plan";
  const summary = typeof details.summary === "string" ? details.summary : undefined;
  const analysis = typeof details.analysis === "string" ? details.analysis : undefined;
  const plan = parsePlanStepsFromTool(Array.isArray(details.plan) ? (details.plan as unknown[]) : []);
  const assumptions = parseStringArray(details.assumptions);
  const risks = parseRisks(details.risks);
  const verification = parseStringArray(details.verification);
  const references = parseStringArray(details.references);

  const markdown = renderFullPlanArchetypeMarkdown({
    title,
    summary,
    analysis,
    plan: plan.map((s) => ({
      step: s.description,
      status: s.done ? "completed" : "pending",
    })),
    assumptions,
    risks,
    verification,
    references,
  });

  try {
    const result = await persistPlanArchetypeMarkdown({
      agentId: args.agentId,
      title,
      markdown,
    });
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey: args.sessionKey,
      tool: `tool_result_persist:archetype-md:${result.filename}`,
    });
  } catch (err) {
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey: args.sessionKey,
      tool: `tool_result_persist:archetype-md-failed`,
      details: { reason: (err as Error)?.message ?? String(err) },
    });
  }

  // BUG #2 fix: autoApprove consumer. The plugin manifest advertises
  // `autoApprove: "Toggle whether plans auto-execute without user
  // approval"` and the chip shows "Plan ⚡" when set, but pre-this-fix
  // ZERO code consumed the flag — `runtime-api.isAutoApproveEnabled` was
  // exported with no callers. Result: user toggles auto, sees confirma-
  // tion, plan still requires manual click. Cosmetic-only feature.
  //
  // Fix wires the consumer here, AFTER exit_plan_mode persists. We
  // re-read the slice (the persist already wrote the
  // pendingInteraction:approval shape via the plugin's tool body) and
  // if `autoApprove === true`, fire a synthetic approve-equivalent
  // state mutation that mirrors what the manual approve path produces:
  //   - planMode → "executing"
  //   - planApproval → "approved"
  //   - pendingInteraction → undefined
  //   - recentlyApprovedAt → now
  //   - rejectionCount → 0
  //   - retryCounters → undefined
  //   - append [PLAN_DECISION]: approved injection
  //
  // Idempotency: the synthetic write is gated on `pendingInteraction`
  // being present (the just-persisted approval). If it's already gone
  // (concurrent UI click won the race), we no-op safely. We also gate
  // on `planApproval !== "approved"` to avoid double-firing on
  // duplicate hook invocation if BUG #5 dedup ever degrades.
  try {
    await persistSmarterClawState({
      agentId: args.agentId,
      sessionKey: args.sessionKey,
      update: (current) => {
        if (!current) return undefined;
        if (current.autoApprove !== true) return undefined;
        if (current.planApproval === "approved") return undefined;
        const pending = current.pendingInteraction;
        if (!pending || pending.kind !== "approval") return undefined;
        const approvalId = pending.approvalId;
        if (!approvalId) return undefined;
        const queueHost = { pendingAgentInjections: current.pendingAgentInjections };
        appendToInjectionQueue(queueHost, {
          id: `plan-decision-${approvalId}`,
          kind: "plan_decision",
          text: `[PLAN_DECISION]: approved`,
          createdAt: Date.now(),
        });
        logPlanModeDebug({
          kind: "tool_call",
          sessionKey: args.sessionKey,
          tool: `tool_result_persist:auto-approved:${approvalId}`,
        });
        return {
          ...current,
          planMode: "executing",
          planApproval: "approved",
          pendingInteraction: undefined,
          recentlyApprovedAt: new Date().toISOString(),
          rejectionCount: 0,
          retryCounters: undefined,
          pendingAgentInjections: queueHost.pendingAgentInjections,
        };
      },
    });
  } catch (err) {
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey: args.sessionKey,
      tool: `tool_result_persist:auto-approve-failed`,
      details: { reason: (err as Error)?.message ?? String(err) },
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureBase(current: SmarterClawSessionState | undefined): SmarterClawSessionState {
  return (
    current ?? {
      planMode: "normal",
      planApproval: "idle",
      autoApprove: false,
    }
  );
}

async function persistFromHook(args: {
  sessionKey: string;
  agentId: string;
  tool: string;
  update: (current: SmarterClawSessionState | undefined) => SmarterClawSessionState | undefined;
}): Promise<PersistSmarterClawStateResult> {
  const result = await persistSmarterClawState({
    agentId: args.agentId,
    sessionKey: args.sessionKey,
    update: args.update,
  });
  logPlanModeDebug({
    kind: "tool_call",
    sessionKey: args.sessionKey,
    tool: `tool_result_persist:${args.tool}:${result.persisted ? "ok" : "skipped"}`,
    details: result.persisted ? undefined : { reason: result.reason },
  });
  return result;
}

function parsePlanStepsFromTool(rawPlan: unknown[]): PlanStep[] {
  const steps: PlanStep[] = [];
  for (let i = 0; i < rawPlan.length; i++) {
    const entry = rawPlan[i];
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const stepText = typeof e.step === "string" ? e.step.trim() : "";
    const activeForm =
      typeof e.activeForm === "string" && e.activeForm.trim().length > 0
        ? e.activeForm.trim()
        : undefined;
    const status = typeof e.status === "string" ? e.status : "pending";
    const description = activeForm || stepText;
    if (!description) continue;
    steps.push({
      index: i + 1,
      description,
      done: status === "completed",
    });
  }
  return steps;
}

function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

function parseRisks(raw: unknown): Array<{ risk: string; mitigation: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ risk: string; mitigation: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const risk = typeof e.risk === "string" ? e.risk.trim() : "";
    const mitigation = typeof e.mitigation === "string" ? e.mitigation.trim() : "";
    if (risk && mitigation) out.push({ risk, mitigation });
  }
  return out.length > 0 ? out : undefined;
}
