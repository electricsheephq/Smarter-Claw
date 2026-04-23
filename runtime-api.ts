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

type PluginMetadataHost = {
  pluginMetadata?: Record<string, Record<string, unknown>>;
};

/**
 * Read the Smarter Claw state slice off a SessionEntry-shaped object.
 * Returns `undefined` if the plugin has never written to this session yet.
 *
 * Defensive: validates that the namespaced slot is an object before
 * casting. Mismatched shape (corrupted state) returns `undefined` so the
 * caller treats it as "no state" rather than crashing.
 */
export function readSmarterClawState<S extends PluginMetadataHost>(
  session: S,
): SmarterClawSessionState | undefined {
  const slot = session.pluginMetadata?.[SMARTER_CLAW_PLUGIN_ID];
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
export function writeSmarterClawState<S extends PluginMetadataHost>(
  session: S,
  next: SmarterClawSessionState,
): S {
  const existing = session.pluginMetadata ?? {};
  return {
    ...session,
    pluginMetadata: {
      ...existing,
      [SMARTER_CLAW_PLUGIN_ID]: next as unknown as Record<string, unknown>,
    },
  };
}

/**
 * Produce a NEW session object with the Smarter Claw state slice removed.
 * Useful for /plan reset and full session resets. Pure.
 */
export function clearSmarterClawState<S extends PluginMetadataHost>(session: S): S {
  if (!session.pluginMetadata?.[SMARTER_CLAW_PLUGIN_ID]) {
    return session;
  }
  const { [SMARTER_CLAW_PLUGIN_ID]: _removed, ...rest } = session.pluginMetadata;
  return {
    ...session,
    pluginMetadata: rest,
  };
}

/**
 * Convenience: returns true if the session is currently in plan mode.
 * Defaults to false when state is missing or planMode is `normal`.
 */
export function isInPlanMode<S extends PluginMetadataHost>(session: S): boolean {
  return readSmarterClawState(session)?.planMode === "plan";
}

/**
 * Convenience: returns true if auto-approve is enabled for the session.
 * Defaults to false when state is missing or autoApprove is unset.
 */
export function isAutoApproveEnabled<S extends PluginMetadataHost>(session: S): boolean {
  return readSmarterClawState(session)?.autoApprove === true;
}
