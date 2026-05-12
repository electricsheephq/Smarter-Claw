/**
 * Process-exclusive install lock.
 *
 * Prevents two concurrent invocations of install / uninstall (or any
 * combination) from racing each other against the host's manifest and
 * patched files. Without this, two installers can:
 *
 *   - Both read "no manifest", both apply patches sequentially, second
 *     one hits SHA mismatch on a file the first already patched, then
 *     rolls back patches that weren't its own — corrupts the host.
 *   - Read a partial manifest mid-write from a concurrent uninstall —
 *     misreports state.
 *
 * The lock file is `<hostPath>/.smarter-claw-install.lock`. Created with
 * `fs.openSync(path, 'wx')` which atomically EITHER creates the file OR
 * fails with EEXIST. The created fd holds the lock for the lifetime of
 * the process; we register a cleanup hook on `exit` and SIGTERM/SIGINT
 * so the lock file is removed even on abnormal termination.
 *
 * If the lock exists at start, we error out and tell the operator where
 * to find it. We deliberately DO NOT auto-clean stale locks — a stale
 * lock means a previous installer crashed, which means the host may be
 * in a partially-patched state that needs human review before another
 * install runs.
 */

import { closeSync, existsSync, openSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

const LOCK_FILENAME = ".smarter-claw-install.lock";

export function lockPathFor(hostPath) {
  return path.join(hostPath, LOCK_FILENAME);
}

/**
 * Acquire the install lock at <hostPath>/.smarter-claw-install.lock.
 *
 * Returns a `release()` function that the caller MUST invoke from a
 * `finally` block to remove the lock file. The lock is also released
 * automatically on process exit / SIGINT / SIGTERM via cleanup handlers.
 *
 * @throws Error with a clear "another install is running" message when
 * the lock already exists. The error message includes the lock path so
 * operators can inspect / delete it after confirming no installer is
 * actually running.
 */
export function acquireInstallLock(hostPath) {
  const lockPath = lockPathFor(hostPath);
  let fd;
  try {
    // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic create-or-fail.
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if (err && err.code === "EEXIST") {
      throw new Error(
        `Another smarter-claw install/uninstall appears to be running.\n  Lock file: ${lockPath}\n\nIf no installer is actually running (e.g. previous run crashed), inspect the host\nfor partial patches and remove the lock file manually:\n  rm "${lockPath}"\nThen re-run the installer. Do NOT delete the lock while another installer is\nrunning — concurrent runs corrupt the host.`,
      );
    }
    throw err;
  }
  // Write the PID to the lock for diagnostic purposes. Best-effort —
  // failures here don't block the lock semantics (the file's mere
  // existence is what holds the lock).
  try {
    writeSync(fd, `${process.pid}\n`);
  } catch {
    // ignore
  }

  let released = false;
  function release() {
    if (released) return;
    released = true;
    try {
      closeSync(fd);
    } catch {
      // ignore — fd may already be invalid
    }
    try {
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
      }
    } catch {
      // ignore — best-effort cleanup
    }
  }

  // Auto-release on abnormal termination so a Ctrl-C doesn't strand the
  // lock. `process.on('exit')` runs synchronously on normal exit; the
  // signal handlers re-throw to keep the original shutdown semantics
  // (signal -> nonzero exit code).
  const onExit = () => release();
  const onSignal = (signal) => {
    release();
    process.kill(process.pid, signal);
  };
  process.once("exit", onExit);
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  return release;
}
