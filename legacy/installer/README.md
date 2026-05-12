# Smarter-Claw installer

The installer is a Spicetify-style host patcher: it copies UI files and
applies version-pinned diffs to the installed `openclaw` package so the
plan-mode UI, mutation-gate seam, and write-API surface are wired
without forking the host.

## Commands

```bash
# Apply the patch set to the host (idempotent + transactional):
node installer/bin/install.mjs [--host=PATH] [--dry-run] [--force]

# Reverse every recorded patch:
node installer/bin/uninstall.mjs [--host=PATH] [--force]

# Verify the installed manifest matches what's actually on disk:
node installer/bin/verify.mjs [--host=PATH]
```

The host path is auto-discovered via the standard
`/opt/homebrew/lib/node_modules/openclaw` locations (or `npm root -g`),
or you can pass `--host=PATH` / set `SMARTER_CLAW_HOST=PATH`.

## Manifest

Every change is recorded in `<hostPath>/.smarter-claw-install-manifest.json`
(see `installer/lib/manifest.mjs`). Uninstall reads the manifest and
walks every patch in reverse. SHA fingerprints prevent silent drift —
any host file that differs from the manifest's recorded `newSha256`
refuses to be reversed (manual cleanup required).

## Concurrency

Install and uninstall acquire a process-exclusive lock at
`<hostPath>/.smarter-claw-install.lock` before any patch work begins
(see `installer/lib/install-lock.mjs`). Concurrent invocations fail
fast with a clear error pointing at the lock file. The lock is
released in a `finally` block AND on `SIGINT` / `SIGTERM` cleanup.

If the installer crashes, the lock file may be left behind. Inspect
the host for partial patches BEFORE removing the lock manually.

## Security trade-off (issue #12): public write API

`installer/patches/core/session-store-runtime-write-api.diff` adds two
exports to the host's plugin SDK:

```ts
export { updateSessionStore, updateSessionStoreEntry } from "../config/sessions/store.js";
```

These exports are what `runtime-api.ts:persistSmarterClawState` uses to
flip plan-mode state inside the host's per-storePath lock. They are
**also** publicly callable from any other OpenClaw plugin loaded into
the same gateway. That means installing Smarter-Claw widens the host's
plugin SDK in a way that affects ALL plugins, not just Smarter-Claw.

**Why we ship this anyway:** v1.0 OpenClaw has a curated single-author
plugin set with no third-party marketplace. The blast radius of a
malicious plugin abusing this export is the same as a malicious plugin
shipped with full host source access — i.e. installing a malicious
plugin already concedes the gateway.

**The principled fix** (tracked at issue #12): an upstream Plugin SDK
RFC for a narrowed `updatePluginMetadata({ pluginId, update })` API
that:

1. Limits the writable surface to `pluginMetadata[pluginId]` only —
   the caller cannot touch other plugins' slices or top-level fields.
2. Capability-checks the caller's pluginId via the host's plugin
   registration metadata.

Until that lands, the broad export remains. The trade-off is documented
inline in the diff's leading comment block so anyone reading the
applied host file sees it too.

## Patch authoring

`installer/patch-plan.json` is the source of truth for which files to
patch. Each entry is either:

```json
{
  "type": "new-file",
  "relPath": "ui/src/ui/chat/plan-cards.ts",
  "sourceRelPath": "patches/ui/new-files/ui/src/ui/chat/plan-cards.ts"
}
```

or:

```json
{
  "type": "diff",
  "relPath": "ui/src/ui/views/chat.ts",
  "patchRelPath": "patches/ui/anchor-patches/ui-src-ui-views-chat.ts.diff",
  "expectedOriginalSha256": "<sha256 of the host file BEFORE patching>"
}
```

The `expectedOriginalSha256` is recomputed on every install via
`readAndHashFile` (single-fd open + hash + buffer-return; no TOCTOU
between hash and patch — see issue #11).
