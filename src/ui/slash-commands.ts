/**
 * `/plan` slash command — in-chat user surface for plan-mode actions.
 *
 * **Why this exists** (hotfix 2026-05-13): the plugin's session-actions
 * (`plan.accept` / `plan.reject` / etc.) are handler functions
 * dispatched by ID — they're not directly callable by the user typing
 * in chat. The in-host version had `/plan accept|reject|cancel|edit`
 * slash commands that routed through openclaw's command surface;
 * vanilla openclaw exposes a `registerCommand` SDK seam but plugins
 * must opt in. The original P-12 work registered the session actions
 * but missed wiring them to the user-typed slash surface.
 *
 * # Command shape
 *
 * `/plan <subcommand> [args]`
 *
 *   - `/plan` (no args)             — show usage
 *   - `/plan enter`                 — enter plan mode (flips session state)
 *   - `/plan exit` / `/plan cancel` — leave plan mode
 *   - `/plan accept`                — approve the pending plan (verbatim)
 *   - `/plan edit <body>`           — approve with inline-edited body
 *   - `/plan reject [feedback]`     — reject with feedback
 *   - `/plan auto on|off`           — toggle auto-approve mode
 *
 * `/plan answer` is intentionally NOT wired through this surface — see
 * the `answer` case below for the rationale (plugin-side question-state
 * tracking does not exist yet; tracked as a Wave-1 finding).
 *
 * # Dispatch
 *
 * Approval subcommands route to the corresponding session-action via
 * the plugin's existing dispatcher — no re-implementation, this is the
 * user-typing surface in front of the same action handlers. `/plan
 * enter` is the exception: there is no `plan.enter` session-action, so
 * it calls `PlanModeStore.enterPlanMode` directly.
 *
 * # Channel scope
 *
 * Registered without a `channels` filter → available on every channel
 * surface (webchat, Telegram, Slack, etc.).
 *
 * host_ref: in-host /plan slash commands (the in-host wired these into
 *   its native command surface; this is the plugin equivalent).
 */

import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
  PluginSessionActionContext,
  PluginSessionActionResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PlanModeStore } from "../state/store.js";

type SessionActionHandler = (
  ctx: PluginSessionActionContext,
) => Promise<PluginSessionActionResult> | PluginSessionActionResult;

export interface CreatePlanSlashCommandInput {
  /**
   * Map of session-action id → handler. Built by `createPlanModeSessionActions`
   * at the same time the actions are registered with the host.
   */
  actions: Map<string, SessionActionHandler>;
  /**
   * The plan-mode store — used by `/plan enter` to flip session state
   * directly (there is no `plan.enter` session-action to dispatch to).
   */
  store: PlanModeStore;
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
      "Plan-mode controls: /plan enter | accept | edit | reject | cancel | auto on|off",
    acceptsArgs: true,
    // Available on every channel; do NOT restrict via `channels`.
    handler: async (ctx) => handlePlanCommand(ctx, input),
  };
}

/**
 * Companion command: `/plan-mode` as an alias-shorthand for `/plan`.
 * Users who memorize `/plan-mode` from the in-host UX find it works.
 */
export function createPlanModeSlashCommand(
  input: CreatePlanSlashCommandInput,
): OpenClawPluginCommandDefinition {
  return {
    name: "plan-mode",
    description:
      "Alias for `/plan` — enter plan mode and inspect/resolve approvals.",
    acceptsArgs: true,
    handler: async (ctx) => handlePlanCommand(ctx, input),
  };
}

const USAGE = [
  "Plan-mode commands:",
  "  /plan enter            — enter plan mode",
  "  /plan exit             — leave plan mode",
  "  /plan accept           — approve pending plan (verbatim)",
  "  /plan edit <body>      — approve with edits",
  "  /plan reject [reason]  — reject with optional feedback",
  "  /plan cancel           — exit plan mode",
  "  /plan auto on|off      — toggle auto-approve",
  "(Answer pending questions from the approval card.)",
].join("\n");

