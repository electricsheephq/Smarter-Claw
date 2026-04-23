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
import { existsSync, lstatSync, readlinkSync, readFileSync } from "node:fs";
import path from "node:path";

const HARDCODED_CANDIDATES = [
  "/opt/homebrew/lib/node_modules/openclaw",
  "/usr/local/lib/node_modules/openclaw",
  "/usr/lib/node_modules/openclaw",
];

/**
 * Resolves a candidate path that may be a symlink to its target.
 * Returns null if the candidate doesn't exist.
 */
function resolveCandidate(candidate) {
  if (!existsSync(candidate)) {
    return null;
  }
  const stats = lstatSync(candidate);
  if (stats.isSymbolicLink()) {
    const target = readlinkSync(candidate);
    const resolved = path.isAbsolute(target) ? target : path.resolve(path.dirname(candidate), target);
    return existsSync(resolved) ? resolved : null;
  }
  return candidate;
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
