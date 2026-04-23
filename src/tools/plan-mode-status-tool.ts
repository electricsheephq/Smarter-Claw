/**
 * `plan_mode_status` agent tool — read-only introspection of the
 * current plan-mode lifecycle state.
 *
 * # Why this exists (iter-3 D6)
 *
 * Without this, an agent debugging a stuck plan-mode session has to
 * INFER state from tool errors ("update_plan rejected → I must not
 * be in plan mode anymore") or wait for the runtime to inject a
 * `[PLAN_DECISION]:` synthetic message. Neither path is reliable
 * for self-diagnosis.
 *
 * `plan_mode_status` returns a structured snapshot the agent can
 * inspect directly:
 *   - is plan mode active?
 *   - is there a pending approval, and what's its title?
 *   - how many subagents are in flight (would block exit_plan_mode)?
 *   - is the plan-mode debug log currently enabled?
 *   - was the [PLAN_MODE_INTRO]: one-shot delivered yet?
 *
 * # Read-only contract
 *
 * This tool ONLY reads state; it never mutates. Safe to call at
 * any point in any session, including during a pending approval.
 * No side effects on the [PLAN_MODE_INTRO]: one-shot, the
 * pendingAgentInjection consumer, or any other state.
 *
 * # Plugin-port note (2026-04-24)
 *
 * In the original openclaw-1 in-core impl this tool read directly from
 * core's `loadSessionStore` and `getAgentRunContext`. The Smarter-Claw
 * plugin port reads via the plugin SDK's session-store-runtime and the
 * plugin-namespaced `pluginMetadata['smarter-claw']` slice (see
 * runtime-api.ts). `openSubagentRunIds` is a runtime-only field that
 * lives on AgentRunContext — the plugin doesn't have direct access yet,
 * so this port returns 0/empty for that field. A subagent-tracking
 * hook subscription can wire that back in later.
 */
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readSmarterClawState } from "../../runtime-api.js";
import {
  describePlanModeStatusTool,
  PLAN_MODE_STATUS_TOOL_DISPLAY_SUMMARY,
} from "../tool-descriptions.js";

// Copilot review #68939 (2026-04-19): explicitly forbid additional
// properties — the tool ignores args entirely, so accepting any
// payload is unnecessary and complicates downstream validation /
// telemetry.
const PlanModeStatusToolSchema = Type.Object({}, { additionalProperties: false });

export interface CreatePlanModeStatusToolOptions {
  /** Stable run identifier (kept for telemetry; not used to read AgentRunContext in the plugin port). */
  runId?: string;
  /** Session key used to look up persisted plan-mode state on disk. */
  sessionKey?: string;
  /** Storage path used by `loadSessionStore` to read the live session entry. */
  storePath?: string;
  /** Stable agent id used to derive the default store path when storePath is omitted. */
  agentId?: string;
  /**
   * When set, the tool reports whether the plan-mode debug log is
   * enabled. Wired by `index.ts` from the plugin's resolved config so
   * we don't depend on env-var introspection inside the tool.
   */
  debugLogEnabled?: boolean;
}

