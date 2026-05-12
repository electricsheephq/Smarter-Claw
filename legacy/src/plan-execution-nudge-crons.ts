/**
 * Schedule + clean up "plan execution nudge" cron jobs.
 *
 * # Why this exists (PR #70071 P2.9 — recovered via tracking issue #51)
 *
 * Sibling to `plan-nudge-crons.ts`. The design-phase nudges (10/30/60
 * min) push an agent that's stalled while DESIGNING a plan (before
 * exit_plan_mode lands). Once the plan is approved and the session
 * transitions to `mode: "executing"` (PR #53 / P2.4), those design-
 * phase nudges are irrelevant — the agent should be advancing the
 * approved steps, not re-thinking the plan.
 *
 * Execution-phase nudges fire at TIGHTER intervals (1/3/5 min by
 * default) targeting the post-approval execution stall mode (subagent
 * returned + steps not marked complete is the canonical example —
 * Eva's MiniMax/David VM session log was the discovery case). The
 * message body is intentionally narrow ("call update_plan to mark
 * the current step done if it's complete, or report what you're
 * stuck on") so the agent's response stays focused on completing the
 * approved plan rather than re-planning.
 *
 * # Wireup status (2026-04-24)
 *
 * Same status as `plan-nudge-crons.ts`: this module ships the
 * scheduling/cleanup helpers but the wireup point depends on the
 * Plugin SDK exposing per-tool-call cron access from the approve
 * transition path. Until that lands, the helpers are callable when
 * a future installer-side glue passes `deps.callGatewayTool` from
 * the host's gateway client.
 *
 * Cron-fire-time guard (which would skip nudges when the executing
 * cycle has been superseded or all steps complete) lives in the
 * cron handler — also a future-wireup item. See openclaw-1's
 * `cron/isolated-agent/run.ts` reference impl for the guard logic.
 *
 * # Original behavior (mirrors openclaw-1 commit 1996328f74)
 *
 * Scheduling: fired by the approve / edit transition (the same
 * handoff that cleans up the design-phase nudges). The job IDs are
 * persisted on `SmarterClawSessionState.executionNudgeJobIds` so
 * cleanup at close-on-complete can target them precisely (parallel
 * to the existing `nudgeJobIds` design-phase tracking).
 *
 * Cleanup: `cleanupPlanExecutionNudges` is called on close-on-complete
 * + sessions-patch close-path. Best-effort failures degrade to no-op
 * (the leftover crons fire into a normal-mode session and the cron
 * guard skips them).
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ INSTALLER SEAM:                                                 │
 * │                                                                 │
 * │ Same constraint as plan-nudge-crons.ts. Plugin SDK does not     │
 * │ expose `cron.add` / `cron.remove` from the per-tool-call hook   │
 * │ context. Callers must inject `deps.callGatewayTool` from the    │
 * │ installer-side glue. Without it, helpers throw a clear error    │
 * │ so operators notice the gap rather than silently losing nudges. │
 * └─────────────────────────────────────────────────────────────────┘
 */

/**
 * Default execution-phase nudge intervals (minutes). Tighter than the
 * design-phase 10/30/60 because execution stalls (subagent return not
 * noticed, step status not updated, etc.) are typically resolved
 * within a few minutes of attention; longer intervals just delay
 * recovery.
 *
 * Override via the per-call `intervals` arg on
 * `schedulePlanExecutionNudges()`.
 */
const DEFAULT_EXECUTION_NUDGE_MINUTES = [1, 3, 5] as const;

/**
 * Marker prefix in cron job names so cleanup + telemetry can identify
 * these crons. Distinct from `plan-nudge:` so the two cron classes
 * never collide on cleanup.
 */
const PLAN_EXECUTION_NUDGE_NAME_PREFIX = "plan-execution-nudge:";

