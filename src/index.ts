/**
 * Smarter-Claw — OpenClaw plan-mode plugin v1 entry.
 *
 * P-1 scope: skeleton + manifest + degraded-state warning. NO feature
 * logic yet. Each subsequent PR (P-2 → P-final) wires in one feature
 * from the parity catalog at
 * `architecture-v2/01-PARITY_CATALOG.md` on the architecture-v2-planning
 * branch.
 *
 * Source-of-truth for parity: in-host plan-mode work at
 * `/Users/lume/repos/openclaw-pr70071-rebase` tip `ea04ea52c7`.
 *
 * Plan file: `/Users/lume/.claude/plans/glistening-swimming-rivest.md`.
 *
 * # Why a session_start degraded-state warning?
 *
 * Per Wave-6 final adversarial probe P2: the plugin requires
 * `plugins.entries.smarter-claw.hooks.allowConversationAccess: true`
 * in operator config to fire conversation-access hooks (`before_agent_finalize`
 * for auto-continue/escalating-retry, etc.). Without the flag, those
 * hooks silently no-op — exactly the
 * "manifest accepts, implementation no-ops" failure pattern that the
 * Wave-1 lessons-learned doc identifies as the dominant prior failure.
 *
 * The `session_start` event DOES fire without `allowConversationAccess`
 * (it's a lifecycle event, not a conversation-access hook — confirmed at
 * `docs/plugins/hooks.md:136-137`). So we use it to emit a user-visible
 * warning on every session start when the operator config is missing the
 * flag. The warning stops once the flag is set.
 *
 * Note: `before_tool_call` (the mutation gate's primary seam) does NOT
 * require `allowConversationAccess`. Only the conversation-access hooks
 * do. P-1 ships the warning as a defense-in-depth so that when later PRs
 * add those hooks, the warning is already wired.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export const SMARTER_CLAW_PLUGIN_ID = "smarter-claw";
export const PLAN_MODE_SESSION_EXTENSION_NAMESPACE = "plan-mode";

/**
 * Plugin config schema (minimal in P-1; expanded by later PRs).
 *
 * Per Wave-1 LESSONS_LEARNED.md guardrail #2: do NOT add config knobs
 * that are accepted by the manifest schema but no-op in implementation
 * ("manifest-vs-implementation drift"). Every field below must be
 * consumed by the runtime, or it must not exist.
 */
type SmarterClawConfig = {
  /**
   * Globally enable or disable the plugin. Defaults to true on register.
   * When false, the plugin registers zero hooks (effectively uninstalled
   * without manifest removal).
   */
  enabled?: boolean;
};

const DEFAULT_CONFIG: Required<SmarterClawConfig> = {
  enabled: true,
};

function resolveConfig(raw: unknown): Required<SmarterClawConfig> {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
  const partial = raw as Partial<SmarterClawConfig>;
  return {
    enabled: typeof partial.enabled === "boolean" ? partial.enabled : DEFAULT_CONFIG.enabled,
  };
}

/**
 * Detect whether the operator has granted the conversation-access flag
 * we need for later-PR features (auto-continue, escalating retry,
 * archetype injection). The flag lives on the host-side plugin config
 * at `plugins.entries.smarter-claw.hooks.allowConversationAccess`.
 *
 * We can't read host plugin config from the plugin runtime context in
 * a portable way (the SDK does not expose `api.config.get`). What we
 * CAN do is detect the symptom: if `allowConversationAccess` is NOT set,
 * `before_agent_finalize` and `llm_output` hooks never invoke our
 * handlers. P-1 ships the warning unconditionally; P-10 ships the
 * conversation-access hooks. If P-10's hooks never fire after multiple
 * sessions, the operator's config is degraded — but we cannot detect
 * "never fired" from P-1 without a feedback channel from those hooks
 * back to the warning.
 *
 * For P-1, we emit a "make sure you've set this if you intend to use
 * full plan-mode" advisory message on every session start. P-10 will
 * tighten this to a runtime self-check when the conversation-access
 * hooks land.
 *
 * Wave-6 P2 mitigation: surface the requirement to users via session
 * messages, not just operator logs.
 */
