/**
 * Smarter Claw — runtime helpers other extensions can opt into.
 *
 * These helpers wrap reads/writes against the plugin-namespaced session
 * metadata so callers don't have to know the magic key
 * (`SessionEntry.pluginMetadata['smarter-claw']`).
 *
 * Currently a thin stub — Phase 2 ports populate the real implementations.
 */

import { SMARTER_CLAW_PLUGIN_ID } from "./src/types.js";
import type { SmarterClawSessionState } from "./src/types.js";

/**
 * Loose host shape — any object that MIGHT have a plugin-namespaced
 * metadata bag. We deliberately do NOT constrain on the host's
 * `pluginMetadata` field type because the host-side SessionEntry may or
 * may not declare it (the field is added in OpenClaw v2026.4.22+ via
 * the patch in `src/config/sessions/types.ts`). Accepting `unknown`
 * lets the plugin keep working against older OpenClaw publishes too —
 * `readSmarterClawState` just returns `undefined` when the field is
 * missing at runtime.
 */
type MaybePluginMetadataHost = Record<string, unknown> & {
  pluginMetadata?: unknown;
};

function readPluginMetadataBag(session: unknown): Record<string, unknown> | undefined {
  if (!session || typeof session !== "object") {
    return undefined;
  }
  const bag = (session as MaybePluginMetadataHost).pluginMetadata;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) {
    return undefined;
  }
  return bag as Record<string, unknown>;
}

/**
 * Read the Smarter Claw state slice off a SessionEntry-shaped object.
 * Returns `undefined` if the plugin has never written to this session yet,
 * or if the host's SessionEntry doesn't have the pluginMetadata field
 * (older OpenClaw versions).
 */
export function readSmarterClawState(session: unknown): SmarterClawSessionState | undefined {
  const bag = readPluginMetadataBag(session);
  if (!bag) {
    return undefined;
  }
  const slot = bag[SMARTER_CLAW_PLUGIN_ID];
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
    return undefined;
  }
  // Cast is intentional: the plugin owns the shape under its namespace.
  return slot as unknown as SmarterClawSessionState;
}

/**
 * Produce a NEW session object with the Smarter Claw state slice replaced.
 * Pure: does not mutate the input. Caller is responsible for persisting
 * the returned object back to the session store.
 */
export function writeSmarterClawState<S extends Record<string, unknown>>(
  session: S,
  next: SmarterClawSessionState,
): S {
  const existing = readPluginMetadataBag(session) ?? {};
  return {
    ...session,
    pluginMetadata: {
      ...existing,
      [SMARTER_CLAW_PLUGIN_ID]: next as unknown as Record<string, unknown>,
    },
  } as S;
}

/**
 * Produce a NEW session object with the Smarter Claw state slice removed.
 * Useful for /plan reset and full session resets. Pure.
 */
export function clearSmarterClawState<S extends Record<string, unknown>>(session: S): S {
  const existing = readPluginMetadataBag(session);
  if (!existing || !existing[SMARTER_CLAW_PLUGIN_ID]) {
    return session;
  }
  const { [SMARTER_CLAW_PLUGIN_ID]: _removed, ...rest } = existing;
  return {
    ...session,
    pluginMetadata: rest,
  } as S;
}

/**
 * Convenience: returns true if the session is currently in plan mode.
 * Defaults to false when state is missing or planMode is `normal`.
 */
export function isInPlanMode(session: unknown): boolean {
  return readSmarterClawState(session)?.planMode === "plan";
}

/**
 * Convenience: returns true if auto-approve is enabled for the session.
 * Defaults to false when state is missing or autoApprove is unset.
 */
export function isAutoApproveEnabled(session: unknown): boolean {
  return readSmarterClawState(session)?.autoApprove === true;
}
