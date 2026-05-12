/**
 * Plan-Mode debug log — opt-in structured event surface.
 *
 * **Parity contract**: semantic port of the in-host
 * `plan-mode-debug-log.ts` at
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/plan-mode/plan-mode-debug-log.ts`
 * (commit `ea04ea52c7`). The event-kind taxonomy + correlation-field
 * design (approvalRunId / approvalId) are preserved verbatim. The
 * plugin port drops the openclaw-config-loader dependency in favor of
 * pluginConfig + env var; the activation contract is the same:
 * "env wins over config; either turns it on."
 *
 * # Activation
 *
 * Two equivalent paths — either turns logging on:
 *
 * Path A (env var, terminal-launched gateway):
 *   OPENCLAW_DEBUG_PLAN_MODE=1 ./openclaw gateway run …
 *
 * Path B (plugin config, persistent — recommended for menubar /
 * launchd-supervised gateways where env-var propagation is unreliable):
 *   add `debug: true` to plugin entry config:
 *     `plugins.entries.smarter-claw.debug: true`
 *   restart the gateway.
 *
 * Off by default — the helper short-circuits at the first line so there
 * is zero perf impact when disabled.
 *
 * # Coverage
 *
 * Every plan-mode state transition, gate decision, tool call, synthetic
 * injection, nudge phase, subagent event, approval action, and UI toast
 * emission. The `kind` discriminator on the event union is the canonical
 * taxonomy of "things that affect plan-mode behavior."
 *
 * # Correlation
 *
 * Operators tracing a single approval cycle across multiple events need
 * a shared key beyond `sessionKey` (one session can have many approvals
 * in its lifetime). Two correlation keys:
 *   - `approvalRunId`: the agent-run ID that produced the plan
 *     (persisted on `planMode.approvalRunId` at exit_plan_mode time).
 *     Traces events from tool-call → gate decisions → injections
 *     within one agent turn.
 *   - `approvalId`: the approval-version token minted for each
 *     exit_plan_mode call. Traces events across the full approval
 *     lifecycle (exit_plan_mode → user decision → state transition).
 * Both optional — pre-existing emitters that don't carry them keep
 * the current shape.
 */

/**
 * Discriminated union of every plan-mode lifecycle event the debug log
 * captures. Add new kinds here when instrumenting a new touch point —
 * the union keeps callers honest about what fields each event needs.
 *
 * Port verbatim from in-host plan-mode-debug-log.ts:63-141 (the C7
 * correlation-field comment block applies here too).
 */
export type PlanModeDebugEvent =
  | {
      kind: "state_transition";
      sessionKey: string;
      from: string;
      to: string;
      trigger: string;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "gate_decision";
      sessionKey: string;
      tool: string;
      allowed: boolean;
      planMode: string | undefined;
      reason?: string;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "tool_call";
      sessionKey: string;
      tool: string;
      mode: string;
      meta?: Record<string, unknown>;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "synthetic_injection";
      sessionKey: string;
      injectionKind: string;
      idempotencyKey?: string;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "approval_transition";
      sessionKey: string;
      from: string;
      to: string;
      trigger: string;
      approvalIdBefore?: string;
      approvalIdAfter?: string;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "ui_toast";
      sessionKey?: string;
      message: string;
      severity?: "info" | "warn" | "error";
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "nudge_phase";
      sessionKey: string;
      phase: string;
      details?: Record<string, unknown>;
      approvalRunId?: string;
      approvalId?: string;
    }
  | {
      kind: "subagent_event";
      sessionKey: string;
      event: string;
      details?: Record<string, unknown>;
      approvalRunId?: string;
      approvalId?: string;
    };

/**
 * Minimal logger shape — matches PluginLogger.
 */
export interface DebugLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  debug?: (message: string) => void;
}

/**
 * Test-controllable cache. The plugin's debug-flag resolution doesn't
 * read from disk (unlike the in-host's config-loader path) so we don't
 * need the 30s TTL the in-host has. We DO cache the pluginConfig
 * resolution to avoid re-validating the shape on every emit.
 */
