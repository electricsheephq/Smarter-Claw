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
 * # Channel scope & dispatch
 *
 * A plugin-registered command has TWO independent dispatch paths in
 * OpenClaw:
 *   - Path A — the universal auto-reply text pipeline
 *     (`handlePluginCommand`). This runs on every channel that routes
 *     inbound text through auto-reply (webchat, Telegram, Slack,
 *     Discord, CLI). Typing `/plan accept` as a normal message is
 *     dispatched here. This — NOT the absence of a `channels` filter —
 *     is what makes `/plan` work everywhere.
 *   - Path B — the channel's NATIVE command surface (e.g. Telegram's
 *     "/" autocomplete menu + `bot.command()` handler).
 *
 * `/plan` sets no `channels` filter, so it is eligible for every
 * channel's native menu AND the text pipeline — it is the canonical
 * command on all channels, Telegram included.
 *
 * W1-S18-1: Telegram caps a bot's native menu at 100 commands. On a
 * gateway that exceeds that, plugin commands (appended after host
 * built-ins) can be sliced off the "/" menu. To avoid `/plan` +
 * `/plan-mode` consuming TWO scarce Telegram menu slots, the
 * `/plan-mode` ALIAS carries a `channels` filter that excludes
 * Telegram (see `createPlanModeSlashCommand`). `/plan` is unaffected;
 * if it ever drops off the Telegram menu it still works when typed,
 * and its `agentPromptGuidance` lets the agent tell the user so.
 *
 * host_ref: in-host /plan slash commands lived in a bespoke built-in
 *   handler in the same `loadCommandHandlers()` chain
 *   (`src/auto-reply/reply/commands-plan.ts`,
 *   `commands-handlers.runtime.ts`); the plugin rides the generic
 *   `handlePluginCommand` slot for functionally equivalent
 *   universality. The Telegram 100-command cap is a host-side
 *   constraint with no in-host plugin-side equivalent.
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
 * `agentPromptGuidance` for `/plan` — injected into the agent's system
 * prompt by the host (`listRegisteredPluginAgentPromptGuidance`) so the
 * agent knows the command exists and can tell the user how to invoke
 * it. This is the discoverability fallback for the case where the
 * Telegram native "/" menu is full (see the W1-S18-1 note in the file
 * header): even with no menu entry, the agent can still surface
 * `/plan accept | reject` to the user.
 */
const PLAN_AGENT_PROMPT_GUIDANCE: readonly string[] = [
  "Plan mode is available. When a plan is awaiting the user's decision, " +
    "the user can resolve it by typing a slash command directly in chat: " +
    "`/plan accept` (approve verbatim), `/plan edit <new plan text>` " +
    "(approve with edits), `/plan reject [reason]` (reject for revision), " +
    "or `/plan cancel` (exit plan mode). `/plan enter` enters plan mode. " +
    "These work on every channel even if the channel's native command " +
    "menu does not list them — if a user cannot find `/plan` in an " +
    "autocomplete menu, tell them to type it as a normal message.",
];

/**
 * Build the `/plan` command definition. Pass into `api.registerCommand`.
 *
 * `/plan` is the PRIMARY plan-mode command on every channel, including
 * Telegram. `channels` is intentionally NOT set — `/plan` must be
 * eligible for every channel's native menu and the universal text
 * pipeline. `/plan-mode` (the alias) is the one that takes a `channels`
 * filter, to free a scarce Telegram native-menu slot — see
 * `createPlanModeSlashCommand` below and the W1-S18-1 header note.
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
    agentPromptGuidance: PLAN_AGENT_PROMPT_GUIDANCE,
    handler: async (ctx) => handlePlanCommand(ctx, input),
  };
}

/**
 * Channels on which the `/plan-mode` alias is registered. Telegram is
 * DELIBERATELY EXCLUDED — see `createPlanModeSlashCommand` below.
 *
 * (`pluginCommandSupportsChannel` lowercase-normalizes channel ids, so
 * these are the canonical ids the host's channel plugins use.)
 */
const PLAN_MODE_ALIAS_CHANNELS: readonly string[] = [
  "webchat",
  "slack",
  "discord",
  "cli",
];

/**
 * Companion command: `/plan-mode` as an alias-shorthand for `/plan`.
 * Users who memorize `/plan-mode` from the in-host UX find it works on
 * webchat / Slack / Discord / CLI.
 *
 * # W1-S18-1 — why `channels` excludes Telegram
 *
 * Telegram caps a bot's native "/" command menu at 100 commands
 * (`TELEGRAM_MAX_COMMANDS`). A gateway with many channels/plugins can
 * exceed that; host built-ins are listed first and plugin commands are
 * appended, so plugin commands land in the dropped tail. Registering
 * BOTH `/plan` and `/plan-mode` consumes TWO scarce Telegram menu
 * slots and doubles the chance one of them is sliced off. `/plan` is
 * the canonical command; `/plan-mode` is a redundant convenience
 * alias. So we keep `/plan-mode` OFF Telegram entirely — freeing the
 * second slot for `/plan`.
 *
 * IMPORTANT — honest residual limitation: the SDK exposes exactly ONE
 * per-command channel-scoping mechanism, the `channels` allowlist, and
 * `pluginCommandSupportsChannel` gates BOTH dispatch paths with it:
 *   - Path B, the native "/" menu (`getPluginCommandSpecs` →
 *     `listProviderPluginCommandSpecs`); and
 *   - Path A, the universal auto-reply text pipeline, on channel-aware
 *     call sites — `handlePluginCommand` calls
 *     `matchPluginCommand(body, { channel })` with the Telegram channel.
 * There is NO SDK field for "functional via text but hidden from the
 * native menu". Consequently, excluding `telegram` here means the
 * literal string `/plan-mode` is non-functional on Telegram (both menu
 * AND typed-as-text). This is acceptable: `/plan` IS the Telegram
 * surface and is fully functional there (menu, native handler, and
 * text pipeline), and `/plan-mode` remains fully functional on every
 * other channel. A Telegram user who types `/plan-mode` gets no match;
 * they should use `/plan`. (An earlier build-spec draft claimed the
 * text pipeline would still serve `/plan-mode` on Telegram — that is
 * incorrect; `matchPluginCommand` applies the same `channels` gate.)
 *
 * `/plan` itself is unaffected — it sets no `channels` filter and
 * stays eligible for the Telegram native menu and text pipeline.
 */
export function createPlanModeSlashCommand(
  input: CreatePlanSlashCommandInput,
): OpenClawPluginCommandDefinition {
  return {
    name: "plan-mode",
    description:
      "Alias for `/plan` — enter plan mode and inspect/resolve approvals.",
    acceptsArgs: true,
    // Excludes "telegram" — see the doc comment above (W1-S18-1).
    channels: PLAN_MODE_ALIAS_CHANNELS,
    agentPromptGuidance: PLAN_AGENT_PROMPT_GUIDANCE,
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
