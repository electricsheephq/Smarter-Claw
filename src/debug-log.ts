/**
 * Smarter Claw debug log — per-event logger gated by the plugin's
 * `debugLog` config knob. When enabled, plan-mode lifecycle events are
 * emitted to stderr where operators can `tail -F ~/.openclaw/logs/
 * gateway.err.log | grep '\[smarter-claw/'`.
 *
 * Closed-set event kinds; new kinds extend `PlanModeDebugEvent` so
 * downstream parsers can stay typed.
 */

export type PlanModeDebugEvent =
  | {
      kind: "state_transition";
      sessionKey: string;
      from: string;
      to: string;
      reason?: string;
    }
  | {
      kind: "gate_decision";
      sessionKey: string;
      tool: string;
      allowed: boolean;
      planMode: string;
      reason?: string;
    }
  | {
      kind: "approval_event";
      sessionKey: string;
      action: string;
      approvalId?: string;
    }
  | {
      kind: "synthetic_injection";
      sessionKey: string;
      marker: string;
    }
  | {
      kind: "tool_call";
      sessionKey: string;
      tool: string;
    };

let debugEnabled = false;

/** Configure the debug-log enabled flag. Called by the plugin entry on register. */
export function setPlanModeDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Read whether debug-log is currently enabled. Used by `plan_mode_status`. */
export function isPlanModeDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Emit a structured debug log line. No-op when disabled. Format:
 * `[smarter-claw/<kind>] <key>=<value> ...`.
 */
export function logPlanModeDebug(event: PlanModeDebugEvent): void {
  if (!debugEnabled) {
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
