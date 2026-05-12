#!/usr/bin/env node
/**
 * verify-chat-stream-seam.mjs
 *
 * Verifies that the chat-stream seam patch is correctly applied to an
 * installed openclaw. Exit codes:
 *   0 - applied + all SHAs match
 *   1 - not applied (no sentinel)
 *   2 - applied but SHAs don't match (drift / corruption)
 *   3 - other error
 *
 * Usage:
 *   $ node scripts/verify-chat-stream-seam.mjs [--host <path>]
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SENTINEL_RELPATH = ".smarter-claw-chat-stream-seam-applied.json";

function parseArgs(argv) {
  const args = { host: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host" && argv[i + 1]) args.host = argv[++i];
  }
  return args;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
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
    console.log("NOT APPLIED");
    console.log(`  No sentinel at ${SENTINEL_RELPATH}`);
    console.log("  Run scripts/install-chat-stream-seam.mjs to apply.");
    process.exit(1);
  }

  const sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));
  console.log(`APPLIED (${sentinel.appliedAt})`);
  console.log(`  manifest: ${sentinel.manifestPath}`);
  console.log(`  openclaw version at apply time: ${sentinel.openclawVersion}`);

  // Verify each file's SHA matches what the sentinel records.
  const issues = [];
  for (const f of sentinel.appliedFiles) {
    const full = join(hostDir, f.relativePath);
    if (!existsSync(full)) {
      issues.push(`MISSING: ${f.relativePath}`);
      continue;
    }
    const actual = sha256(readFileSync(full));
    if (actual !== f.sha256) {
      issues.push(
        `DRIFT: ${f.relativePath} (sentinel: ${f.sha256.slice(0, 12)}…, actual: ${actual.slice(0, 12)}…)`,
      );
    } else {
      console.log(`  ✓ ${f.relativePath}`);
    }
  }

  if (issues.length > 0) {
    console.error(`\nFAIL: ${issues.length} integrity issue(s):`);
    for (const i of issues) console.error(`  ${i}`);
    console.error("\nRecommended: uninstall + reinstall the seam patch.");
    process.exit(2);
  }

  console.log("\nAll patched files verified.");
  process.exit(0);
}

main();
