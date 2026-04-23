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

import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildArchetypePromptResult } from "./src/archetype-hook.js";
import { isPlanModeDebugEnabled, logPlanModeDebug, setPlanModeDebugEnabled } from "./src/debug-log.js";
import { shouldBlockMutation } from "./src/mutation-gate.js";
import { buildSlashCommandDeps } from "./src/slash-command-deps.js";
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
  mutationGate?: {
    enabled?: boolean;
    blockedTools?: string[];
    /**
     * What to do when the mutation gate cannot determine session state
     * (session store IO failure, parse error, missing storePath, etc.).
     *
     *   "closed" (default): block the tool call and surface a clear
     *     reason. Right answer for a security gate — when in doubt,
     *     refuse. Recommended for any plan-mode workflow where the
     *     gate is the user's only fence against unintended mutations.
     *
     *   "open": let the tool call through. Use only for non-security-
     *     critical setups where transient session-store hiccups would
     *     produce annoying false-blocks and the user accepts the risk.
     */
    gateFailureMode?: "open" | "closed";
  };
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
      handler: createPlanCommandHandler(buildSlashCommandDeps()),
    });

    // Phase 2.4: wire the mutation gate via the public `before_tool_call`
    // hook. The hook is part of the v2026.4.22 PluginHookHandlerMap (see
    // openclaw-2/src/plugins/hook-types.ts) and fires from
    // pi-tool-definition-adapter.ts before each tool's `execute` callback,
    // so we can short-circuit by returning `{ block: true, blockReason }`.
    //
    // No installer patch needed for activation — `before_tool_call` is
    // already exposed by the host. Session state is read via the same
    // pattern as the archetype hook (loadSessionStore → resolve entry →
    // shouldBlockMutation reads via runtime-api.isInPlanMode).
    // Default-closed: when state can't be determined, refuse the call.
    // Users can opt out for non-security-critical setups via plugin
    // config: `mutationGate.gateFailureMode = "open"`.
    const gateFailureMode: "open" | "closed" =
      config.mutationGate?.gateFailureMode === "open" ? "open" : "closed";

    /**
     * Build the fail-closed result for the in-flight tool call.
     *
     * Returns the right `block: true` shape (or undefined when the
     * operator opted into fail-open). Logs every fail-closed event so
     * operators can tune the failure rate from gateway logs.
     */
    function gateFailureResult(
      sessionKey: string | undefined,
      toolName: string,
      cause: string,
    ): { block: true; blockReason: string } | undefined {
      logPlanModeDebug({
        kind: "tool_call",
        sessionKey: sessionKey ?? "",
        tool: `before_tool_call:gate_failure:${cause}:${toolName}`,
      });
      if (gateFailureMode === "open") {
        return undefined;
      }
      return {
        block: true,
        blockReason:
          `Smarter-Claw plan-mode gate could not verify session state for tool "${toolName}" (${cause}); failing closed. ` +
          "Restart the gateway, run smarter-claw verify, or set " +
          "mutationGate.gateFailureMode=\"open\" in plugin config to opt out.",
      };
    }

    api.on("before_tool_call", async (event, ctx) => {
      // Wrap the entire body in try/catch — a bug anywhere downstream
      // (e.g. unexpected throw from shouldBlockMutation) MUST honor the
      // fail-closed policy rather than bubble out and let the host
      // default-allow.
      try {
        const sessionKey = ctx.sessionKey;
        const agentId = ctx.agentId;
        if (!sessionKey || !agentId) {
          return gateFailureResult(sessionKey, event.toolName, "missing-session-context");
        }

        let storePath: string | undefined;
        try {
          storePath = resolveStorePath(agentId);
        } catch (err) {
          return gateFailureResult(
            sessionKey,
            event.toolName,
            `resolveStorePath-threw:${(err as Error)?.message ?? String(err)}`,
          );
        }
        if (!storePath) {
          return gateFailureResult(sessionKey, event.toolName, "missing-store-path");
        }

        let entry: ReturnType<typeof resolveSessionStoreEntry>["existing"];
        try {
          const store = loadSessionStore(storePath, { skipCache: true });
          entry = resolveSessionStoreEntry({ store: store ?? {}, sessionKey }).existing;
        } catch (err) {
          return gateFailureResult(
            sessionKey,
            event.toolName,
            `session-store-read-failed:${(err as Error)?.message ?? String(err)}`,
          );
        }

        // Pull command for exec/bash so the read-only allowlist applies.
        // Widened to cover every common shell-command param name an MCP
        // plugin might use (script/code/bash_command/shell_command/cmdline/
        // input/run/args). The mutation-gate inspects whichever is set.
        const params = (event.params ?? {}) as Record<string, unknown>;
        const COMMAND_PARAM_KEYS = [
          "command",
          "cmd",
          "script",
          "code",
          "bash_command",
          "shell_command",
          "cmdline",
          "input",
          "run",
          "execute",
        ] as const;
        let execCommand: string | undefined;
        for (const key of COMMAND_PARAM_KEYS) {
          const v = params[key];
          if (typeof v === "string" && v.length > 0) {
            execCommand = v;
            break;
          }
        }
        // Also consider an `args` param: an array of arg tokens (string or
        // numeric) joined by spaces is a common alternative shape. Only
        // used when no string-typed command param matched above.
        if (execCommand === undefined && Array.isArray(params.args)) {
          const joined = params.args
            .map((x) => (typeof x === "string" || typeof x === "number" ? String(x) : ""))
            .join(" ")
            .trim();
          if (joined.length > 0) execCommand = joined;
        }

        let result: ReturnType<typeof shouldBlockMutation>;
        try {
          result = shouldBlockMutation({
            toolName: event.toolName,
            session: entry,
            execCommand,
          });
        } catch (err) {
          return gateFailureResult(
            sessionKey,
            event.toolName,
            `shouldBlockMutation-threw:${(err as Error)?.message ?? String(err)}`,
          );
        }

        if (result.blocked) {
          logPlanModeDebug({
            kind: "tool_call",
            sessionKey,
            tool: `before_tool_call:blocked:${event.toolName}`,
          });
          return {
            block: true,
            blockReason: result.reason ?? "Blocked by Smarter-Claw plan-mode mutation gate.",
          };
        }
        return undefined;
      } catch (err) {
        return gateFailureResult(
          ctx.sessionKey,
          event.toolName,
          `unhandled-throw:${(err as Error)?.message ?? String(err)}`,
        );
      }
    });
  },
});
