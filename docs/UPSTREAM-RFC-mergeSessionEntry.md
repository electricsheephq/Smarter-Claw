# Upstream RFC: `mergeSessionEntryWithPolicy("merge-plugin-metadata")`

**Target repo**: `openclaw/openclaw`
**Proposed change**: additive — new value for `SessionEntryMergePolicy`
**Backward compatibility**: full (default behavior unchanged)
**Status**: draft, pending operator review before filing upstream

## Problem statement

`mergeSessionEntry` at `src/config/sessions/types.ts:398-403` does a shallow spread:

```ts
export function mergeSessionEntryWithPolicy(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): SessionEntry {
  // ...
  const next = { ...existing, ...patch, sessionId, updatedAt };
  // ...
}
```

When a patch contains `pluginMetadata: { 'plugin-A': {...} }`, this REPLACES the entire `pluginMetadata` field in `next`. Any other plugin's slot (`'plugin-B'`, `'plugin-C'`, ...) that was on the existing entry is silently dropped.

This is observable in production today via the Smarter-Claw plugin (third-party, not bundled). When the agent reply lands and patches the entry, the agent's payload typically includes `pluginMetadata` populated with only its own slot — the spread clobbers any plan-mode state Smarter-Claw wrote earlier in the same session. The plugin currently works around this with a top-level mirror surface (`planMode`, `pendingInteraction`, `pendingQuestionApprovalId`) that the same shallow spread can't clobber, but the workaround creates a vocabulary split-brain (slot stores `kind: "approval"`, mirror translates to `kind: "plan"`) that has produced two separate live bugs already (Smarter-Claw PRs #65 and #67).

## Why not "just lock around the read-modify-write"?

The existing `withSessionStoreLock` already serializes writes per-store-path. The race isn't between concurrent writers — it's that the AGENT'S own patch (via the regular request path) doesn't carry forward the plugin's prior `pluginMetadata` writes, because the agent code doesn't know what plugins have stamped state. The patch is "everything I want this entry to look like" from the agent's perspective, which legitimately doesn't include opaque per-plugin state.

The fix has to live at merge time, not write time. The merger has the existing entry in hand and can preserve namespaces the patch didn't touch.

## Proposed change

Add `"merge-plugin-metadata"` to `SessionEntryMergePolicy`:

```ts
// types.ts:356
export type SessionEntryMergePolicy =
  | "touch-activity"
  | "preserve-activity"
  | "merge-plugin-metadata"; // NEW
```

Implementation in `mergeSessionEntryWithPolicy` (additive branch):

```ts
const next = { ...existing, ...patch, sessionId, updatedAt };

// NEW: when policy === "merge-plugin-metadata", deep-merge pluginMetadata
// at the namespace level (one level deep). The patch's slots take
// precedence over existing slots; existing slots not in patch are preserved.
if (
  options?.policy === "merge-plugin-metadata" &&
  existing?.pluginMetadata &&
  isPlainObject(patch.pluginMetadata)
) {
  next.pluginMetadata = {
    ...existing.pluginMetadata,
    ...patch.pluginMetadata,
  };
}

return normalizeSessionRuntimeModelFields(next);
```

Helper `isPlainObject` already exists in the codebase (`src/util/object.ts` or similar — the merger can use it directly).

## Call-site adoption

Existing call sites continue to use `mergeSessionEntry` (no policy) → unchanged behavior.

The places we want to opt in are the gateway-side patch handlers that ingest plugin-stamped metadata:
- `src/gateway/sessions-patch.ts` (handles `sessions.patch` RPC)
- `src/agents/command/session-store.ts` (agent-reply persist)

Both could be migrated to `mergeSessionEntryWithPolicy(existing, patch, { policy: "merge-plugin-metadata" })`. This is a one-line change per call site that preserves third-party plugin state across the request paths that produce most of the entry mutations.

## Backward compatibility analysis

**Callers using the existing default** (no `options.policy`): unchanged — fall through to the existing shallow-spread branch.

**Callers using `"preserve-activity"` policy**: orthogonal — that policy controls `updatedAt` resolution, this one controls `pluginMetadata` merging. Could combine in future as `policy: ["preserve-activity", "merge-plugin-metadata"]` if needed (would require a small enum-to-set widening).

**Existing `pluginMetadata` deletion semantics**: a caller that wants to actively REMOVE a slot would need to either (a) opt out by not using the merge policy for that one call, or (b) pass an explicit `{ "plugin-id": null }` sentinel that the merger treats as deletion. Option (b) is cleaner and matches Postgres JSONB merge semantics. Recommend including in the same RFC.

## Tests proposed

- `mergeSessionEntryWithPolicy("merge-plugin-metadata")` with empty existing → identical to default
- ... with existing slots and patch having different slot → both preserved
- ... with existing slot and patch having same slot → patch wins
- ... with patch having `null` value for a slot (if option-b adopted) → slot deleted
- Existing tests for default + `preserve-activity` policy unchanged

## What this unblocks for Smarter-Claw

Once this lands and we migrate to it:
1. Drop the top-level mirror surface (`planMode`, `pendingInteraction`, `pendingQuestionApprovalId`) — write directly to `pluginMetadata['smarter-claw']`
2. Delete the kind-translation logic (`approval` → `plan`)
3. Single source of truth for approval ID
4. Retire the file-state migration plan in `SPRINT-2-PLAN.md` (or keep it as opt-in for multi-process safety, separate concern)

The Sprint 2 file-state plan ships now (we can't wait for upstream); this RFC removes the need for it long-term.

## Filing plan

1. Operator reviews this draft
2. File as a GitHub issue against `openclaw/openclaw` titled "RFC: SessionEntryMergePolicy.'merge-plugin-metadata' for safe third-party plugin coexistence"
3. Link from this repo's #44 + #45 as the structural-fix tracking link
4. If upstream lands by v2026.5.x, plan a Smarter-Claw v0.4.x that drops the file-state path
