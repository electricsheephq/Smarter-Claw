/**
 * `enter_plan_mode` agent tool.
 *
 * host_ref: src/agents/tools/enter-plan-mode-tool.ts (in-host source-of-truth)
 *
 * # What this does
 *
 * Transitions the session into plan mode by writing the plan-mode
 * payload through PlanModeStore. Once in plan mode, the mutation gate
 * (P-5, registered as `before_tool_call` hook) blocks Edit/Write/Bash
 * tools until plan-mode exits via `exit_plan_mode` or `/plan exit`.
 *
 * # In-host vs plugin port
 *
 * The in-host version's tool body has NO side effects beyond returning
 * a structured result — the embedded runner (`pi-embedded-runner/run.ts`)
 * intercepts the tool call and applies the state transition. The
 * plugin port doesn't have a runner, so the tool body itself calls
 * PlanModeStore.enterPlanMode(). Equivalent behavior, different
 * locus of mutation.
 *
 * # Output contract
 *
 * The text content explicitly tells the model that entering plan mode
 * is step 1 of 2, and that exit_plan_mode (with a real plan body) is
 * the next required action. Without this nudge, models commonly
 * respond with "I'm opening a fresh plan cycle" and HALT, leaving the
 * session in plan mode with no plan proposed.
 *
 * host_ref output prose: src/agents/tools/enter-plan-mode-tool.ts:62-68
 */

import { Type } from "@sinclair/typebox";
import { PlanModeStore } from "../state/store.js";
import { readStringParam } from "./common.js";

export interface CreateEnterPlanModeToolInput {
  store: PlanModeStore;
}

/**
 * Per-tool-use context passed by the SDK to plugin tool factories.
 * Subset of `OpenClawPluginToolContext` — we only use `sessionKey`.
 */
interface ToolContext {
  sessionKey?: string;
}

const SCHEMA = Type.Object(
  {
    reason: Type.Optional(
      Type.String({
        description:
          "Optional short justification shown alongside the mode-entered event " +
          "(e.g. 'multi-file refactor — surface the plan first').",
      }),
    ),
  },
  { additionalProperties: false },
);

const TOOL_DESCRIPTION =
  "Enter plan mode. While active, mutating tools (Edit, Write, Bash, " +
  "NotebookEdit) are blocked; the agent must propose a plan via " +
  "`exit_plan_mode` and get user approval before mutations resume. " +
  "Use this for multi-file refactors, design decisions with multiple " +
  "options, or any change the user should review before execution.";

const TOOL_OUTPUT_TEXT = [
  "Plan mode is now active.",
  "Next required step: investigate read-only if needed (read, web_search, web_fetch), then call `exit_plan_mode` with the proposed plan.",
  "Do NOT stop after this tool call — the plan has not been submitted yet.",
  "Do NOT respond with the plan as chat text — it must go through `exit_plan_mode` so the user gets Approve/Reject buttons.",
].join(" ");

/**
 * Tool factory. Pass into `api.registerTool` in the plugin entry.
 *
 * The factory shape matches `OpenClawPluginToolFactory` — a function
 * that takes a per-call tool context and returns an AnyAgentTool. We
 * receive the store + sessionKey resolver via closure here so each
 * per-call invocation uses the right session.
 */
/**
 * Tool factory matching the SDK's OpenClawPluginToolFactory signature.
 * Pass into `api.registerTool` in the plugin entry. The SDK invokes
 * this factory per-tool-use with a `ctx` containing `sessionKey` (and
 * other per-call metadata we don't currently consume).
 */
export function createEnterPlanModeTool(opts: CreateEnterPlanModeToolInput) {
  return (ctx: ToolContext) => ({
    label: "Enter Plan Mode",
    name: "enter_plan_mode",
    description: TOOL_DESCRIPTION,
    parameters: SCHEMA,
    execute: async (
      _toolCallId: string,
      args: unknown,
      _signal?: AbortSignal,
    ) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const reason = readStringParam(params, "reason");
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        // No sessionKey resolvable — tool can't persist state. Return
        // a soft error in the content so the model sees it; don't
        // throw, since downstream agent loops handle structured
        // failures more gracefully than thrown exceptions.
        return {
          content: [
            {
              type: "text" as const,
              text:
                "enter_plan_mode: no sessionKey resolvable in this context; cannot persist plan-mode state. " +
                "This indicates a plugin wiring issue — please report.",
            },
          ],
          details: { status: "no-session" as const },
        };
      }

      const r = await opts.store.enterPlanMode({ sessionKey, reason });
      if (r.kind === "failed") {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "enter_plan_mode encountered an error persisting plan-mode state. " +
                "The session may not actually be in plan mode. " +
                `Cause: ${r.error.message}`,
            },
          ],
          details: { status: "failed" as const, error: r.error.message },
        };
      }
      // entered or noop — both report the same model-facing outcome
      // (plan mode is active). The noop case is the agent calling
      // enter_plan_mode when already in plan mode; we still want it to
      // proceed to the exit_plan_mode step.
      return {
        content: [{ type: "text" as const, text: TOOL_OUTPUT_TEXT }],
        details: {
          status: r.kind === "noop" ? ("already-in-plan-mode" as const) : ("entered" as const),
          mode: "plan" as const,
          ...(reason && reason.length > 0 ? { reason } : {}),
        },
      };
    },
  });
}
