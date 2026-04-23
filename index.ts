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
import { isPlanModeDebugEnabled, setPlanModeDebugEnabled } from "./src/debug-log.js";
import { createAskUserQuestionTool } from "./src/tools/ask-user-question-tool.js";
import { createEnterPlanModeTool } from "./src/tools/enter-plan-mode-tool.js";
import { createExitPlanModeTool } from "./src/tools/exit-plan-mode-tool.js";
import { createPlanModeStatusTool } from "./src/tools/plan-mode-status-tool.js";
import { SMARTER_CLAW_PLUGIN_ID } from "./src/types.js";

// Phase 2.1 (2026-04-24): tools registered via api.registerTool.
// Future clusters land their own registrations here:
//   - Phase 2.2: api.registerHook("before_prompt_build", archetype prompt
//                                 + persist + bridge)
//   - Phase 2.3: api.registerHook("tool_result", mutation gate +
//                                 accept-edits gate)
//   - Phase 2.4: api.registerHook("agent_end", ack-only retry +
//                                 injections + auto-enable wiring)
//   - Phase 2.5: api.registerCommand("plan", slash command dispatcher)
//   - Phase 2.6: snapshot-persister wiring + plan-nudge cron registration

type SmarterClawConfig = {
  enabled?: boolean;
  debugLog?: boolean;
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
  },
});
