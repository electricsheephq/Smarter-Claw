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

/**
 * Persist a Smarter-Claw state slice into the session store.
 *
 * Uses the host's `updateSessionStoreEntry` exposed by the installer's
 * `session-store-runtime-write-api.diff` patch (which adds the export to
 * `openclaw/plugin-sdk/session-store-runtime`). When the installer hasn't
 * been run, the symbol won't exist and the helper returns
 * `{ persisted: false, reason: "..." }` instead of throwing — slash
 * commands surface this as a friendly "run smarter-claw install" message.
 *
 * Dynamic-imported on every call to keep the failure mode silent on
 * vanilla hosts (loadSessionStoreModule resolves at first use).
 *
 * @param opts.agentId        Required — used to resolve the store path.
 * @param opts.sessionKey     Required — identifies the session entry.
 * @param opts.update         Pure function: takes current state (may be
 *                            undefined for first write), returns next state.
 *                            Return undefined to leave state unchanged.
 *
 * @returns `{ persisted: true, next }` on success, or
 *   `{ persisted: false, reason }` when the install is missing the
 *   write-API patch, the entry can't be loaded, or the update returns
 *   undefined.
 */
export type PersistSmarterClawStateResult =
  | { persisted: true; next: SmarterClawSessionState }
  | { persisted: false; reason: string };

export async function persistSmarterClawState(opts: {
  agentId: string;
  sessionKey: string;
  update: (
    current: SmarterClawSessionState | undefined,
  ) => SmarterClawSessionState | undefined;
}): Promise<PersistSmarterClawStateResult> {
  let storeRuntime: typeof import("openclaw/plugin-sdk/session-store-runtime");
  try {
    storeRuntime = await import("openclaw/plugin-sdk/session-store-runtime");
  } catch (err) {
    return {
      persisted: false,
      reason: `openclaw/plugin-sdk/session-store-runtime is not loadable: ${(err as Error)?.message ?? err}`,
    };
  }
  const updateSessionStoreEntry = (
    storeRuntime as unknown as {
      updateSessionStoreEntry?: (params: {
        storePath: string;
        sessionKey: string;
        update: (entry: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      }) => Promise<Record<string, unknown> | null>;
    }
  ).updateSessionStoreEntry;
  if (typeof updateSessionStoreEntry !== "function") {
    return {
      persisted: false,
      reason:
        "openclaw/plugin-sdk/session-store-runtime is missing updateSessionStoreEntry — Smarter-Claw installer has not been run against this OpenClaw install. Run `smarter-claw install` to enable plan-mode mutations.",
    };
  }
  let storePath: string;
  try {
    storePath = storeRuntime.resolveStorePath(undefined, { agentId: opts.agentId });
  } catch (err) {
    return { persisted: false, reason: `resolveStorePath failed: ${(err as Error)?.message ?? err}` };
  }

  let nextState: SmarterClawSessionState | undefined;
  const result = await updateSessionStoreEntry({
    storePath,
    sessionKey: opts.sessionKey,
    update: async (entry) => {
      const current = readSmarterClawState(entry);
      const next = opts.update(current);
      if (!next) return null;
      nextState = next;
      const merged = writeSmarterClawState(entry, next);
      // UI compatibility shim (#30): the PR #70071 UI patches read
      // top-level SessionEntry.planMode / planApproval /
      // pendingQuestionApprovalId for backward-compat with the
      // in-core implementation. Mirror our plugin-namespaced state
      // to those fields so the chip / sidebar / approval card light
      // up without requiring a UI rewrite. Long-term, the UI patches
      // should migrate to `pluginMetadata['smarter-claw']` directly.
      const mirror = buildUiCompatMirror(next);
      return {
        pluginMetadata: (merged as { pluginMetadata?: unknown }).pluginMetadata,
        ...mirror,
      };
    },
  });
  if (!result || !nextState) {
    return { persisted: false, reason: "session entry not found or no state change requested" };
  }
  return { persisted: true, next: nextState };
}

/**
 * Build the top-level SessionEntry mirror fields used by the PR #70071
 * UI patches. These are shadow writes — the plugin-owned source of truth
 * remains `pluginMetadata['smarter-claw']` — but the UI hydration code
 * still expects them at the top level. Document the shim here so the
 * coupling is visible from one place and easy to remove when the UI
 * migrates to read the namespaced field directly (post-v1.0).
 *
 * Mirror surface:
 *   - planMode: { mode, approval, approvalId } — chip + sidebar shape
 *   - pendingQuestionApprovalId: ask_user_question routing key
 *   - planApproval (top-level enum) — the slash-command-executor UI patch
 *     reads this directly instead of nested
 */
function buildUiCompatMirror(state: SmarterClawSessionState): Record<string, unknown> {
  const approvalId =
    state.pendingInteraction?.kind === "approval"
      ? state.pendingInteraction.approvalId
      : state.pendingQuestionApprovalId;
  return {
    planMode: {
      mode: state.planMode,
      approval: state.planApproval,
      ...(approvalId ? { approvalId } : {}),
      ...(state.lastPlanSteps?.title ? { title: state.lastPlanSteps.title } : {}),
      ...(state.recentlyApprovedAt ? { recentlyApprovedAt: state.recentlyApprovedAt } : {}),
    },
    ...(state.pendingQuestionApprovalId
      ? { pendingQuestionApprovalId: state.pendingQuestionApprovalId }
      : {}),
  };
}
