/**
 * `/plan` slash command — in-chat user surface for plan-mode actions.
 *
 * **Why this exists** (hotfix 2026-05-13): the plugin's session-actions
 * (`plan.accept` / `plan.reject` / etc.) are handler functions
 * dispatched by ID — they're not directly callable by the user typing
 * in chat. The in-host version had `/plan accept|reject|cancel|edit`
 * slash commands that routed through openclaw's command surface;
 * Beta 5 vanilla openclaw exposes a `registerCommand` SDK seam but
 * plugins must opt in. The original P-12 work registered the session
 * actions but missed wiring them to the user-typed slash surface.
 *
 * # Command shape
 *
 * `/plan <subcommand> [args]`
 *
 *   - `/plan` (no args)             — show current plan-mode state
 *   - `/plan enter`                 — enter plan mode (same as enter_plan_mode tool)
 *   - `/plan exit`                  — leave plan mode (same as plan.cancel)
 *   - `/plan accept`                — approve the pending plan (verbatim)
 *   - `/plan edit <body>`           — approve with inline-edited body
 *   - `/plan reject <feedback>`     — reject with feedback
 *   - `/plan cancel`                — exit plan mode (alias for `exit`)
 *   - `/plan answer <option>`       — answer a pending ask_user_question
 *   - `/plan auto on|off`           — toggle auto-approve mode
 *
 * # Dispatch
 *
 * Each subcommand routes to the corresponding session-action via the
 * plugin's existing dispatcher. No re-implementation; this is the
 * user-typing surface in front of the same action handlers.
 *
 * # Channel scope
 *
 * Registered without a `channels` filter → available on every channel
 * surface (webchat, telegram, etc.).
 *
 * host_ref: in-host /plan slash commands at
 *   `openclaw-pr70071-rebase/src/agents/...` (the in-host wired these
 *   into its native command surface; this is the plugin equivalent).
 */

import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
  PluginSessionActionContext,
  PluginSessionActionResult,
} from "openclaw/plugin-sdk/plugin-entry";

type SessionActionHandler = (
  ctx: PluginSessionActionContext,
) => Promise<PluginSessionActionResult> | PluginSessionActionResult;

export interface CreatePlanSlashCommandInput {
  /**
   * Map of session-action id → handler. Built by `createPlanModeSessionActions`
   * at the same time the actions are registered with the host.
   */
  actions: Map<string, SessionActionHandler>;
}

/**
 * Build the `/plan` command definition. Pass into `api.registerCommand`.
 */
export function createPlanSlashCommand(
  input: CreatePlanSlashCommandInput,
): OpenClawPluginCommandDefinition {
  return {
    name: "plan",
    description:
      "Plan-mode controls: /plan accept | edit | reject | cancel | enter | exit | answer | auto on|off",
    acceptsArgs: true,
    // Available on every channel; do NOT restrict via `channels`.
    handler: async (ctx) => handlePlanCommand(ctx, input.actions),
  };
}

/**
 * Companion command: `/plan-mode` as an alias-shorthand for `/plan`
 * (with no subcommand → status, with subcommand → same dispatch).
 * Users who memorize `/plan-mode` from the in-host UX find it works.
 */
export function createPlanModeSlashCommand(
  input: CreatePlanSlashCommandInput,
): OpenClawPluginCommandDefinition {
  return {
    name: "plan-mode",
    description:
      "Alias for `/plan` — toggle plan mode and inspect/resolve approvals.",
    acceptsArgs: true,
    handler: async (ctx) => handlePlanCommand(ctx, input.actions),
  };
}

