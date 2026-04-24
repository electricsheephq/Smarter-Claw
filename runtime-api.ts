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
      // Concurrency contract (#9). The host's mergeSessionEntry does a
      // SHALLOW spread: { ...existing, ...patch }. So returning
      // `pluginMetadata: <full bag>` REPLACES the whole pluginMetadata
      // field on the persisted entry — it does NOT deep-merge per
      // namespace. The reason this is still safe for OTHER plugins'
      // slices is:
      //
      //   1. updateSessionStoreEntry is wrapped in withSessionStoreLock
      //      on the host side (see openclaw store.js: every entry update
      //      goes through `withSessionStoreLock(storePath, async () => {
      //      const store = loadSessionStore(storePath, { skipCache: true
      //      }); ... })`). The per-storePath lock serializes ALL writes.
      //
      //   2. Inside the lock the host re-reads the store with
      //      skipCache:true, so the `entry` we receive in this callback
      //      is the CANONICAL on-disk snapshot at the moment of the
      //      mutation — not a stale in-memory cache.
      //
      //   3. writeSmarterClawState reads `entry.pluginMetadata` and
      //      spreads it: { ...existing, [SMARTER_CLAW_PLUGIN_ID]: next }.
      //      So the bag we return preserves every other plugin's slice
      //      that was on disk at lock-acquisition time.
      //
      // Multi-process caveat: the lock is per-process (a file lock would
      // be needed for true cross-process safety). If another OpenClaw
      // instance — or a test harness — writes to the same store outside
      // this lock, the in-callback `entry` may not reflect that write,
      // and the patch we return would clobber it. v1.0 ships with a
      // single-process gateway assumption; multi-process safety is
      // upstream Plugin SDK work.
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
 * Mirror surface (audited 2026-04-24, parity port #9):
 *   - planMode: nested object the UI hydrates the chip + sidebar +
 *     plan-cards from. Reads from UI patches:
 *       * `planMode.mode` (app-render.ts.diff:77, app-tool-stream)
 *       * `planMode.approval` (app.ts.diff:718, slash-cmd-executor:110)
 *       * `planMode.approvalId` (slash-cmd-executor:110-111)
 *       * `planMode.title` (app.ts.diff:629, 668)
 *       * `planMode.lastPlanSteps` (app.ts.diff:660, 711) — sidebar
 *         re-hydrates from this on page reload
 *       * `planMode.autoApprove` (app-render.ts.diff:78, views-chat:432)
 *       * `planMode.blockingSubagentRunIds` (ui-types.ts.diff:37)
 *       * `planMode.lastSubagentSettledAt` (ui-types.ts.diff:38)
 *       * `planMode.lastPlanUpdatedAt` (ui-types.ts.diff:36)
 *   - pendingQuestionApprovalId (top-level): ask_user_question routing
 *     key read by slash-cmd-executor:150
 *   - pendingInteraction (top-level): chat slash-command-executor:144
 *     reads `row.pendingInteraction?.kind === "question"` for
 *     `/plan answer`. Two discriminated shapes ("plan" / "question").
 *
 * The `lastPlanSteps` translation: the plugin's PlanProposal stores
 * `{ index, description, done }` per step (the openclaw-1 internal
 * shape that ports directly from agents/plan-mode/types.ts). The UI
 * expects `{ step, status, activeForm? }` (the update_plan tool's
 * input shape). We translate at mirror time so the UI sees the shape
 * it was authored against without requiring a UI rewrite.
 */
function buildUiCompatMirror(state: SmarterClawSessionState): Record<string, unknown> {
  const approvalId =
    state.pendingInteraction?.kind === "approval"
      ? state.pendingInteraction.approvalId
      : state.pendingQuestionApprovalId;

  // Translate PlanProposal.steps → UI shape. Lossy on activeForm
  // because the internal PlanStep collapsed `step` and `activeForm`
  // into a single `description` field (per parsePlanStepsFromTool in
  // tool-result-persist-hook.ts). We mirror description → step; the
  // UI's "use activeForm when in_progress" branch falls through to
  // step text in that case, which is the right visual fallback.
  const lastPlanStepsForUi =
    state.lastPlanSteps?.steps && state.lastPlanSteps.steps.length > 0
      ? state.lastPlanSteps.steps.map((s) => ({
          step: s.description,
          status: s.done ? "completed" : "pending",
        }))
      : undefined;

  return {
    planMode: {
      mode: state.planMode,
      approval: state.planApproval,
      ...(approvalId ? { approvalId } : {}),
      ...(state.lastPlanSteps?.title ? { title: state.lastPlanSteps.title } : {}),
      ...(state.recentlyApprovedAt ? { recentlyApprovedAt: state.recentlyApprovedAt } : {}),
      // PR-9 audit additions: fields the UI patches read but were
      // missing from the mirror in v1.0.0.
      ...(state.autoApprove ? { autoApprove: state.autoApprove } : {}),
      ...(lastPlanStepsForUi ? { lastPlanSteps: lastPlanStepsForUi } : {}),
      ...(state.blockingSubagentRunIds && state.blockingSubagentRunIds.length > 0
        ? { blockingSubagentRunIds: state.blockingSubagentRunIds }
        : {}),
    },
    ...(state.pendingQuestionApprovalId
      ? { pendingQuestionApprovalId: state.pendingQuestionApprovalId }
      : {}),
    // Mirror pendingInteraction at the top level for the
    // slash-command-executor `/plan answer` path
    // (ui-src-ui-chat-slash-command-executor.ts.diff:144-148). The UI
    // discriminates on `kind` and reads `approvalId` + `questionId`.
    // We don't have `questionId` in our state today (it was recorded
    // in the question-approval persist on openclaw-1) so just mirror
    // what we have; questionId can land later via a separate field.
    ...(state.pendingInteraction
      ? {
          pendingInteraction: {
            kind:
              state.pendingInteraction.kind === "approval"
                ? "plan"
                : state.pendingInteraction.kind,
            approvalId: state.pendingInteraction.approvalId,
            createdAt: Date.parse(state.pendingInteraction.deliveredAt) || Date.now(),
            status: "pending" as const,
          },
        }
      : {}),
  };
}
