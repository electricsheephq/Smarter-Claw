/**
 * Plan-mode lifecycle hook handlers — bundled in one module so index.ts
 * stays scannable. Each handler is small (≤30 lines) and routes through
 * `persistSmarterClawState` so all writes go through the same lock +
 * UI-mirror path.
 *
 * Hooks wired:
 *
 *   - `session_start`   → first-time intro injection (archetype-bridge)
 *   - `subagent_spawning` + `subagent_ended` → openSubagentRunIds tracking
 *     (#34 — exit_plan_mode subagent gate)
 *   - `agent_end`       → ack-only retry detection (#37 — re-prompts the
 *     agent when it stops in plan mode without calling exit_plan_mode)
 *   - `gateway_start`   → cron heartbeat registration (Stream A5)
 */

import {
  persistSmarterClawState,
  readSmarterClawState,
} from "../runtime-api.js";
import { logPlanModeDebug } from "./debug-log.js";
import {
  appendToInjectionQueue,
  type PendingAgentInjectionEntry,
} from "./injections.js";
import type { SmarterClawSessionState } from "./types.js";

export type LifecycleCtx = {
  agentId?: string;
  sessionKey?: string;
};

// ---------------------------------------------------------------------------
// session_start: deliver one-shot [PLAN_MODE_INTRO] when first entering plan
// ---------------------------------------------------------------------------

const PLAN_MODE_INTRO = `[PLAN_MODE_INTRO]: Plan mode is now active for this session.

Workflow:
  1. Investigate (read-only tools allowed: read, web_search, web_fetch, grep, glob)
  2. Track progress with update_plan as you go
  3. When ready, call exit_plan_mode with the proposed plan for user approval
  4. STOP after exit_plan_mode — the user resolves it via /plan accept|revise|accept-edits
  5. Mutation tools (write/edit/exec/bash) UNLOCK after approval

Reference card available via plan_mode_status. Type /plan off to exit plan mode at any time.`;

export async function handleSessionStart(ctx: LifecycleCtx): Promise<void> {
  if (!ctx.agentId || !ctx.sessionKey) return;
  const result = await persistSmarterClawState({
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    update: (current) => {
      // Only fire on FIRST plan-mode entry per session.
      if (!current || current.planMode !== "plan") return undefined;
      if (current.planModeIntroDeliveredAt) return undefined;
      const queueHost = { pendingAgentInjections: current.pendingAgentInjections };
      appendToInjectionQueue(queueHost, {
        id: "plan-mode-intro",
        kind: "plan_intro",
        text: PLAN_MODE_INTRO,
        createdAt: Date.now(),
      });
      return {
        ...current,
        planModeIntroDeliveredAt: new Date().toISOString(),
        pendingAgentInjections: queueHost.pendingAgentInjections,
      };
    },
  });
  if (result.persisted) {
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey: ctx.sessionKey,
      tool: "session_start:intro-queued",
    });
  }
}

// ---------------------------------------------------------------------------
// subagent_spawning + subagent_ended: track openSubagentRunIds so
// exit_plan_mode can reject when research subagents are still in flight.
// (#34 subagent gate)
// ---------------------------------------------------------------------------

export async function handleSubagentSpawning(
  evt: { runId?: string; childRunId?: string; childAgentId?: string },
  ctx: LifecycleCtx,
): Promise<void> {
  const childId = evt.childRunId ?? evt.runId ?? evt.childAgentId;
  if (!childId || !ctx.agentId || !ctx.sessionKey) return;
  await persistSmarterClawState({
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    update: (current) => {
      const base = ensureBase(current);
      const existing = new Set(base.blockingSubagentRunIds ?? []);
      existing.add(childId);
      return { ...base, blockingSubagentRunIds: [...existing] };
    },
  });
  logPlanModeDebug({
    kind: "tool_call",
    sessionKey: ctx.sessionKey,
    tool: `subagent_spawning:tracked:${childId}`,
  });
}

export async function handleSubagentEnded(
  evt: { runId?: string; childRunId?: string; childAgentId?: string },
  ctx: LifecycleCtx,
): Promise<void> {
  const childId = evt.childRunId ?? evt.runId ?? evt.childAgentId;
  if (!childId || !ctx.agentId || !ctx.sessionKey) return;
  await persistSmarterClawState({
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    update: (current) => {
      if (!current?.blockingSubagentRunIds?.length) return undefined;
      const next = current.blockingSubagentRunIds.filter((id) => id !== childId);
      if (next.length === current.blockingSubagentRunIds.length) return undefined;
      return { ...current, blockingSubagentRunIds: next };
    },
  });
  logPlanModeDebug({
    kind: "tool_call",
    sessionKey: ctx.sessionKey,
    tool: `subagent_ended:cleared:${childId}`,
  });
}