let cachedFlag: { value: boolean; setAt: number } | undefined;

/**
 * Test-only: reset the cache. Production code never calls this.
 */
export function _resetDebugFlagCacheForTests(): void {
  cachedFlag = undefined;
}

/**
 * Resolve "is plan-mode debug logging enabled?" — env-var wins over
 * plugin config (matches in-host semantics).
 *
 * @param pluginConfig — the plugin's pluginConfig (api.pluginConfig).
 *   We look for a top-level `debug` boolean field.
 *
 * host_ref: src/agents/plan-mode/plan-mode-debug-log.ts:210-227
 */
export function isPlanModeDebugEnabled(
  pluginConfig: Record<string, unknown> | undefined,
): boolean {
  // Env-var path (process-level override).
  if (process.env.OPENCLAW_DEBUG_PLAN_MODE === "1") return true;

  // Cache hit.
  if (cachedFlag && Date.now() - cachedFlag.setAt < 30_000) {
    return cachedFlag.value;
  }

  // Read from pluginConfig.
  const value = pluginConfig?.debug === true;
  cachedFlag = { value, setAt: Date.now() };
  return value;
}

/**
 * Emit a structured plan-mode debug event. No-op when debug is disabled.
 *
 * The event's `kind` becomes part of the message tag so callers can
 * grep `[plan-mode/state_transition]`, etc.
 *
 * host_ref: src/agents/plan-mode/plan-mode-debug-log.ts:234-247
 */
export function logPlanModeDebug(
  logger: DebugLogger,
  pluginConfig: Record<string, unknown> | undefined,
  event: PlanModeDebugEvent,
): void {
  if (!isPlanModeDebugEnabled(pluginConfig)) return;
  const { kind, ...meta } = event;
  // Use info level — see in-host comment at debug-log.ts:239-246
  // about the gate-vs-log-level compounding issue. The plugin's
  // PluginLogger.info maps to the host's structured logger which
  // already lands at info; we don't have a `debug` level guarantee.
  logger.info(`[plan-mode/${kind}] ${stringifyMeta(meta)}`);
}

/**
 * Convenience helper for `approval_transition` events. Skips emission
 * when the approval value didn't actually change (avoids spamming the
 * log on patches that don't touch approval). Use at every call site
 * that writes approval state.
 *
 * host_ref: src/agents/plan-mode/plan-mode-debug-log.ts:260-287
 */
export function logPlanModeApprovalTransition(
  logger: DebugLogger,
  pluginConfig: Record<string, unknown> | undefined,
  sessionKey: string,
  prev: { approval?: string; approvalId?: string } | undefined,
  next: { approval?: string; approvalId?: string } | undefined,
  trigger: string,
  correlation?: { approvalRunId?: string },
): void {
  if (!isPlanModeDebugEnabled(pluginConfig)) return;
  const fromApproval = prev?.approval ?? "(absent)";
  const toApproval = next?.approval ?? "(absent)";
  const fromId = prev?.approvalId;
  const toId = next?.approvalId;
  // Skip on no-op transitions.
  if (fromApproval === toApproval && fromId === toId) return;
  logPlanModeDebug(logger, pluginConfig, {
    kind: "approval_transition",
    sessionKey,
    from: fromApproval,
    to: toApproval,
    trigger,
    ...(fromId ? { approvalIdBefore: fromId } : {}),
    ...(toId ? { approvalIdAfter: toId } : {}),
    ...(correlation?.approvalRunId
      ? { approvalRunId: correlation.approvalRunId }
      : {}),
  });
}

/**
 * Stringify event meta for the log line. Compact JSON, deterministic
 * key order, undefined values dropped.
 */
function stringifyMeta(meta: Record<string, unknown>): string {
  const sortedKeys = Object.keys(meta).sort();
  const pairs: string[] = [];
  for (const k of sortedKeys) {
    const v = meta[k];
    if (v === undefined) continue;
    pairs.push(`${k}=${JSON.stringify(v)}`);
  }
  return pairs.join(" ");
}
