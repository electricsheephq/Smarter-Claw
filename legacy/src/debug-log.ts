/**
 * Smarter Claw debug log — opt-in instrumentation surface.
 *
 * # Why
 *
 * The plan-mode subsystem has many cross-component touch points (gateway
 * sessions.patch, mutation gate, three plan-mode tools, synthetic
 * injections, nudge crons, subagent spawn/return, approval events, UI
 * toasts). Live debugging today means piecing together evidence from
 * sparse `[gateway]` / `[agent/embedded]` / `[plugins]` log lines plus
 * grep-by-runId across multiple files. This helper centralizes
 * plan-mode-specific events behind a single gate so a debugger (human
 * or agent) can stream the entire plan-mode lifecycle by tailing one
 * file.
 *
 * # Activation (two equivalent paths — either turns logging on)
 *
 * Path A (env var, terminal-launched runs):
 *   OPENCLAW_DEBUG_PLAN_MODE=1 ./openclaw gateway run …
 *
 * Path B (plugin config flag, persistent — recommended for menubar app
 * / launchd-supervised gateway where env-var propagation is unreliable):
 *   openclaw config set plugins.entries.smarter-claw.config.debugLog true
 *   # then restart the gateway
 *
 * The plugin entry calls `setPlanModeDebugEnabled(config.debugLog)` on
 * register so the config-flag path doesn't need a separate disk read on
 * every emit. The env-var path is checked at every emit (cheap string
 * compare) so an operator can flip it on mid-run without restarting.
 *
 * Off by default — the helper short-circuits at the first line so there
 * is zero perf impact when disabled. To stream:
 *
 *     tail -F ~/.openclaw/logs/gateway.err.log | grep '\[smarter-claw/'
 *
 * # Coverage
 *
 * Every plan-mode state transition, gate decision, tool call, synthetic
 * injection, nudge phase, subagent event, approval action, and UI toast
 * emission. The `kind` discriminator on the event union is the
 * canonical taxonomy of "things that affect plan-mode behavior."
 */

/**
 * Discriminated union of every plan-mode lifecycle event the debug log
 * captures. Add new kinds here when instrumenting a new touch point —
 * the union keeps callers honest about what fields each event needs.
 *
 * Correlation fields (operators tracing a single approval cycle across
 * multiple events need a shared key beyond `sessionKey` because one
 * session can have many approvals in its lifetime):
 *   - `approvalRunId`: the agent-run ID that produced the plan
 *     (persisted on the plan-mode state at exit_plan_mode time). Traces
 *     events from tool-call → gate decisions → injections within one
 *     agent turn.
 *   - `approvalId`: the approval-version token minted for each
 *     exit_plan_mode call. Traces events across the full approval
 *     lifecycle (exit_plan_mode → user decision → state transition).
 * Both are optional — pre-existing emitters that don't carry them keep
 * the current logging shape; new emitters populate them when the field
 * is available at emit time.
 */
export type PlanModeDebugEvent =
  | {
      kind: "state_transition";
      sessionKey: string;
      from: string;
      to: string;
      /** Reason / trigger label, e.g. "exit_plan_mode" or "user-toggle". */
      trigger?: string;
      reason?: string;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "gate_decision";
      sessionKey: string;
      tool: string;
      allowed: boolean;
      planMode?: string;
      reason?: string;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "tool_call";
      sessionKey: string;
      /**
       * Tool name. Common plan-mode entries: `enter_plan_mode`,
       * `exit_plan_mode`, `update_plan`, `ask_user_question`. Hook
       * emitters may use synthetic names like
       * `before_prompt_build:archetype-injected` — keeping this a free
       * string lets bridge layers tag their own touch points without
       * extending the union.
       */
      tool: string;
      runId?: string;
      details?: Record<string, unknown>;
    }
  | {
      kind: "synthetic_injection";
      sessionKey: string;
      /** Marker tag like `[PLAN_DECISION]` / `[QUESTION_ANSWER]`. */
      marker?: string;
      tag?: string;
      preview?: string;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "nudge_event";
      sessionKey: string;
      nudgeId: string;
      phase: "scheduled" | "fired" | "cleaned";
      approvalRunId?: string;
    }
  | {
      kind: "subagent_event";
      sessionKey: string;
      parentRunId: string;
      childRunId: string;
      event: "spawn" | "return";
      approvalRunId?: string;
    }
  | {
      kind: "approval_event";
      sessionKey: string;
      action: string;
      openSubagentCount?: number;
      result?: "accepted" | "rejected_by_subagent_gate" | "other";
      approvalId?: string;
      approvalRunId?: string;
    }
  | {
      kind: "toast_event";
      sessionKey: string;
      toast: string;
      phase: "fired" | "dismissed";
      approvalRunId?: string;
      approvalId?: string;
    };

let debugEnabledFromConfig = false;

/** Configure the debug-log enabled flag. Called by the plugin entry on register. */
export function setPlanModeDebugEnabled(enabled: boolean): void {
  debugEnabledFromConfig = enabled;
}

/**
 * Returns true when EITHER `OPENCLAW_DEBUG_PLAN_MODE=1` is set in the
 * process env OR the plugin config flag was set true via
 * `setPlanModeDebugEnabled` (i.e. the plugin entry observed
 * `pluginConfig.debugLog === true` on register).
 *
 * The env-var path is checked at every call (single string compare) so
 * operators can flip it on mid-run without restarting. The config flag
 * is mutated only when the plugin entry registers, so reading it is a
 * trivial property read.
 *
 * Order: env var wins (allows ad-hoc terminal-launched runs); config
 * flag is the persistent path. Either signal turns it on.
 */
export function isPlanModeDebugEnabled(): boolean {
  if (typeof process !== "undefined" && process.env?.OPENCLAW_DEBUG_PLAN_MODE === "1") {
    return true;
  }
  return debugEnabledFromConfig;
}

/**
 * Emit a structured debug log line. No-op when disabled.
 *
 * Format: `[smarter-claw/<kind>] <key>=<value> ...`. Values containing
 * whitespace are JSON-stringified so the line stays grep-friendly with
 * shell tools (`tail -F gateway.err.log | grep '\[smarter-claw/' | awk
 * '{print $1, $2}'` etc.).
 */
export function logPlanModeDebug(event: PlanModeDebugEvent): void {
  if (!isPlanModeDebugEnabled()) {
    return;
  }
  const parts: string[] = [`[smarter-claw/${event.kind}]`];
  for (const [key, value] of Object.entries(event)) {
    if (key === "kind" || value === undefined) {
      continue;
    }
    const stringValue =
      typeof value === "string"
        ? value
        : typeof value === "boolean" || typeof value === "number"
          ? String(value)
          : JSON.stringify(value);
    // Quote values that contain whitespace so the line stays grep-friendly.
    const formatted = /\s/.test(stringValue) ? JSON.stringify(stringValue) : stringValue;
    parts.push(`${key}=${formatted}`);
  }
  // eslint-disable-next-line no-console
  console.error(parts.join(" "));
}
