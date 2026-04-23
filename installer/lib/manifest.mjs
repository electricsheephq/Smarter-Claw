/**
 * Install manifest read/write.
 *
 * The manifest records EVERYTHING the installer changed in the host
 * tree so uninstall is fully reversible. Stored at:
 *
 *   <hostPath>/.smarter-claw-install-manifest.json
 *
 * (Stored alongside host package.json — uninstall reads it from a fixed
 * relative path, no env var or user input required.)
 *
 * Manifest schema (v1):
 * {
 *   "manifestVersion": 1,
 *   "smarterClawVersion": "0.1.0",
 *   "installedAt": "2026-04-24T02:30:00.000Z",
 *   "hostPath": "/abs/path/to/openclaw",
 *   "hostVersion": "2026.4.22",
 *   "hostExpectedVersion": "2026.4.22",
 *   "patches": [
 *     {
 *       "type": "new-file",
 *       "relPath": "ui/src/ui/chat/plan-cards.ts",
 *       "originalSha256": null,
 *       "newSha256": "abc...",
 *       "sourceRelPath": "patches/ui/new-files/ui/src/ui/chat/plan-cards.ts"
 *     },
 *     {
 *       "type": "diff",
 *       "relPath": "ui/src/ui/views/chat.ts",
 *       "originalSha256": "def...",
 *       "newSha256": "ghi...",
 *       "patchRelPath": "patches/ui/anchor-patches/ui-src-ui-views-chat.diff",
 *       "expectedOriginalSha256": "def..."
 *     }
 *   ]
 * }
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const MANIFEST_FILENAME = ".smarter-claw-install-manifest.json";
const MANIFEST_BACKUP_FILENAME = ".smarter-claw-install-manifest.backup.json";

export function manifestPathFor(hostPath) {
  return path.join(hostPath, MANIFEST_FILENAME);
}

export function manifestBackupPathFor(hostPath) {
  return path.join(hostPath, MANIFEST_BACKUP_FILENAME);
}

/**
 * Atomically write the manifest backup. Used by `--force` reinstall to
 * preserve a recovery file in case the new install fails partway through.
 * The backup is the verbatim PRE-WIPE manifest so a user can manually
 * `mv` it back to MANIFEST_FILENAME and run uninstall to restore the
 * baseline if recovery is needed.
 */
export function writeManifestBackup(hostPath, manifest) {
  const p = manifestBackupPathFor(hostPath);
  writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return p;
}

export function deleteManifestBackup(hostPath) {
  const p = manifestBackupPathFor(hostPath);
  if (existsSync(p)) {
    unlinkSync(p);
  }
}

export function readManifest(hostPath) {
  const p = manifestPathFor(hostPath);
  if (!existsSync(p)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(
      `Smarter-Claw install manifest at ${p} is corrupt (${err.message}). Manual cleanup required.`,
    );
  }
}

export function writeManifest(hostPath, manifest) {
  const p = manifestPathFor(hostPath);
  writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export function deleteManifest(hostPath) {
  const p = manifestPathFor(hostPath);
  if (existsSync(p)) {
    unlinkSync(p);
  }
}

export function newManifest({ hostPath, hostVersion, expectedHostVersion, smarterClawVersion }) {
  return {
    manifestVersion: 1,
    smarterClawVersion,
    installedAt: new Date().toISOString(),
    hostPath,
    hostVersion,
    hostExpectedVersion: expectedHostVersion,
    patches: [],
  };
}