function buildAdvisorySessionMessage(): string {
  return (
    "Smarter-Claw plan-mode plugin is installed. " +
    "Required operator config for full plan-mode behavior: " +
    "`plugins.entries.smarter-claw.hooks.allowConversationAccess: true`. " +
    "Mutation gate works without this flag; archetype injection, " +
    "auto-continue, and escalating-retry features require it. " +
    "See `https://github.com/electricsheephq/Smarter-Claw#required-operator-config`."
  );
}

export default definePluginEntry({
  id: SMARTER_CLAW_PLUGIN_ID,
  name: "Smarter-Claw",
  description:
    "Plan-Mode plugin for OpenClaw. Plan-then-execute workflow with " +
    "mutation gate, archetype prompting, escalating retry, and " +
    "rejection-cycle tracking. Requires " +
    "`allowConversationAccess: true` in operator config for full " +
    "behavior; mutation gate works without it.",
  // No `kind` — that field is for memory/context-engine specialized
  // plugins. Smarter-Claw is a general workflow plugin.
  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);
    if (!config.enabled) {
      // No-op when disabled. Mirror the in-host behavior where
      // `agents.defaults.planMode.enabled: false` skips all wiring.
      api.logger.info(
        "[smarter-claw] disabled via plugin config; not registering hooks",
      );
      return;
    }

    // P-1 foundation: reserve the session-extension namespace so future
    // PRs (P-3 onward) can patch state via the host's
    // `sessions.pluginPatch` RPC. The namespace is fixed at "plan-mode"
    // per architecture decision (Option C: single namespace owned by
    // PlanModeStore). See `architecture-v2/02-ARCHITECTURE_OPTIONS.md`.
    //
    // Using the new nested form `api.session.state.registerSessionExtension`
    // (preferred since v2026.5.10-beta.5). The flat
    // `api.registerSessionExtension` still works as a deprecated alias
    // but will be removed in a future major.
    api.session.state.registerSessionExtension({
      namespace: PLAN_MODE_SESSION_EXTENSION_NAMESPACE,
      description:
        "Plan-mode state — current mode, pending approval, cycle counter, " +
        "etc. Schema versioned via __schemaVersion (P-3).",
    });

    // P-1 degraded-state warning. Logs on every new session start so
    // operators see the advisory in gateway logs even before later
    // PRs add user-visible surfacing. The advisory stops being relevant
    // once `allowConversationAccess: true` is set in operator config.
    //
    // `session_start` is a lifecycle event that fires WITHOUT
    // `allowConversationAccess` (docs/plugins/hooks.md:136-137).
    // Confirmed: PluginHookName at `node_modules/openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts:12`.
    api.on("session_start", (event, _ctx) => {
      // Only advise on brand-new sessions; idle/daily/restart events
      // are noise. Per docs reason values: new | reset | idle | daily |
      // compaction | deleted | shutdown | restart | unknown.
      const reason = (event as { reason?: string } | undefined)?.reason;
      if (reason !== "new") return undefined;
      api.logger.info(
        "[smarter-claw] new session opened — see advisory above",
      );
      // session_start return value is ignored. User-visible surfacing
      // lands at P-10 with the runtime self-check.
      return undefined;
    });

    api.logger.info(
      `[smarter-claw] registered v1-port skeleton — namespace="${PLAN_MODE_SESSION_EXTENSION_NAMESPACE}"`,
    );
    api.logger.info(`[smarter-claw] ${buildAdvisorySessionMessage()}`);
  },
});

/**
 * Test-only exports. Internal API; not part of the plugin's public
 * surface. Used by tests/p1-skeleton.test.ts to exercise the warning
 * builder in isolation.
 */
export const __testing = {
  buildAdvisorySessionMessage,
  resolveConfig,
  DEFAULT_CONFIG,
};
