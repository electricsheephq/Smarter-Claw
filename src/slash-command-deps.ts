/**
 * Slash-command dep bundle factory.
 *
 * Translates high-level `/plan` patches (`{ planMode: "plan" }`,
 * `{ planApproval: { action: "approve", approvalId } }`, etc.) into
 * concrete session-state mutations through `persistSmarterClawState`.
 *
 * Lives outside `index.ts` so the adapter logic can be unit-tested
 * without going through the plugin SDK; index.ts wires this factory's
 * output into `createPlanCommandHandler`.
 *
 * Persistence path goes through the installer-supplied
 * `updateSessionStoreEntry` (shipped as the
 * `session-store-runtime-write-api.diff` patch). When the installer
 * hasn't run yet, persistSmarterClawState returns
 * `{ persisted: false, reason }` and we surface a friendly error.
 */

import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { persistSmarterClawState } from "../runtime-api.js";
import { appendToInjectionQueue } from "./injections.js";
import type { SmarterClawSessionState } from "./types.js";
import { logPlanModeDebug } from "./debug-log.js";
import type { PlanCommandHandlerDeps, PlanPatch } from "./slash-commands.js";

export interface SlashCommandDepsOptions {
  /** Resolves the channel string → boolean for markdown rendering. */
  isMarkdownCapableChannel?: (channel: string) => boolean;
}

/**
 * Build the dep bundle for `createPlanCommandHandler`. The factory
 * returns a `resolveSession` that loads the session entry via the
 * plugin SDK helpers, plus an `applyPlanPatch` that drives
 * persistSmarterClawState.
 */
export function buildSlashCommandDeps(
  opts: SlashCommandDepsOptions = {},
): PlanCommandHandlerDeps {
  return {
    isMarkdownCapableChannel: opts.isMarkdownCapableChannel,
    log: {
      debug: (msg) =>
        logPlanModeDebug({ kind: "tool_call", sessionKey: "<slash-cmd>", tool: `slash:${msg}` }),
    },

    resolveSession: async (ctx: PluginCommandContext) => {
      const agentId = resolveAgentIdFromCtx(ctx);
      const sessionKey = ctx.sessionKey;
      if (!agentId || !sessionKey) return undefined;
      // Lazy-import the session-store-runtime so we don't hard-fail on
      // hosts that haven't run the installer (the runtime exists in
      // vanilla v2026.4.22 — the installer's patch only ADDS
      // updateSessionStoreEntry).
      try {
        const storeRuntime = await import("openclaw/plugin-sdk/session-store-runtime");
        const storePath = storeRuntime.resolveStorePath(agentId);
        const store = storeRuntime.loadSessionStore(storePath, { skipCache: true });
        const resolved = storeRuntime.resolveSessionStoreEntry({
          store: store ?? {},
          sessionKey,
        });
        return resolved.existing;
      } catch {
        return undefined;
      }
    },

    applyPlanPatch: async ({ sessionKey, patch, ctx }) => {
      const agentId = ctx ? resolveAgentIdFromCtx(ctx) : undefined;
      if (!agentId) {
        throw new Error(
          "slash-command-deps: could not resolve agentId from command context (no agents configured?)",
        );
      }
      const result = await persistSmarterClawState({
        agentId,
        sessionKey,
        update: (current) => applyPatchToState(current, patch),
      });
      if (!result.persisted) {
        throw new Error(
          result.reason ??
            "Smarter-Claw could not persist the plan state — installer may not be wired against this OpenClaw install.",
        );
      }
    },
  };
}

/**
 * Pick an agent id from the slash-command context. PluginCommandContext
 * doesn't carry agentId directly — slash commands are channel-scoped —
 * so we resolve via the live config:
 *
 *   1. SMARTER_CLAW_DEFAULT_AGENT env override (smoke-test escape hatch)
 *   2. Single configured agent → use its id (most common single-user setup)
 *   3. Multi-agent: pick the one whose channels list includes ctx.channel
 *   4. Else: undefined (caller throws a friendly error)
 *
 * Pure read against ctx.config.agents.list — no IO.
 */
function resolveAgentIdFromCtx(ctx: PluginCommandContext): string | undefined {
  const envOverride = process.env.SMARTER_CLAW_DEFAULT_AGENT;
  if (envOverride) return envOverride;
  const agents = (ctx.config as unknown as {
    agents?: { list?: Array<{ id?: string; channels?: unknown }> };
  }).agents?.list;
  if (!agents || agents.length === 0) return undefined;
  if (agents.length === 1) return agents[0]?.id;
  for (const agent of agents) {
    const channels = agent.channels;
    if (Array.isArray(channels) && channels.includes(ctx.channel)) {
      return agent.id;
    }
  }
  // Multi-agent setup with no channel binding match — fall back to first.
  return agents[0]?.id;
}