export interface PlanExecutionNudgeSchedulerDeps {
  /**
   * Called by the scheduler to talk to the gateway's cron service.
   * Mirrors `PlanNudgeSchedulerDeps.callGatewayTool` — kept installer-
   * side because the Plugin SDK does not expose a cron seam yet. When
   * omitted, the scheduler throws (no silent no-op).
   */
  callGatewayTool?: (method: string, opts: object, params: unknown) => Promise<unknown>;
  /** Override Date.now() for deterministic tests. */
  now?: () => number;
  /**
   * Optional sessionKey safety validator (e.g. the openclaw-1
   * `assertSafeCronSessionTargetId`). When omitted, the scheduler
   * skips the pre-check and relies on the host cron-validator's own
   * checks; supplying it keeps the failure local + actionable.
   */
  assertSafeCronSessionTargetId?: (sessionKey: string) => void;
}

export interface ScheduledPlanExecutionNudge {
  jobId: string;
  fireAtMs: number;
}

/**
 * Schedule one-shot execution-phase nudge crons for a session that
 * just transitioned to `mode: "executing"`. Returns the created job
 * ids so the caller can persist them on
 * `SmarterClawSessionState.executionNudgeJobIds` (a sibling field to
 * `nudgeJobIds` for design-phase tracking — schema additive).
 *
 * Scheduling failures for individual nudges are tolerated (return
 * the partial-success list rather than throwing). Mirrors the
 * design-phase scheduler's contract so the approve transition isn't
 * user-visibly aborted by an unrelated cron issue.
 */
export async function schedulePlanExecutionNudges(params: {
  sessionKey: string;
  agentId?: string;
  /**
   * The cycleId of the executing plan. Mirrors `planCycleId` on the
   * design-phase scheduler. Used by the cron-fire-time guard to
   * reject nudges that fired AFTER a new cycle started (e.g. the
   * user re-entered plan mode for a different objective).
   */
  executionCycleId?: string;
  intervals?: ReadonlyArray<number>;
  deps?: PlanExecutionNudgeSchedulerDeps;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}): Promise<ScheduledPlanExecutionNudge[]> {
  const intervals = params.intervals ?? DEFAULT_EXECUTION_NUDGE_MINUTES;
  const now = params.deps?.now?.() ?? Date.now();
  const call = params.deps?.callGatewayTool;
  if (!call) {
    throw new Error(
      "schedulePlanExecutionNudges: deps.callGatewayTool is required (the Plugin SDK does not expose a cron seam yet — installer-side wiring must inject the gateway-tool client).",
    );
  }
  const scheduled: ScheduledPlanExecutionNudge[] = [];
  for (const minutes of intervals) {
    if (minutes <= 0 || !Number.isFinite(minutes)) {
      continue;
    }
    const fireAtMs = now + Math.floor(minutes * 60_000);
    const fireAtIso = new Date(fireAtMs).toISOString();
    try {
      // Execution-phase nudge body — narrower than design-phase.
      // Tells the agent specifically to record step status (the
      // most-common stall — Eva's "subagent returned but plan not
      // marked complete" pattern) rather than re-plan. Mirrors the
      // approved-plan injection text in approval-state.ts.
      //
      // P2.12a (the next PR in the series) will rewrite this body
      // as imperative steps with verify-via-tool discipline.
      const message =
        `[PLAN_NUDGE]: Execution-phase wake-up (+${minutes}min): if a plan ` +
        "step you were working on has finished, call `update_plan` to mark " +
        'its status "completed" or "cancelled". If you are blocked on an ' +
        "external wait, schedule another resume via cron sessionTarget:'current' " +
        "and explain what you're waiting on. If all steps are recorded, the " +
        "plan auto-closes — no further action needed.";
      // sessionKey validation against cron service constraints (no
      // `/`, `\`, or `\0` characters). Catches malformed sessionKeys
      // locally instead of letting the cron jobs.ts validator reject
      // the cron.add ~60s later with a generic error.
      if (params.deps?.assertSafeCronSessionTargetId) {
        try {
          params.deps.assertSafeCronSessionTargetId(params.sessionKey);
        } catch (validationErr) {
          params.log?.warn?.(
            `plan-execution-nudge schedule skipped: sessionKey "${params.sessionKey}" fails cron sessionTarget validation: ${
              validationErr instanceof Error ? validationErr.message : String(validationErr)
            }`,
          );
          continue;
        }
      }
      const job: Record<string, unknown> = {
        name: `${PLAN_EXECUTION_NUDGE_NAME_PREFIX}${minutes}min:${params.sessionKey}`,
        schedule: { kind: "at", at: fireAtIso },
        sessionTarget: `session:${params.sessionKey}`,
        payload: {
          kind: "agentTurn",
          message,
          // Distinct field from `planCycleId` (design-phase) so a
          // future cron-fire-time guard can route the nudge to the
          // right suppression check (this cron belongs to an
          // executing cycle, not a design-phase cycle).
          ...(params.executionCycleId ? { executionCycleId: params.executionCycleId } : {}),
        },
        deleteAfterRun: true,
        delivery: { mode: "none" },
      };
      if (params.agentId) {
        job.agentId = params.agentId;
      }
      const result = await call("cron.add", {}, job);
      const jobId = extractJobId(result);
      if (jobId) {
        scheduled.push({ jobId, fireAtMs });
      } else {
        params.log?.warn?.(
          `plan-execution-nudge schedule succeeded but jobId missing from response: minutes=${minutes}`,
        );
      }
    } catch (err) {
      params.log?.warn?.(
        `plan-execution-nudge schedule failed: sessionKey=${params.sessionKey} minutes=${minutes} err=${String(err)}`,
      );
    }
  }
  if (scheduled.length > 0) {
    params.log?.info?.(
      `plan-execution-nudge crons scheduled: sessionKey=${params.sessionKey} count=${scheduled.length}`,
    );
  }
  return scheduled;
}

