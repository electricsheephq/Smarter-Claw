/**
 * before_prompt_build hook handler — appends the plan-archetype prompt
 * to the system context whenever the active session is in plan mode.
 *
 * Why `appendSystemContext` and not `prependContext` or `systemPrompt`:
 * `appendSystemContext` is the cacheable surface — the host bundles it
 * into the system-prompt prompt-cache prefix so we don't pay the
 * per-turn token cost of the ~3KB archetype prompt every reply.
 *
 * Reading session state via `openclaw/plugin-sdk/session-store-runtime`
 * + `readSmarterClawState` helper (the plugin-namespaced SessionEntry
 * slice). When session state isn't readable (early bootstrap, missing
 * sessionKey, store IO failure) we silently no-op — never block the
 * prompt build.
 */

import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readSmarterClawState } from "../runtime-api.js";
import { PLAN_ARCHETYPE_PROMPT } from "./archetype-prompt.js";
import { logPlanModeDebug } from "./debug-log.js";
import { getPlanModeCache, setPlanModeCache } from "./plan-mode-cache.js";

export type ArchetypeHookConfig = {
  /** Plugin config: archetype.enabled (defaults to true). */
  enabled: boolean;
};

export type ArchetypeHookContext = {
  agentId?: string;
  sessionKey?: string;
};

/**
 * Build the before_prompt_build hook payload for an in-flight turn.
 *
 * Returns `{ appendSystemContext: PLAN_ARCHETYPE_PROMPT }` when the
 * session is currently in plan mode, otherwise undefined (no mutation).
 */
export function buildArchetypePromptResult(
  config: ArchetypeHookConfig,
  ctx: ArchetypeHookContext,
): { appendSystemContext: string } | undefined {
  if (!config.enabled) {
    return undefined;
  }
  const sessionKey = ctx.sessionKey;
  if (!sessionKey) {
    return undefined;
  }
  let storePath: string | undefined;
  if (ctx.agentId) {
    try {
      storePath = resolveStorePath(undefined, { agentId: ctx.agentId });
    } catch {
      return undefined;
    }
  }
  if (!storePath) {
    return undefined;
  }
  // Per-session cache (#10): before_prompt_build fires every turn but
  // session state changes are rare. Reuse the same cache the
  // before_tool_call hook uses so once-per-turn the disk read happens
  // and subsequent turns within the cache window skip it. Cache is
  // busted on session_start + planMode-changing tool results, so a
  // genuine state flip is reflected on the very next prompt build.
  let entry: ReturnType<typeof resolveSessionStoreEntry>["existing"];
  const cached = getPlanModeCache(sessionKey);
  if (cached) {
    entry = cached.entry as typeof entry;
  } else {
    try {
      const store = loadSessionStore(storePath, { skipCache: true });
      entry = resolveSessionStoreEntry({ store: store ?? {}, sessionKey }).existing;
    } catch {
      return undefined;
    }
    setPlanModeCache(sessionKey, entry as Record<string, unknown> | undefined);
  }
  const planState = entry ? readSmarterClawState(entry) : undefined;
  if (planState?.planMode !== "plan") {
    return undefined;
  }
  logPlanModeDebug({
    kind: "tool_call",
    sessionKey,
    tool: "before_prompt_build:archetype-injected",
  });
  return { appendSystemContext: PLAN_ARCHETYPE_PROMPT };
}
