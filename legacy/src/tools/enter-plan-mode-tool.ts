import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import {
  describeEnterPlanModeTool,
  ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
} from "../tool-descriptions.js";
import { enterPlanModeStateUpdate, persistFromTool } from "./tool-state-helpers.js";

/**
 * `enter_plan_mode` agent tool — flips the session into plan mode so the
 * runtime mutation gate (src/mutation-gate.ts) starts blocking
 * write/edit/exec/etc. Read-only tools remain available.
 *
 * The actual session-state transition happens server-side in the
 * sessions.patch handler — this tool is the agent-visible affordance
 * that triggers the patch via the embedded runner. The tool body
 * intentionally has no side effects beyond returning a structured
 * result; the runner inspects the tool call name and applies the
 * session-state change.
 *
 * This split keeps the tool implementation cheap and testable while
 * letting the runtime own the session-state contract.
 */

const EnterPlanModeToolSchema = Type.Object(
  {
    reason: Type.Optional(
      Type.String({
        description:
          "Optional short justification shown alongside the mode-entered event " +
          "(e.g. 'multi-file refactor — surface the plan first').",
      }),
    ),
  },
  // Copilot review #68939 (2026-04-19): forbid additional properties
  // for consistency with `plan_mode_status` and the post-third-wave
  // schema-hardening direction.
  { additionalProperties: false },
);

export interface CreateEnterPlanModeToolOptions {
  /** Stable run identifier used by the runner to scope mode-entered events. */
  runId?: string;
  /** Agent id for the in-flight tool call (resolved by tool-factory in index.ts). */
  agentId?: string;
  /** Session key for the in-flight tool call. */
  sessionKey?: string;
}

export function createEnterPlanModeTool(options?: CreateEnterPlanModeToolOptions): AnyAgentTool {
  const ctx = { agentId: options?.agentId, sessionKey: options?.sessionKey };
  return {
    label: "Enter Plan Mode",
    name: "enter_plan_mode",
    displaySummary: ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
    description: describeEnterPlanModeTool(),
    parameters: EnterPlanModeToolSchema,
    execute: async (_toolCallId, args, _signal) => {
      const params = args as Record<string, unknown>;
      const reason = typeof params.reason === "string" ? params.reason.trim() : undefined;

      // Persist planMode flip — this is the actual state mutation that
      // arms the runtime mutation gate via `before_tool_call`. Without
      // this write, the gate never sees plan mode and write tools stay
      // unblocked. (Per #31: tool was previously decorative.)
      const persist = await persistFromTool(ctx, "enter_plan_mode", enterPlanModeStateUpdate);

      // Tool result content matters: returning an empty body lets the
      // model treat the tool call as the entire turn and stop. The
      // text below tells the agent — visibly in the tool result — that
      // entering plan mode is just step 1 and exit_plan_mode is the
      // next required action. Without this nudge agents commonly
      // respond with "I'm opening a fresh plan cycle" then halt.
      const lines = ["Plan mode is now active."];
      if (!persist.persisted) {
        lines.push(
          `(Note: state persistence skipped — ${persist.reason ?? "unknown reason"}; the mutation gate may not be armed.)`,
        );
      }
      lines.push(
        "Next required step: investigate read-only if needed (read, web_search, web_fetch), then call `exit_plan_mode` with the proposed plan.",
      );
      lines.push("Do NOT stop after this tool call — the plan has not been submitted yet.");
      lines.push(
        "Do NOT respond with the plan as chat text — it must go through `exit_plan_mode` so the user gets Approve/Reject buttons.",
      );
      return {
        content: [{ type: "text" as const, text: lines.join(" ") }],
        details: {
          status: "entered" as const,
          mode: "plan" as const,
          persisted: persist.persisted,
          ...(reason && reason.length > 0 ? { reason } : {}),
        },
      };
    },
  };
}
