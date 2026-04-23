/**
 * Locate the host OpenClaw install on the current machine.
 *
 * Resolution order:
 *   1. Explicit --host=PATH CLI argument (passed in via opts.hostOverride)
 *   2. SMARTER_CLAW_HOST env var
 *   3. The npm symlink at /opt/homebrew/lib/node_modules/openclaw (macOS Homebrew)
 *      or /usr/local/lib/node_modules/openclaw (intel Macs / Linux Homebrew)
 *      or /usr/lib/node_modules/openclaw (Linux global npm)
 *   4. `npm root -g` discovery — runs `npm root -g` to learn the global
 *      modules dir, then checks `<dir>/openclaw` and follows the symlink
 *   5. nothing found → throw a clear error with installation hints
 *
 * Returns the resolved ABSOLUTE path to the host openclaw repo root
 * (NOT the dist/, NOT the package.json — the directory containing
 * `package.json` and `dist/` and `src/`). Caller is responsible for
 * verifying it actually IS an openclaw install (look for
 * package.json:name === "openclaw").
 */

import { execSync } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readlinkSync, readFileSync } from "node:fs";
import path from "node:path";

const HARDCODED_CANDIDATES = [
  "/opt/homebrew/lib/node_modules/openclaw",
  "/usr/local/lib/node_modules/openclaw",
  "/usr/lib/node_modules/openclaw",
];

/**
 * Resolves a candidate path that may be a symlink to its target.
 * Returns null if the candidate doesn't exist.
 *
 * TOCTOU-safe (issue #8): historical impl was lstatSync → readlinkSync →
 * existsSync(target), which leaves a window between each call where a
 * malicious symlink could swap the link target out from under us. The
 * fixed version:
 *   1. lstat the candidate (does NOT follow links).
 *   2. If it's a symlink, readlink + resolve target relative to the
 *      candidate's directory.
 *   3. Open the resolved target with O_NOFOLLOW (refuses any further
 *      symlink hop) and fstat the FD — so we're inspecting the exact
 *      inode the kernel handed us, not whatever the path resolves to
 *      now.
 *   4. Close the fd, then re-lstat the resolved path: if the dev/ino
 *      from fstat doesn't match the dev/ino from the second lstat, a
 *      swap happened between the open and the lstat — bail.
 *
 * This catches the swap-in-between attacks the original impl was
 * vulnerable to. The fd is opened read-only and immediately closed;
 * we don't read its contents here — the directory listing on the
 * resolved path is done by callers via verifyHost (which has its own
 * existsSync gate).
 */
function resolveCandidate(candidate) {
  // Use lstat, not exists, so a broken symlink is detected as such
  // rather than treated as "doesn't exist".
  let lstat;
  try {
    lstat = lstatSync(candidate);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }

  // Resolve to the final target path. For non-symlinks the target is the
  // candidate itself.
  let resolvedPath;
  if (lstat.isSymbolicLink()) {
    let target;
    try {
      target = readlinkSync(candidate);
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      throw err;
    }
    resolvedPath = path.isAbsolute(target) ? target : path.resolve(path.dirname(candidate), target);
  } else {
    resolvedPath = candidate;
  }

  // Open the resolved target. O_NOFOLLOW refuses to follow if the
  // resolved path is itself a symlink — which would be a multi-hop
  // attack chain. Combined with O_DIRECTORY where supported, this
  // guarantees we end up holding an fd to a real directory inode.
  let fd;
  try {
    // O_DIRECTORY isn't always defined; prefer it when available so we
    // get an EISDIR-style early bail on non-dir candidates.
    const flags = fsConstants.O_RDONLY
      | (fsConstants.O_NOFOLLOW || 0)
      | (fsConstants.O_DIRECTORY || 0);
    fd = openSync(resolvedPath, flags);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ELOOP" || err.code === "ENOTDIR")) {
      return null;
    }
    throw err;
  }

  let fdStat;
  try {
    fdStat = fstatSync(fd);
  } finally {
    closeSync(fd);
  }

  if (!fdStat.isDirectory()) {
    return null;
  }

  // Verify the path still resolves to the same inode after the open.
  // If a TOCTOU swap happened between open and now, dev/ino will differ
  // and we treat the candidate as unsafe.
  let postLstat;
  try {
    postLstat = lstatSync(resolvedPath);
  } catch {
    return null;
  }
  // If the resolved path is itself a symlink (which O_NOFOLLOW already
  // ruled out at open time, but lstat sees it as a link), the inode of
  // the link entry differs from the inode of the directory we opened —
  // refuse.
  if (postLstat.isSymbolicLink()) {
    return null;
  }
  if (postLstat.dev !== fdStat.dev || postLstat.ino !== fdStat.ino) {
    return null;
  }

  return resolvedPath;
}