async function handlePlanCommand(
  ctx: PluginCommandContext,
  actions: Map<string, SessionActionHandler>,
): Promise<PluginCommandResult> {
  const args = (ctx.args ?? "").trim();
  if (!args) {
    return reply(
      "Plan-mode commands:\n" +
        "  /plan enter            — enter plan mode\n" +
        "  /plan exit             — leave plan mode\n" +
        "  /plan accept           — approve pending plan (verbatim)\n" +
        "  /plan edit <body>      — approve with edits\n" +
        "  /plan reject [reason]  — reject with optional feedback\n" +
        "  /plan cancel           — exit plan mode\n" +
        "  /plan answer <option>  — answer pending question\n" +
        "  /plan auto on|off      — toggle auto-approve",
    );
  }

  const [verb, ...rest] = args.split(/\s+/);
  const tail = args.slice(verb.length).trim();

  switch (verb.toLowerCase()) {
    case "accept":
    case "approve":
      return dispatchAction(actions, "plan.accept", ctx, {});
    case "edit":
      if (!tail) {
        return reply("`/plan edit` requires an edited body. Usage: `/plan edit <new plan text>`");
      }
      return dispatchAction(actions, "plan.edit", ctx, { body: tail });
    case "reject":
    case "rev":
    case "revise":
      return dispatchAction(actions, "plan.reject", ctx, {
        ...(tail ? { feedback: tail } : {}),
      });
    case "cancel":
    case "exit":
      return dispatchAction(actions, "plan.cancel", ctx, {});
    case "answer":
    case "ans":
      if (!tail) {
        return reply("`/plan answer` requires an option. Usage: `/plan answer <option>`");
      }
      return dispatchAction(actions, "plan.answer", ctx, { selectedOption: tail });
    case "auto":
      if (tail === "on" || tail === "true" || tail === "enable") {
        return dispatchAction(actions, "plan.auto.toggle", ctx, { enabled: true });
      }
      if (tail === "off" || tail === "false" || tail === "disable") {
        return dispatchAction(actions, "plan.auto.toggle", ctx, { enabled: false });
      }
      return reply("`/plan auto` requires `on` or `off`.");
    case "enter":
      // No "plan.enter" session-action exists; instruct the user to
      // ask the agent or call the tool. (The agent itself owns the
      // enter_plan_mode tool call; a direct user surface is harder
      // because it requires emitting a synthetic agent turn.)
      return reply(
        "To enter plan mode, ask the agent to start one (e.g. 'plan this multi-step task before executing'). The agent calls `enter_plan_mode` to flip the session.",
      );
    case "status":
    case "":
      return reply(
        "Plan-mode status — use the sidebar widget to see current state, or invoke /plan accept|reject|edit|cancel|answer|auto.",
      );
    default:
      return reply(
        `Unknown /plan subcommand: \`${verb}\`. Try \`/plan\` (no args) for usage.`,
      );
  }
  void rest; // keep linter happy in case of future args
}

async function dispatchAction(
  actions: Map<string, SessionActionHandler>,
  actionId: string,
  ctx: PluginCommandContext,
  payload: { [key: string]: string | number | boolean | null },
): Promise<PluginCommandResult> {
  const handler = actions.get(actionId);
  if (!handler) {
    return reply(
      `Internal error: session action \`${actionId}\` is not registered. ` +
        `This is a plugin wiring bug — please report.`,
    );
  }
  if (!ctx.sessionKey) {
    return reply(
      "`/plan` commands require a session context. Try sending the command from inside an active session, not a control-plane surface.",
    );
  }
  // Build a synthetic session-action context. The handler accepts a
  // PluginSessionActionContext shape that includes pluginId / actionId /
  // sessionKey / payload — matches how the host invokes the action
  // via registerSessionAction.
  const actionResult = await handler({
    pluginId: "smarter-claw",
    actionId,
    sessionKey: ctx.sessionKey,
    payload,
  });
  if (!actionResult || actionResult.ok === false) {
    const code = (actionResult as { code?: string } | undefined)?.code ?? "ERROR";
    const error = (actionResult as { error?: string } | undefined)?.error ?? "unknown";
    return reply(`/plan ${actionId.replace("plan.", "")} failed: ${code} — ${error}`);
  }
  // Surface a concise result.
  const friendly: Record<string, string> = {
    "plan.accept": "Plan approved — agent will resume execution.",
    "plan.edit": "Plan approved with edits — agent will execute the edited body.",
    "plan.reject": "Plan rejected — agent will revise based on your feedback.",
    "plan.cancel": "Exited plan mode — back to normal session.",
    "plan.answer": "Question answered — agent will resume.",
    "plan.auto.toggle": "Auto-approve toggled.",
  };
  return {
    text: friendly[actionId] ?? `${actionId} ok`,
    ...(actionResult.continueAgent !== undefined
      ? { continueAgent: actionResult.continueAgent }
      : {}),
  };
}

function reply(text: string): PluginCommandResult {
  return { text };
}
