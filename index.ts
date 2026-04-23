/**
 * Smarter Claw — OpenClaw plugin entry.
 *
 * Wires plan-mode tools, hooks, and slash commands into OpenClaw's plugin
 * SDK. The actual implementations live in `src/`; this file is just the
 * registration surface and stays small enough to scan in one screen.
 *
 * Loaded by OpenClaw via the `openclaw.extensions` entry in `package.json`
 * (resolves to `./dist/index.js` after `pnpm build`). Manifest at
 * `openclaw.plugin.json` declares the plugin id, config schema, and UI
 * hints; this entry does the runtime wiring.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildArchetypePromptResult } from "./src/archetype-hook.js";
import { isPlanModeDebugEnabled, setPlanModeDebugEnabled } from "./src/debug-log.js";
import { createPlanCommandHandler } from "./src/slash-commands.js";
import { createAskUserQuestionTool } from "./src/tools/ask-user-question-tool.js";
import { createEnterPlanModeTool } from "./src/tools/enter-plan-mode-tool.js";
import { createExitPlanModeTool } from "./src/tools/exit-plan-mode-tool.js";
import { createPlanModeStatusTool } from "./src/tools/plan-mode-status-tool.js";
import { SMARTER_CLAW_PLUGIN_ID } from "./src/types.js";

// Phase 2.1 (2026-04-24): tools registered via api.registerTool.
// Phase 2.2 (2026-04-24): before_prompt_build hook injects archetype prompt.
// Future clusters land their own registrations here:
//   - Phase 2.3: api.registerHook("tool_result", mutation gate +
//                                 accept-edits gate + plan-state writer)
//   - Phase 2.4: api.registerHook("agent_end", ack-only retry +
//                                 injections + auto-enable wiring)
//   - Phase 2.5: api.registerCommand("plan", slash command dispatcher)
//   - Phase 2.6: snapshot-persister wiring + plan-nudge cron registration

type SmarterClawConfig = {
  enabled?: boolean;
  debugLog?: boolean;
  archetype?: { enabled?: boolean; minStepCount?: number };
};

function readConfig(pluginConfig: unknown): SmarterClawConfig {
  if (!pluginConfig || typeof pluginConfig !== "object") {
    return {};
  }
  return pluginConfig as SmarterClawConfig;
}

export default definePluginEntry({
  id: SMARTER_CLAW_PLUGIN_ID,
  name: "Smarter Claw",
  description:
    "Plan Mode, Auto-Plan Mode, and every mode on Claude Code/Codex. Plan-then-execute workflow with archetype prompting, mutation gate, and ack-only retry. Universal across Pi and Codex harnesses.",
  register(api) {
    const config = readConfig(api.pluginConfig);
    if (config.enabled === false) {
      // Plugin explicitly disabled via config — register nothing.
      return;
    }

    // Wire the debug-log knob from plugin config so plan_mode_status and
    // every gate decision can be traced when debugLog is on.
    setPlanModeDebugEnabled(config.debugLog === true);

    // Phase 2.1: register the four plan-mode agent tools. Each tool is
    // a fresh instance per-call so options like runId/sessionKey can be
    // wired by the host runner via the tool factory pattern. Today the
    // factories take no per-call options through registerTool, so the
    // tools fall back to their no-arg defaults; per-session wiring lives
    // in the hook clusters that come next.
    api.registerTool(createEnterPlanModeTool());
    api.registerTool(createExitPlanModeTool());
    api.registerTool(createAskUserQuestionTool());
    api.registerTool(
      createPlanModeStatusTool({
        debugLogEnabled: isPlanModeDebugEnabled(),
      }),
    );

    // Phase 2.2: inject the plan-archetype system prompt fragment via
    // the before_prompt_build LIFECYCLE hook (registered via api.on,
    // not api.registerHook — those are two different surfaces:
    // api.registerHook is the legacy InternalHookHandler event bus,
    // api.on is the typed PluginHookHandlerMap lifecycle hook). Fires
    // before every turn; reads the session state via the plugin-
    // namespaced metadata slot and only appends the prompt when
    // planMode === "plan". No-op otherwise so we don't add cacheable
    // bytes to non-plan-mode prompts.
    const archetypeEnabled = config.archetype?.enabled !== false;
    api.on("before_prompt_build", (_event, ctx) => {
      return buildArchetypePromptResult(
        { enabled: archetypeEnabled },
        { agentId: ctx.agentId, sessionKey: ctx.sessionKey },
      );
    });

    // Phase 2.5: register the universal `/plan` slash command. The
    // handler is wired with empty deps for now — the installer-side
    // patch wave is responsible for injecting `applyPlanPatch` and
    // `resolveSession` so the mutating subcommands actually flip
    // session state. Until that lands, `/plan status`, `/plan view`,
    // and `/plan restate` work read-only; `/plan accept` and
    // friends return a friendly "wiring not installed" message
    // (see slash-commands.ts).
    //
    // `nativeNames.discord = "plan"` keeps the command discoverable
    // inside Discord's native slash menu without colliding with
    // anything else (mirrors the talk-voice plugin's convention).
    api.registerCommand({
      name: "plan",
      nativeNames: { default: "plan" },
      description:
        "Plan-mode controls: accept/revise plans, toggle mode, restate the active plan, or answer pending questions.",
      acceptsArgs: true,
      handler: createPlanCommandHandler(),
    });
  },
});