/**
 * Verifies the directory looks like an OpenClaw install: contains a
 * package.json with name === "openclaw" or a recognized scoped variant.
 * Returns the version string when valid, null otherwise.
 */
function verifyHost(dir) {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    return null;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.name === "openclaw" || pkg.name?.startsWith("@openclaw/")) {
      return pkg.version ?? "unknown";
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Locate the host OpenClaw install.
 *
 * @param {object} opts
 * @param {string} [opts.hostOverride]  Explicit path from --host CLI flag.
 * @returns {{ hostPath: string, hostVersion: string }}
 * @throws Error with actionable message when nothing found.
 */
export function locateHost(opts = {}) {
  const tried = [];

  // 1. CLI override
  if (opts.hostOverride) {
    const resolved = resolveCandidate(opts.hostOverride);
    if (resolved) {
      const version = verifyHost(resolved);
      if (version) {
        return { hostPath: resolved, hostVersion: version };
      }
      throw new Error(
        `--host=${opts.hostOverride} resolved to ${resolved} but no openclaw package.json found there.`,
      );
    }
    throw new Error(`--host=${opts.hostOverride} does not exist.`);
  }

  // 2. env var
  if (process.env.SMARTER_CLAW_HOST) {
    const resolved = resolveCandidate(process.env.SMARTER_CLAW_HOST);
    if (resolved) {
      const version = verifyHost(resolved);
      if (version) {
        return { hostPath: resolved, hostVersion: version };
      }
      tried.push(`SMARTER_CLAW_HOST=${process.env.SMARTER_CLAW_HOST} (resolved to ${resolved}, but not an openclaw package)`);
    } else {
      tried.push(`SMARTER_CLAW_HOST=${process.env.SMARTER_CLAW_HOST} (does not exist)`);
    }
  }

  // 3. hardcoded standard locations
  for (const candidate of HARDCODED_CANDIDATES) {
    const resolved = resolveCandidate(candidate);
    if (resolved) {
      const version = verifyHost(resolved);
      if (version) {
        return { hostPath: resolved, hostVersion: version };
      }
      tried.push(`${candidate} (resolved to ${resolved}, but not an openclaw package)`);
    } else {
      tried.push(`${candidate} (does not exist)`);
    }
  }

  // 4. npm root -g discovery
  try {
    const npmRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const candidate = path.join(npmRoot, "openclaw");
    const resolved = resolveCandidate(candidate);
    if (resolved) {
      const version = verifyHost(resolved);
      if (version) {
        return { hostPath: resolved, hostVersion: version };
      }
      tried.push(`${candidate} (via 'npm root -g'; resolved to ${resolved}, but not an openclaw package)`);
    } else {
      tried.push(`${candidate} (via 'npm root -g'; does not exist)`);
    }
  } catch (err) {
    tried.push(`npm root -g failed: ${err.message}`);
  }

  // 5. nothing found
  throw new Error(
    `Smarter-Claw installer could not locate your OpenClaw install. Tried:\n  - ` +
      tried.join("\n  - ") +
      `\n\nSpecify the install path explicitly:\n  smarter-claw install --host=/path/to/openclaw\n  SMARTER_CLAW_HOST=/path/to/openclaw smarter-claw install\n\nIf you installed OpenClaw via 'npm install -g openclaw', the path is usually /opt/homebrew/lib/node_modules/openclaw on Apple Silicon Macs, or /usr/local/lib/node_modules/openclaw on Intel/Linux.`,
  );
}
