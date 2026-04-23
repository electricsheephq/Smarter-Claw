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
import { SMARTER_CLAW_PLUGIN_ID } from "./src/types.js";

// NOTE (Phase 1A scaffold): registrations are intentionally empty stubs
// for now. Each Phase 2 cluster adds its registrations:
//   - Phase 2.1: api.registerTool(exit_plan_mode / enter_plan_mode /
//                                 ask_user_question / plan_mode_status)
//   - Phase 2.2: api.registerHook("before_prompt_build", archetype prompt
//                                 + persist + bridge)
//   - Phase 2.3: api.registerHook("tool_result", mutation gate +
//                                 accept-edits gate)
//   - Phase 2.4: api.registerHook("agent_end", ack-only retry +
//                                 injections + auto-enable wiring)
//   - Phase 2.5: api.registerCommand("plan", slash command dispatcher)
//   - Phase 2.6: snapshot-persister wiring + plan-nudge cron registration

export default definePluginEntry({
  id: SMARTER_CLAW_PLUGIN_ID,
  name: "Smarter Claw",
  description:
    "Plan Mode, Auto-Plan Mode, and every mode on Claude Code/Codex. Plan-then-execute workflow with archetype prompting, mutation gate, and ack-only retry. Universal across Pi and Codex harnesses.",
  register(api) {
    // Phase 1A: scaffold-only no-op registration. Confirms the plugin
    // loads, the manifest validates, and the entry resolves cleanly.
    // Real registrations land in Phase 2 clusters.
    void api;
  },
});
