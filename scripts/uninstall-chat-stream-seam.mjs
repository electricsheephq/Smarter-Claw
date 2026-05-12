#!/usr/bin/env node
/**
 * uninstall-chat-stream-seam.mjs
 *
 * Reverts the chat-stream seam patch by restoring originals from
 * `node_modules/openclaw/.smarter-claw-backups/`.
 *
 * Usage:
 *   $ node scripts/uninstall-chat-stream-seam.mjs [--host <path>] [--dry-run]
 *
 * Exits 0 on success, 1 if no sentinel found (= not currently patched).
 */

import { existsSync, readFileSync, rmSync, copyFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SENTINEL_RELPATH = ".smarter-claw-chat-stream-seam-applied.json";
const BACKUP_RELDIR = ".smarter-claw-backups";

function parseArgs(argv) {
  const args = { host: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host" && argv[i + 1]) args.host = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

function resolveHostDir(suppliedHost) {
  if (suppliedHost) return resolve(suppliedHost);
  let dir = REPO_ROOT;
  for (let depth = 0; depth < 5; depth++) {
    const candidate = join(dir, "node_modules", "openclaw");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not auto-locate node_modules/openclaw. Pass --host /path.");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const hostDir = resolveHostDir(args.host);
  const sentinelPath = join(hostDir, SENTINEL_RELPATH);

  if (!existsSync(sentinelPath)) {
    console.log("NOT APPLIED — no sentinel; nothing to revert.");
    process.exit(1);
  }

  const sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));
  console.log(
    `Reverting chat-stream seam patch (applied ${sentinel.appliedAt}, openclaw ${sentinel.openclawVersion})…`,
  );

  for (const f of sentinel.appliedFiles) {
    const backupPath = join(hostDir, BACKUP_RELDIR, f.relativePath);
    const targetPath = join(hostDir, f.relativePath);
    if (!existsSync(backupPath)) {
      console.error(`  MISSING BACKUP: ${BACKUP_RELDIR}/${f.relativePath}`);
      console.error("  Cannot restore. Reinstall openclaw to recover.");
      process.exit(2);
    }
    if (args.dryRun) {
      console.log(`  [dry-run] would restore ${f.relativePath} from backup`);
    } else {
      copyFileSync(backupPath, targetPath);
      console.log(`  ✓ ${f.relativePath} restored`);
    }
  }

  if (!args.dryRun) {
    rmSync(join(hostDir, BACKUP_RELDIR), { recursive: true, force: true });
    rmSync(sentinelPath);
    console.log(`\nDone. Sentinel + backups removed.`);
  } else {
    console.log("\nDry-run complete. No changes written.");
  }
}

main();