async function handlePlanCommand(
  ctx: PluginCommandContext,
  input: CreatePlanSlashCommandInput,
): Promise<PluginCommandResult> {
  const args = (ctx.args ?? "").trim();
  if (!args) {
    return reply(USAGE);
  }

  // Parse `<verb> <tail>` — verb is the first whitespace-delimited
  // token, tail is everything after it (preserves internal spacing).
  const verb = (args.split(/\s+/, 1)[0] ?? "").toLowerCase();
  const tail = args.slice(verb.length).trim();

  switch (verb) {
    case "accept":
    case "approve":
      return dispatchAction(input.actions, "plan.accept", ctx, {});
    case "edit":
      if (!tail) {
        return reply(
          "`/plan edit` requires an edited body. Usage: `/plan edit <new plan text>`",
        );
      }
      return dispatchAction(input.actions, "plan.edit", ctx, { body: tail });
    case "reject":
    case "rev":
    case "revise":
      return dispatchAction(input.actions, "plan.reject", ctx, {
        ...(tail ? { feedback: tail } : {}),
      });
    case "cancel":
    case "exit":
      return dispatchAction(input.actions, "plan.cancel", ctx, {});
    case "auto":
      if (tail === "on" || tail === "true" || tail === "enable") {
        return dispatchAction(input.actions, "plan.auto.toggle", ctx, {
          enabled: true,
        });
      }
      if (tail === "off" || tail === "false" || tail === "disable") {
        return dispatchAction(input.actions, "plan.auto.toggle", ctx, {
          enabled: false,
        });
      }
      return reply("`/plan auto` requires `on` or `off`.");
    case "enter":
      return handleEnter(ctx, input.store);
    case "answer":
    case "ans":
      // No slash-surface answering: pending-question metadata
      // (questionId / questionPrompt) is minted host-side by
      // ask_user_question and is NOT projected into plan-mode state,
      // so this command cannot supply the `plan.answer` session-action
      // its required payload. Route the user to the approval card.
      // Tracked as a Wave-1 finding (plugin-side question-state
      // tracking + cross-platform answer surface — Wave 4).
      return reply(
        "Answer pending questions from the approval card. Slash-command " +
          "answering is not available yet — it needs plugin-side " +
          "question-state tracking (known gap).",
      );
    case "status":
      return reply(USAGE);
    default:
      return reply(
        `Unknown /plan subcommand: \`${verb}\`. Send \`/plan\` (no args) for usage.`,
      );
  }
}

/**
 * `/plan enter` — flip the session into plan mode. There is no
 * `plan.enter` session-action, so this calls the store directly.
 */
async function handleEnter(
  ctx: PluginCommandContext,
  store: PlanModeStore,
): Promise<PluginCommandResult> {
  if (!ctx.sessionKey) {
    return reply(
      "`/plan enter` requires a session context. Send it from inside an active session.",
    );
  }
  let result: Awaited<ReturnType<PlanModeStore["enterPlanMode"]>>;
  try {
    result = await store.enterPlanMode({ sessionKey: ctx.sessionKey });
  } catch (err) {
    return reply(
      `/plan enter failed: ${(err as Error).message ?? "unexpected error"}`,
    );
  }
  if (result.kind === "failed") {
    return reply(`/plan enter failed: ${result.error.message}`);
  }
  return reply(
    result.kind === "noop"
      ? "Already in plan mode — investigate read-only, then propose a plan."
      : "Plan mode entered. Mutating tools are blocked until a plan is approved.",
  );
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
      "`/plan` commands require a session context. Send the command from " +
        "inside an active session, not a control-plane surface.",
    );
  }
  // Build a synthetic session-action context. The handler accepts a
  // PluginSessionActionContext shape that includes pluginId / actionId /
  // sessionKey / payload — matches how the host invokes the action
  // via registerSessionAction. The handler call is wrapped in
  // try/catch: a thrown handler error must surface as a clean reply,
  // not an unhandled rejection that the channel renders as a crash.
  let actionResult: PluginSessionActionResult | void;
  try {
    actionResult = await handler({
      pluginId: "smarter-claw",
      actionId,
      sessionKey: ctx.sessionKey,
      payload,
    });
  } catch (err) {
    return reply(
      `/plan ${actionId.replace("plan.", "")} failed: ` +
        `${(err as Error).message ?? "unexpected error"}`,
    );
  }
  if (!actionResult || actionResult.ok === false) {
    const code = (actionResult as { code?: string } | undefined)?.code ?? "ERROR";
    const error =
      (actionResult as { error?: string } | undefined)?.error ?? "unknown";
    return reply(`/plan ${actionId.replace("plan.", "")} failed: ${code} — ${error}`);
  }
  // Surface a concise result.
  const friendly: Record<string, string> = {
    "plan.accept": "Plan approved — agent will resume execution.",
    "plan.edit": "Plan approved with edits — agent will execute the edited body.",
    "plan.reject": "Plan rejected — agent will revise based on your feedback.",
    "plan.cancel": "Exited plan mode — back to normal session.",
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
