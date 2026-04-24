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
import { assertOpenclawVersionSupported } from "./api.js";
import { buildArchetypePromptResult } from "./src/archetype-hook.js";
import { isPlanModeDebugEnabled, logPlanModeDebug, setPlanModeDebugEnabled } from "./src/debug-log.js";
import { buildInjectionDrainResult } from "./src/injection-drain-hook.js";
import {
  handleAgentEnd,
  handleGatewayStart,
  handleSessionStart,
  handleSubagentEnded,
  handleSubagentSpawning,
} from "./src/lifecycle-hooks.js";
import { shouldBlockMutation } from "./src/mutation-gate.js";
import { bustPlanModeCache, getPlanModeCache, setPlanModeCache } from "./src/plan-mode-cache.js";
import { buildSlashCommandDeps } from "./src/slash-command-deps.js";
import { createPlanCommandHandler } from "./src/slash-commands.js";
import { handleToolResultPersist } from "./src/tool-result-persist-hook.js";
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
  /**
   * Restrict the plugin's hooks/tools/commands to specific agent ids.
   * Empty array (default) applies to all agents.
   */
  agents?: string[];
  archetype?: { enabled?: boolean; minStepCount?: number };
  mutationGate?: {
    /**
     * Master switch for the before_tool_call hook. Default true. Set
     * false to skip mutation-gate registration entirely (rare — only
     * for users running plan-mode-as-soft-steer-only setups where the
     * archetype prompt is enough).
     */
    enabled?: boolean;
    /**
     * Additional tool names to treat as mutating (extends the built-in
     * blocklist; doesn't replace it). Use for plugin tools or MCP tools
     * the built-in gate doesn't recognize.
     */
    blockedTools?: string[];
    gateFailureMode?: "open" | "closed";
  };
  retry?: {
    /**
     * Master switch for the agent_end ack-only retry hook. Default true.
     */
    enabled?: boolean;
    /**
     * Maximum [PLANNING_RETRY] injections per cycle before giving up. (v1.0
     * note: not yet enforced — the per-id dedup in the queue gives an
     * effective limit of 1 today; multi-injection limit is v1.1 work.)
     */
    limit?: number;
  };
  autoApprove?: {
    /**
     * Initial autoApprove value when a fresh session enters plan mode.
     * Per-session toggle via /plan auto on|off.
     */
    default?: boolean;
  };
  snapshot?: {
    /**
     * Persist lastPlanSteps to session metadata so /plan restate works
     * across reconnects. Default true. (v1.0 note: always-on today —
     * the toggle is a v1.1 ergonomic; setting false has no effect yet.)
     */
    persist?: boolean;
    /**
     * Renderer cap. (v1.0 note: handled at render-call sites with
     * hardcoded 100 today; honoring this knob is v1.1 work.)
     */
    maxStepsRendered?: number;
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

    // Verify the host's openclaw version matches the version this
    // Smarter-Claw release is pinned against (#13). The check is
    // best-effort: if we can't read the host package.json, we log + skip
    // rather than block plugin load, since the installer's SHA-pinning
    // is the real safety belt — the runtime check is a louder warning
    // for the case where someone updates openclaw without re-running the
    // installer.
    try {
      const hostPkgUrl = new URL("../openclaw/package.json", import.meta.url);
      // dynamic import keeps this from blocking module load on hosts
      // where the file is missing (e.g. plugin loaded standalone in tests)
      void import(hostPkgUrl.toString(), { with: { type: "json" } })
        .then((mod) => {
          const v = (mod?.default ?? mod)?.version as string | undefined;
          assertOpenclawVersionSupported(v, { mode: "warn" });
        })
        .catch(() => {
          // ignore — best-effort version check
        });
    } catch {
      // ignore — URL construction failed (no import.meta in CJS, etc)
    }

    // Phase 2.1: register the four plan-mode agent tools. Each tool is
    // a fresh instance per-call so options like runId/sessionKey can be
    // wired by the host runner via the tool factory pattern. Today the
    // factories take no per-call options through registerTool, so the
    // tools fall back to their no-arg defaults; per-session wiring lives
    // in the hook clusters that come next.
    // Per-call factory pattern: every tool dispatch gets a fresh
    // instance bound to the active OpenClawPluginToolContext (agentId,
    // sessionKey, sessionId). Without this the tools see no session
    // context and persist-from-tool short-circuits with
    // "missing storePath/sessionKey" — see #33.
    api.registerTool((toolCtx) =>
      createEnterPlanModeTool({ agentId: toolCtx.agentId, sessionKey: toolCtx.sessionKey }),
    );
    api.registerTool((toolCtx) =>
      createExitPlanModeTool({ agentId: toolCtx.agentId, sessionKey: toolCtx.sessionKey }),
    );
    api.registerTool((toolCtx) =>
      createAskUserQuestionTool({ agentId: toolCtx.agentId, sessionKey: toolCtx.sessionKey }),
    );
    api.registerTool((toolCtx) =>
      createPlanModeStatusTool({
        agentId: toolCtx.agentId,
        sessionKey: toolCtx.sessionKey,
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
    api.on("before_prompt_build", async (_event, ctx) => {
      // Two side-by-side concerns share before_prompt_build:
      //   1. Archetype prompt (constant per-turn when in plan mode)
      //   2. Injection-queue drain (per-turn variable; fires from /plan
      //      accept|revise|answer to deliver [PLAN_DECISION]:... and
      //      [QUESTION_ANSWER]:... synthetic messages on the next turn)
      // Both append to system context; we concatenate when both fire so
      // a single appendSystemContext payload reaches the model.
      const [archetype, drain] = await Promise.all([
        Promise.resolve(
          buildArchetypePromptResult(
            { enabled: archetypeEnabled },
            { agentId: ctx.agentId, sessionKey: ctx.sessionKey },
          ),
        ),
        buildInjectionDrainResult({ agentId: ctx.agentId, sessionKey: ctx.sessionKey }),
      ]);
      const parts: string[] = [];
      if (drain?.appendSystemContext) parts.push(drain.appendSystemContext);
      if (archetype?.appendSystemContext) parts.push(archetype.appendSystemContext);
      if (parts.length === 0) return undefined;
      return { appendSystemContext: parts.join("\n\n") };
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

    // mutationGate.enabled — operator can disable the hard gate (e.g.
    // soft-steer-only setups where the archetype prompt is enough).
    if (config.mutationGate?.enabled === false) {
      logPlanModeDebug({
        kind: "tool_call",
        sessionKey: "<startup>",
        tool: "register:mutation-gate-disabled-via-config",
      });
    } else {
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
            storePath = resolveStorePath(undefined, { agentId });
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

          // Per-session in-process cache (#10). Tool calls fire many times
          // per turn; without caching every call ate the full cost of a
          // skipCache:true loadSessionStore + JSON.parse. The cache window
          // is 5s by default — long enough to skip per-turn lookups, short
          // enough to catch external state flips between turns. Bust on
          // session_start (handled in session_start hook) and on tool body
          // writes that change planMode (handled in tool-result-persist).
          let entry: ReturnType<typeof resolveSessionStoreEntry>["existing"];
          const cached = getPlanModeCache(sessionKey);
          if (cached) {
            entry = cached.entry as typeof entry;
          } else {
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
            setPlanModeCache(sessionKey, entry as Record<string, unknown> | undefined);
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
    }

    // Phase A3+A4: tool_result_persist hook handles two side-effects
    // that the tool body itself can't do (because the tool body returns
    // BEFORE the result is durable):
    //   - update_plan: mirror new step list into lastPlanSteps so /plan
    //     restate + UI sidebar stay live when only update_plan was called
    //   - exit_plan_mode: write plan-YYYY-MM-DD-<slug>.md to disk under
    //     ~/.openclaw/agents/<id>/plans/ for operator audit trail
    api.on("tool_result_persist", (event, ctx) => {
      // Returns void per the SDK contract — the hook is fire-and-forget
      // for our purposes (we never replace the persisted message).
      // Caught + logged inside the handler so any failure here doesn't
      // bubble to the host.
      void handleToolResultPersist(event as unknown as Parameters<typeof handleToolResultPersist>[0], {
        agentId: (ctx as { agentId?: string }).agentId,
        sessionKey: (ctx as { sessionKey?: string }).sessionKey,
      });
      // Bust the plan-mode cache on tool-result-persist (#10): if the
      // tool body wrote new state (enter_plan_mode / exit_plan_mode /
      // update_plan), we want the NEXT before_tool_call to see fresh
      // disk state, not the cached pre-write entry.
      const sessionKey = (ctx as { sessionKey?: string }).sessionKey;
      if (sessionKey) {
        const toolName = (event as { toolName?: string }).toolName;
        if (
          toolName === "enter_plan_mode" ||
          toolName === "exit_plan_mode" ||
          toolName === "update_plan"
        ) {
          bustPlanModeCache(sessionKey);
        }
      }
    });

    // Belt-and-suspenders fallback: tool_result_persist doesn't fire for
    // every plugin-registered tool path in Pi (only when the
    // session-tool-result-guard wrapper is installed AROUND the active
    // session manager). before_message_write IS fired for every message
    // write into the transcript, so we get a second chance there. The
    // handler short-circuits unless the message is a tool result for
    // update_plan / exit_plan_mode and isn't a no-op.
    // Phase A5: gateway_start cron registration. The handler probes
    // ctx.getCron() — when the host doesn't expose it we log + skip.
    api.on("gateway_start", (_event, ctx) => {
      void handleGatewayStart({
        getCron: (ctx as { getCron?: () => unknown }).getCron as Parameters<typeof handleGatewayStart>[0]["getCron"],
      });
    });

    // Phase A6: session_start fires the one-shot [PLAN_MODE_INTRO]
    // injection when first entering plan mode for a session.
    api.on("session_start", (_event, ctx) => {
      // Bust the per-session plan-mode cache (#10) on session_start so
      // the first before_tool_call after a session restart picks up the
      // fresh on-disk state instead of stale cache from a prior run.
      if (ctx.sessionKey) {
        bustPlanModeCache(ctx.sessionKey);
      }
      void handleSessionStart({ agentId: ctx.agentId, sessionKey: ctx.sessionKey });
    });

    // Phase #34: subagent gate — track openSubagentRunIds in session
    // state via subagent_spawning + subagent_ended hooks. exit_plan_mode
    // tool body checks the count and refuses to submit while subagents
    // are in flight (research investigations must complete first).
    api.on("subagent_spawning", (event, ctx) => {
      void handleSubagentSpawning(event as Parameters<typeof handleSubagentSpawning>[0], {
        agentId: (ctx as { agentId?: string }).agentId,
        sessionKey: (ctx as { sessionKey?: string }).sessionKey,
      });
    });
    api.on("subagent_ended", (event, ctx) => {
      void handleSubagentEnded(event as Parameters<typeof handleSubagentEnded>[0], {
        agentId: (ctx as { agentId?: string }).agentId,
        sessionKey: (ctx as { sessionKey?: string }).sessionKey,
      });
    });

    // Phase #37: ack-only retry. Detects when an agent ends a turn in
    // plan mode without calling exit_plan_mode and queues a
    // [PLANNING_RETRY] injection for the next turn. Skip when the
    // operator explicitly disables retry via plugin config.
    if (config.retry?.enabled !== false) {
      api.on("agent_end", (event, ctx) => {
        // agents filter: when configured, skip handlers for non-listed
        // agent ids. Empty/missing array means apply to all.
        if (
          Array.isArray(config.agents) &&
          config.agents.length > 0 &&
          ctx.agentId &&
          !config.agents.includes(ctx.agentId)
        ) {
          return;
        }
        void handleAgentEnd(event as Parameters<typeof handleAgentEnd>[0], {
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        });
      });
    }

    api.on("before_message_write", (event, ctx) => {
      const msg = event.message as { toolName?: string; type?: string };
      const toolName = msg?.toolName;
      if (toolName !== "update_plan" && toolName !== "exit_plan_mode") {
        return undefined;
      }
      void handleToolResultPersist(
        {
          toolName,
          message: event.message as Parameters<typeof handleToolResultPersist>[0]["message"],
          isSynthetic: false,
        },
        {
          agentId: (ctx as { agentId?: string }).agentId,
          sessionKey: (ctx as { sessionKey?: string }).sessionKey,
        },
      );
      return undefined;
    });
  },
});