// ---------------------------------------------------------------------------
// agent_end: escalating retry suite (parity port #1 from openclaw-1
// `pi-embedded-runner/run/incomplete-turn.ts`). Detects three stall
// patterns the operator debugged for 2 weeks:
//
//   1. PLAN_MODE_ACK_ONLY  — in plan mode, agent says "I'll plan now"
//      then ends turn with no tool call. Standard → firm escalation.
//   2. PLAN_APPROVED_YIELD — within grace window post-approval, agent
//      yields without main-lane action. Standard → firm escalation.
//   3. PLANNING_ONLY       — outside plan mode, agent narrated a plan
//      with bullets but no tool call. Standard → firm → final.
//
// Each detector tracks per-cycle attempt counts in
// `state.retryCounters` so the escalation level matches the original.
// Counter resets land in:
//   - `enterPlanModeStateUpdate` (fresh planning cycle = reset all)
//   - approve action in `applyPatchToState` (fresh execution phase =
//     reset planApprovedYield)
// ---------------------------------------------------------------------------

import {
  resolveRetryDecision,
  type RetryDecision,
} from "./escalating-retry.js";

export async function handleAgentEnd(
  evt: { reason?: string; toolCallCount?: number; lastToolName?: string; messages?: unknown[] },
  ctx: LifecycleCtx,
): Promise<void> {
  if (!ctx.agentId || !ctx.sessionKey) return;
  // Cheap pre-check: when the agent's last tool was exit_plan_mode it
  // already submitted a plan — none of the three retry detectors apply.
  if (evt.lastToolName === "exit_plan_mode") return;

  const messages = Array.isArray(evt.messages) ? evt.messages : [];

  await persistSmarterClawState({
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    update: (current) => {
      // Don't retry when an interaction is already pending — the next
      // user message naturally resumes the cycle.
      if (current?.pendingInteraction) return undefined;

      const decision: RetryDecision = resolveRetryDecision({
        messages,
        state: current,
      });
      if (decision.kind === "skip") {
        return undefined;
      }

      // Detector matched. Bump the counter, queue the injection.
      const queueHost = { pendingAgentInjections: current?.pendingAgentInjections };
      const queueId = `escalating-retry-${decision.kind}`;
      // Avoid stacking duplicate same-kind injections (the queue's
      // upsertIntoQueue already dedups by id; this is belt-and-suspenders).
      const alreadyQueued = queueHost.pendingAgentInjections?.some(
        (e: PendingAgentInjectionEntry) => e.id === queueId,
      );
      if (!alreadyQueued) {
        appendToInjectionQueue(queueHost, {
          id: queueId,
          kind: "plan_decision",
          text: decision.instruction,
          createdAt: Date.now(),
          // Expire after 10 minutes — past that, the user has likely
          // moved on and the retry is just noise.
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
      }

      const counters = { ...(current?.retryCounters ?? {}) };
      if (decision.kind === "plan_mode_ack_only") {
        counters.planModeAckOnly = (counters.planModeAckOnly ?? 0) + 1;
      } else if (decision.kind === "plan_approved_yield") {
        counters.planApprovedYield = (counters.planApprovedYield ?? 0) + 1;
      } else if (decision.kind === "planning_only") {
        counters.planningOnly = (counters.planningOnly ?? 0) + 1;
      }
      const base = ensureBase(current);
      return {
        ...base,
        pendingAgentInjections: queueHost.pendingAgentInjections,
        retryCounters: counters,
      };
    },
  });
  logPlanModeDebug({
    kind: "tool_call",
    sessionKey: ctx.sessionKey,
    tool: "agent_end:escalating-retry-evaluated",
  });
}

// ---------------------------------------------------------------------------
// gateway_start: register plan-nudge cron heartbeat (Stream A5)
// ---------------------------------------------------------------------------

export async function handleGatewayStart(ctx: {
  getCron?: () => {
    add: (input: {
      id?: string;
      cron: string;
      command: string;
      enabled?: boolean;
      description?: string;
    }) => Promise<unknown>;
    list: (opts?: { includeDisabled?: boolean }) => Promise<Array<{ id: string }>>;
  } | undefined;
}): Promise<void> {
  const cron = ctx.getCron?.();
  if (!cron) {
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey: "<gateway>",
      tool: "gateway_start:cron-unavailable",
    });
    return;
  }
  // Idempotent registration — list first, only add when missing.
  try {
    const existing = await cron.list({ includeDisabled: true });
    if (existing.some((j) => j.id === "smarter-claw-plan-nudge")) {
      return;
    }
    await cron.add({
      id: "smarter-claw-plan-nudge",
      cron: "*/30 * * * *", // every 30 minutes
      command: "openclaw plan nudge --check-stale-plan-mode",
      enabled: true,
      description:
        "Smarter-Claw plan-mode heartbeat — nudges agents stuck in plan mode without recent activity. " +
        "Suppressed when an approval is pending; only fires when a session has been in plan mode > 30min " +
        "with no agent message and no pending interaction.",
    });
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey: "<gateway>",
      tool: "gateway_start:cron-registered",
    });
  } catch (err) {
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey: "<gateway>",
      tool: "gateway_start:cron-failed",
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

// Suppress unused-import lint: readSmarterClawState may be used by
// future handler additions inside this module.
void readSmarterClawState;