export function createPlanModeStatusTool(options?: CreatePlanModeStatusToolOptions): AnyAgentTool {
  return {
    label: "Plan Mode Status",
    name: "plan_mode_status",
    displaySummary: PLAN_MODE_STATUS_TOOL_DISPLAY_SUMMARY,
    description: describePlanModeStatusTool(),
    parameters: PlanModeStatusToolSchema,
    execute: async (_toolCallId, _args, _signal) => {
      const runId = options?.runId;
      const sessionKey = options?.sessionKey;
      const debugLogEnabled = Boolean(options?.debugLogEnabled);

      // Resolve storePath either from explicit option or from the agent's
      // default location. Use the plugin SDK's resolveStorePath helper.
      let storePath = options?.storePath;
      if (!storePath && options?.agentId) {
        try {
          storePath = resolveStorePath(options.agentId);
        } catch {
          storePath = undefined;
        }
      }

      // Read the live session entry from disk. Track success/failure
      // explicitly (sessionStoreReadOk) so the tool's human summary can
      // distinguish a true "not in plan mode" from "we couldn't read
      // disk to find out".
      let entry: ReturnType<typeof resolveSessionStoreEntry>["existing"];
      let sessionStoreReadOk = true;
      let sessionStoreReadError: string | undefined;
      if (storePath && sessionKey) {
        try {
          const liveStore = loadSessionStore(storePath, { skipCache: true });
          const resolved = resolveSessionStoreEntry({
            store: liveStore ?? {},
            sessionKey,
          });
          entry = resolved.existing;
        } catch (err) {
          sessionStoreReadOk = false;
          sessionStoreReadError = err instanceof Error ? err.message : String(err);
        }
      } else {
        sessionStoreReadOk = false;
        const missing: string[] = [];
        if (!storePath) missing.push("storePath");
        if (!sessionKey) missing.push("sessionKey");
        sessionStoreReadError = `missing ${missing.join("/")}`;
      }

      // Plugin-port: the original tool also read openSubagentRunIds from
      // AgentRunContext (runtime-only state). The plugin doesn't have a
      // wired path to that yet — return 0/empty until we add a hook
      // subscription that tracks subagent lifecycle into the
      // pluginMetadata slice.
      const openSubagentRunIds: string[] = [];

      const planState = entry ? readSmarterClawState(entry) : undefined;
      const inPlanMode = planState?.planMode === "plan";
      const lastPlan = planState?.lastPlanSteps;

      const status = {
        inPlanMode,
        approval: planState?.planApproval,
        title: lastPlan?.title,
        approvalRunId: undefined as string | undefined, // not yet tracked in plugin slice
        planStepCount: lastPlan?.steps?.length ?? 0,
        openSubagentCount: openSubagentRunIds.length,
        openSubagentRunIds: openSubagentRunIds.slice(0, 10),
        recentlyApprovedAt: planState?.recentlyApprovedAt,
        pendingAgentInjectionPreview: planState?.pendingAgentInjection
          ? `${planState.pendingAgentInjection.kind}: ${planState.pendingAgentInjection.body.slice(0, 200)}`
          : undefined,
        planModeIntroDeliveredAt: planState?.planModeIntroDeliveredAt,
        autoApprove: planState?.autoApprove,
        debugLogEnabled,
        sessionKey,
        runId,
        sessionStoreReadOk,
        ...(sessionStoreReadError ? { sessionStoreReadError } : {}),
      };

      const summary = !sessionStoreReadOk
        ? `WARNING: session-store read failed (${sessionStoreReadError ?? "unknown error"}); plan-mode state is UNKNOWN. The agent should treat this as a transient diagnostic failure, not a confirmed "normal" state.`
        : inPlanMode
          ? `In plan mode (approval=${planState?.planApproval ?? "none"}; title="${lastPlan?.title ?? "(unset)"}"; ${openSubagentRunIds.length} subagent(s) in flight; ${lastPlan?.steps?.length ?? 0} plan step(s) tracked).`
          : `Not in plan mode (mode=${planState?.planMode ?? "normal"}; ${planState?.recentlyApprovedAt ? `recently approved at ${planState.recentlyApprovedAt}` : "no recent approval"}).`;
      const debugSuffix = debugLogEnabled
        ? " Plan-mode debug log is ENABLED — tail with: tail -F ~/.openclaw/logs/gateway.err.log | grep '\\[smarter-claw/'"
        : " Plan-mode debug log is DISABLED — enable with: openclaw config set plugins.entries.smarter-claw.config.debugLog true";
      const text = `${summary}${debugSuffix}`;

      return {
        content: [{ type: "text" as const, text }],
        details: {
          status: "ok" as const,
          ...status,
        },
      };
    },
  };
}
