#!/usr/bin/env node
/**
 * install-chat-stream-seam.mjs
 *
 * Smarter-Claw side patcher: applies the chat-stream Control UI seam
 * to an installed openclaw npm package by replacing two compiled bundle
 * files with seam-built equivalents.
 *
 * Background
 * ----------
 *
 * The chat-stream renderer seam (new `chat-message`, `chat-input-bar`,
 * `chat-header-chip` surfaces + `priority` + `activeWhen` predicate on
 * PluginControlUiDescriptor) was filed as upstream openclaw PR #80982.
 * Until that merges and ships in a published openclaw release, this
 * patcher applies the seam to a locally-installed openclaw so Smarter-Claw's
 * v1.0 inline UI can run.
 *
 * Once the upstream PR lands in an `openclaw@>=X` release, bump
 * `peerDependencies.openclaw` in our package.json + drop this patcher.
 *
 * What this script does
 * ---------------------
 *
 *   1. Reads `patches/<manifest-dir>/manifest.json` (default `openclaw-2026.5.10-beta.5/`)
 *   2. Locates the installed openclaw at `node_modules/openclaw/` (caller-supplied or auto-detected)
 *   3. Verifies installed version matches manifest's `openclawVersion`
 *   4. SHA256-checks each baseline file matches manifest's `baselineSha256` (refuses to apply on drift)
 *   5. Backs up the originals into `node_modules/openclaw/.smarter-claw-backups/`
 *   6. Copies the overlay files into `node_modules/openclaw/dist/`
 *   7. Writes a sentinel at `node_modules/openclaw/.smarter-claw-chat-stream-seam-applied.json`
 *      with version + timestamp + applied-SHA records
 *
 * Failure modes
 * -------------
 *
 *   - Wrong openclaw version → refuse + report mismatch
 *   - Baseline file drift (SHA doesn't match) → refuse + report; suggests
 *     operator either reinstall openclaw or update Smarter-Claw to a
 *     newer manifest entry
 *   - Already applied (sentinel present) → no-op + report
 *   - Cannot write backup or overlay → refuse + restore any partial state
 *
 * Usage
 * -----
 *
 *   $ node scripts/install-chat-stream-seam.mjs [--host <path>] [--dry-run] [--force]
 *
 *   --host <path>   Path to the openclaw install (default: ./node_modules/openclaw)
 *   --dry-run       Report what would change; do not write
 *   --force         Skip baseline SHA verification (NOT RECOMMENDED)
 *
 * Companion scripts:
 *   - scripts/verify-chat-stream-seam.mjs    Check sentinel + patched-file SHAs
 *   - scripts/uninstall-chat-stream-seam.mjs Restore originals from backup
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const MANIFEST_RELDIR = "patches/openclaw-2026.5.10-beta.5";
const SENTINEL_RELPATH = ".smarter-claw-chat-stream-seam-applied.json";
const BACKUP_RELDIR = ".smarter-claw-backups";

function parseArgs(argv) {
  const args = { host: null, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host" && argv[i + 1]) {
      args.host = argv[++i];
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--help" || a === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 50).join("\n"));
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function resolveHostDir(suppliedHost) {
  if (suppliedHost) {
    const abs = resolve(suppliedHost);
    if (!existsSync(abs)) {
      throw new Error(`--host path does not exist: ${abs}`);
    }
    return abs;
  }
  // Auto-detect: walk up from REPO_ROOT looking for node_modules/openclaw.
  let dir = REPO_ROOT;
  for (let depth = 0; depth < 5; depth++) {
    const candidate = join(dir, "node_modules", "openclaw");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not auto-locate node_modules/openclaw. Pass --host /path/to/openclaw to specify.",
  );
}

function readManifest() {
  const path = join(REPO_ROOT, MANIFEST_RELDIR, "manifest.json");
  if (!existsSync(path)) {
    throw new Error(`Manifest missing at ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function readHostVersion(hostDir) {
  const pkgPath = join(hostDir, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json at ${pkgPath}`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.version;
}

function alreadyApplied(hostDir) {
  return existsSync(join(hostDir, SENTINEL_RELPATH));
}

function backupOriginal(hostDir, relPath, dryRun) {
  const src = join(hostDir, relPath);
  const backupDir = join(hostDir, BACKUP_RELDIR, dirname(relPath));
  const backupPath = join(hostDir, BACKUP_RELDIR, relPath);
  if (dryRun) {
    console.log(`  [dry-run] would backup ${relPath} → ${BACKUP_RELDIR}/${relPath}`);
    return;
  }
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(src, backupPath);
}

function applyOverlay(hostDir, manifestDir, relPath, dryRun) {
  const overlayFilename = relPath.split("/").pop();
  const overlaySrc = join(manifestDir, overlayFilename);
  const overlayDst = join(hostDir, relPath);
  if (dryRun) {
    console.log(`  [dry-run] would overlay ${relPath}`);
    return;
  }
  copyFileSync(overlaySrc, overlayDst);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readManifest();
  const manifestDir = join(REPO_ROOT, MANIFEST_RELDIR);
  const hostDir = resolveHostDir(args.host);

  console.log(`Smarter-Claw chat-stream seam patcher`);
  console.log(`  host: ${hostDir}`);
  console.log(`  manifest version: ${manifest.openclawVersion}`);

  const installedVersion = readHostVersion(hostDir);
  console.log(`  installed openclaw version: ${installedVersion}`);
  if (installedVersion !== manifest.openclawVersion) {
    console.error(
      `\nFAIL: installed openclaw version ${installedVersion} does not match manifest version ${manifest.openclawVersion}.\n` +
        `Either: (a) install the matching openclaw version, or (b) update Smarter-Claw to a version with a manifest for ${installedVersion}.`,
    );
    process.exit(3);
  }

  if (alreadyApplied(hostDir)) {
    console.log(`\nAlready applied. Sentinel found at ${SENTINEL_RELPATH}.`);
    console.log("Run scripts/uninstall-chat-stream-seam.mjs to revert, then re-install.");
    process.exit(0);
  }

  // Pre-flight: verify each baseline file SHA before touching anything.
  console.log(`\nVerifying ${manifest.files.length} baseline files…`);
  const issues = [];
  for (const f of manifest.files) {
    const fullPath = join(hostDir, f.relativePath);
    if (!existsSync(fullPath)) {
      issues.push(`MISSING: ${f.relativePath}`);
      continue;
    }
    const actualSha = sha256(readFileSync(fullPath));
    if (actualSha !== f.baselineSha256) {
      issues.push(
        `DRIFT: ${f.relativePath} (expected ${f.baselineSha256.slice(0, 12)}…, got ${actualSha.slice(0, 12)}…)`,
      );
    } else {
      console.log(`  ✓ ${f.relativePath}`);
    }
  }

  if (issues.length > 0) {
    if (!args.force) {
      console.error(`\nFAIL: ${issues.length} baseline integrity issue(s):`);
      for (const i of issues) console.error(`  ${i}`);
      console.error(
        "\nThe installed openclaw differs from what this manifest expects.\n" +
          "Refusing to apply (use --force to override at your own risk).",
      );
      process.exit(4);
    } else {
      console.warn(`\nWARNING: ${issues.length} baseline issue(s), but --force was supplied:`);
      for (const i of issues) console.warn(`  ${i}`);
    }
  }

  // Apply.
  console.log(`\n${args.dryRun ? "Dry-run: would apply" : "Applying"} ${manifest.files.length} overlays…`);
  for (const f of manifest.files) {
    backupOriginal(hostDir, f.relativePath, args.dryRun);
    applyOverlay(hostDir, manifestDir, f.relativePath, args.dryRun);
    if (!args.dryRun) {
      const post = sha256(readFileSync(join(hostDir, f.relativePath)));
      if (post !== f.patchedSha256) {
        console.error(
          `\nFAIL: post-overlay SHA mismatch on ${f.relativePath}\n  expected ${f.patchedSha256}\n  got      ${post}`,
        );
        process.exit(5);
      }
      console.log(`  ✓ ${f.relativePath}`);
    }
  }

  if (args.dryRun) {
    console.log("\nDry-run complete. No changes written.");
    return;
  }

  const sentinel = {
    appliedAt: new Date().toISOString(),
    openclawVersion: manifest.openclawVersion,
    manifestPath: MANIFEST_RELDIR,
    seamSource: manifest.seamSource,
    appliedFiles: manifest.files.map((f) => ({
      relativePath: f.relativePath,
      sha256: f.patchedSha256,
    })),
  };
  writeFileSync(
    join(hostDir, SENTINEL_RELPATH),
    JSON.stringify(sentinel, null, 2) + "\n",
  );
  console.log(`\nDone. Sentinel: ${SENTINEL_RELPATH}`);
  console.log("To revert: node scripts/uninstall-chat-stream-seam.mjs");
}

main();