/**
 * Pure: takes the current SmarterClawSessionState (or undefined for
 * first write) and a high-level patch, returns the next state.
 *
 * Patch shapes (matching the slash-commands handler's apply calls):
 *   { planMode: "plan" | "normal" }
 *   { planApproval: { action: "approve", approvalId } }
 *   { planApproval: { action: "edit", approvalId } }
 *   { planApproval: { action: "reject", feedback, approvalId } }
 *   { planApproval: { action: "answer", answer, approvalId } }
 *   { planApproval: { action: "auto", autoEnabled: boolean } }
 */
export function applyPatchToState(
  current: SmarterClawSessionState | undefined,
  patch: PlanPatch,
): SmarterClawSessionState {
  const base: SmarterClawSessionState = current ?? {
    planMode: "normal",
    planApproval: "idle",
    autoApprove: false,
  };
  if ("planMode" in patch) {
    return {
      ...base,
      planMode: patch.planMode,
      planApproval: patch.planMode === "normal" ? "idle" : base.planApproval,
    };
  }
  if ("planApproval" in patch) {
    const pa = patch.planApproval;
    if (pa.action === "approve" || pa.action === "edit") {
      // Stale-token guard: refuse the mutation if the supplied
      // approvalId doesn't match the pending interaction. Without
      // this, a stale /plan accept (user double-clicked, or fired
      // from a different surface after the plan was already
      // resolved) silently overwrites a freshly-rejected/-revised
      // state. Per #32 review comment.
      if (
        base.pendingInteraction?.kind !== "approval" ||
        base.pendingInteraction.approvalId !== pa.approvalId
      ) {
        // Returning current state is a no-op for persistSmarterClawState
        // (the caller surfaces this as "stale approvalId" via the
        // friendly message in slash-commands.mapErrorToReply).
        throw new Error("stale approvalId");
      }
      // Enqueue the synthetic [PLAN_DECISION]: approved|edited
      // injection so the agent's NEXT turn sees the approval as
      // an inline message (delivered by the before_prompt_build
      // injection-queue drain). Per #32 review comment.
      const queueHost = { pendingAgentInjections: base.pendingAgentInjections };
      appendToInjectionQueue(queueHost, {
        id: `plan-decision-${pa.approvalId}`,
        kind: "plan_decision",
        text: `[PLAN_DECISION]: ${pa.action === "approve" ? "approved" : "edited"}`,
        createdAt: Date.now(),
      });
      return {
        ...base,
        planMode: "normal",
        planApproval: "approved",
        pendingInteraction: undefined,
        recentlyApprovedAt: new Date().toISOString(),
        pendingAgentInjections: queueHost.pendingAgentInjections,
      };
    }
    if (pa.action === "reject") {
      // Stale-token guard (same as approve/edit).
      if (
        base.pendingInteraction?.kind !== "approval" ||
        base.pendingInteraction.approvalId !== pa.approvalId
      ) {
        throw new Error("stale approvalId");
      }
      // Rejection feedback flows to the agent via the injection
      // queue. Sanitize feedback against `[/PLAN_DECISION]` envelope
      // termination (matches src/types.ts:sanitizeFeedbackForInjection).
      const sanitized = (pa.feedback ?? "").replace(
        /\[\/PLAN_DECISION\]/gi,
        "[\u200B/PLAN_DECISION]",
      );
      const lines = [`[PLAN_DECISION]: rejected`];
      if (sanitized) lines.push(`feedback: ${JSON.stringify(sanitized)}`);
      lines.push("Revise your plan based on the feedback and call update_plan again.");
      const rejectHost = { pendingAgentInjections: base.pendingAgentInjections };
      appendToInjectionQueue(rejectHost, {
        id: `plan-decision-${pa.approvalId}`,
        kind: "plan_decision",
        text: lines.join("\n"),
        createdAt: Date.now(),
      });
      return {
        ...base,
        planApproval: "rejected",
        pendingInteraction: undefined,
        pendingAgentInjections: rejectHost.pendingAgentInjections,
      };
    }
    if (pa.action === "answer") {
      // Answer flows to the agent via the injection queue similarly.
      const answerHost = { pendingAgentInjections: base.pendingAgentInjections };
      appendToInjectionQueue(answerHost, {
        id: `question-answer-${pa.approvalId}`,
        kind: "question_answer",
        text: `[QUESTION_ANSWER]: ${pa.answer}`,
        createdAt: Date.now(),
      });
      return {
        ...base,
        pendingQuestionApprovalId: undefined,
        pendingInteraction: undefined,
        pendingAgentInjections: answerHost.pendingAgentInjections,
      };
    }
    if (pa.action === "auto") {
      return { ...base, autoApprove: !!pa.autoEnabled };
    }
  }
  return base;
}