/**
 * Best-effort cleanup of previously-scheduled execution-phase nudges.
 * Called on the close-on-complete path + on `/plan off` + on any
 * sessions.patch transition that takes the session out of executing
 * (back to plan, to normal, or deletes the plugin's planMode slice).
 *
 * Failures are logged but not surfaced — the leftover crons degrade
 * to no-op when they fire into a normal-mode session (the cron
 * handler reads live planMode and skips the nudge if mode !==
 * "executing").
 */
export async function cleanupPlanExecutionNudges(params: {
  jobIds: ReadonlyArray<string>;
  deps?: PlanExecutionNudgeSchedulerDeps;
  log?: { warn?: (msg: string) => void };
}): Promise<{ removed: number; failed: number }> {
  if (params.jobIds.length === 0) {
    return { removed: 0, failed: 0 };
  }
  const call = params.deps?.callGatewayTool;
  if (!call) {
    throw new Error(
      "cleanupPlanExecutionNudges: deps.callGatewayTool is required (the Plugin SDK does not expose a cron seam yet — installer-side wiring must inject the gateway-tool client).",
    );
  }
  let removed = 0;
  let failed = 0;
  for (const id of params.jobIds) {
    try {
      await call("cron.remove", {}, { id });
      removed += 1;
    } catch (err) {
      failed += 1;
      params.log?.warn?.(`plan-execution-nudge cleanup failed: id=${id} err=${String(err)}`);
    }
  }
  return { removed, failed };
}

function extractJobId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const r = result as Record<string, unknown>;
  // Try common shapes: { jobId }, { id }, { job: { id } } — same as
  // the design-phase scheduler's extractor.
  if (typeof r.jobId === "string") {
    return r.jobId;
  }
  if (typeof r.id === "string") {
    return r.id;
  }
  if (r.job && typeof r.job === "object") {
    const j = r.job as Record<string, unknown>;
    if (typeof j.id === "string") {
      return j.id;
    }
  }
  return undefined;
}

export const PLAN_EXECUTION_NUDGE_NAME_PREFIX_FOR_TEST = PLAN_EXECUTION_NUDGE_NAME_PREFIX;
