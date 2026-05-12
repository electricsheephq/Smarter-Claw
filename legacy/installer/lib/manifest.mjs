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

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MANIFEST_FILENAME = ".smarter-claw-install-manifest.json";
const MANIFEST_BACKUP_FILENAME = ".smarter-claw-install-manifest.backup.json";

export function manifestPathFor(hostPath) {
  return path.join(hostPath, MANIFEST_FILENAME);
}

export function manifestBackupPathFor(hostPath) {
  return path.join(hostPath, MANIFEST_BACKUP_FILENAME);
}

/**
 * Atomically write a JSON file via temp-then-rename. POSIX rename(2) is
 * atomic on the same filesystem — readers either see the OLD complete
 * file or the NEW complete file, never a half-written state.
 *
 * Sequence:
 *   1. Create a unique temp file in the SAME directory as the target
 *      (must be same filesystem so rename(2) is atomic).
 *   2. Write the JSON + fsync the file descriptor (forces kernel to
 *      flush write to disk before we proceed; protects against power
 *      loss between the write and the rename).
 *   3. Rename the temp over the target atomically.
 *   4. Best-effort fsync the parent directory so the rename itself is
 *      durable on disk (paranoid; mostly relevant on power-loss
 *      scenarios). Failure here is logged but doesn't roll back since
 *      the rename has already succeeded from any reader's perspective.
 *
 * On crash mid-write: the temp file may be left orphaned (named
 * `.smarter-claw-install-manifest.json.NNN.tmp` next to the real
 * manifest). Cleanup helper available below; install.mjs sweeps stale
 * temps at startup as belt-and-suspenders.
 *
 * Closes #22.
 */
function writeJsonAtomic(targetPath, value) {
  const dir = path.dirname(targetPath);
  const baseName = path.basename(targetPath);
  // 8 bytes of randomness keeps temp filenames unique per-process and
  // collision-resistant across concurrent installers (which the lock
  // ALSO prevents, but defense-in-depth).
  const suffix = randomBytes(4).toString("hex");
  const tempPath = path.join(dir, `${baseName}.${process.pid}.${suffix}.tmp`);
  const body = JSON.stringify(value, null, 2) + "\n";
  let fd;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeSync(fd, body, 0, "utf8");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  renameSync(tempPath, targetPath);
  // Parent-directory fsync so the rename itself is durable. Best-
  // effort: not all platforms support fsync on directory fds (Windows
  // throws EISDIR; opening the dir read-only on Linux works). Swallow
  // failures — at this point the rename has already succeeded and
  // reads will see the new file.
  let dirFd;
  try {
    dirFd = openSync(dir, "r");
    fsyncSync(dirFd);
  } catch {
    // Acceptable: parent-dir fsync is hardening, not correctness.
  } finally {
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Sweep orphaned temp files left by previous interrupted writeJsonAtomic
 * calls. Safe to call any time; only removes files matching our exact
 * temp-name pattern (`.smarter-claw-install-manifest.json.<pid>.<rand>.tmp`
 * + the `.backup.json` variant). Used by install.mjs at startup so a
 * previous crash doesn't leave the host directory polluted.
 */
export function sweepStaleTempManifests(hostPath) {
  const fs = readdirSafe(hostPath);
  if (!fs) return;
  const re = new RegExp(
    `^(${MANIFEST_FILENAME.replace(/\./g, "\\.")}|${MANIFEST_BACKUP_FILENAME.replace(/\./g, "\\.")})\\.\\d+\\.[0-9a-f]+\\.tmp$`,
  );
  for (const entry of fs) {
    if (!re.test(entry)) continue;
    try {
      unlinkSync(path.join(hostPath, entry));
    } catch {
      // Tolerate failure — sweep is best-effort.
    }
  }
}

function readdirSafe(dir) {
  if (!existsSync(dir)) return null;
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
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
  writeJsonAtomic(p, manifest);
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
  writeJsonAtomic(p, manifest);
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
