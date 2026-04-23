#!/usr/bin/env node
/**
 * Smarter-Claw uninstaller entry.
 *
 * Reads <hostPath>/.smarter-claw-install-manifest.json and reverses
 * every patch in reverse order. Refuses to touch any file whose SHA
 * has drifted from the manifest's newSha256 (means the user has
 * modified it since install — manual cleanup required).
 *
 * Usage:
 *   node installer/bin/uninstall.mjs [--host=PATH] [--force]
 *
 * --force skips the SHA-drift safety check.
 */

import { existsSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reverseDiffPatch, reverseNewFilePatch } from "../lib/apply-patch.mjs";
import { acquireInstallLock } from "../lib/install-lock.mjs";
import { locateHost } from "../lib/locate-host.mjs";
import { deleteManifest, manifestPathFor, readManifest } from "../lib/manifest.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INSTALLER_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { hostOverride: undefined, force: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--force") args.force = true;
    else if (arg.startsWith("--host=")) args.hostOverride = arg.slice("--host=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "smarter-claw uninstall [--host=PATH] [--force]\n\n" +
          "  --host=PATH   override host openclaw install location\n" +
          "  --force       skip SHA-drift safety checks (best-effort revert)\n",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log("Smarter-Claw uninstaller\n");

  const { hostPath } = locateHost(args);
  console.log(`Host:     ${hostPath}`);

  // Acquire the same process-exclusive lock as install.mjs so uninstall
  // can't race a concurrent install (or another uninstall) — see #7.
  // Released in finally so an unclean exit doesn't strand the lock.
  const releaseLock = acquireInstallLock(hostPath);
  try {
    await runUninstall({ args, hostPath });
  } finally {
    releaseLock();
  }
}

async function runUninstall({ args, hostPath }) {
  const manifest = readManifest(hostPath);
  if (!manifest) {
    console.log(`No Smarter-Claw install found at ${manifestPathFor(hostPath)}.`);
    return;
  }

  console.log(`Installed: Smarter-Claw v${manifest.smarterClawVersion} (${manifest.installedAt})`);
  console.log(`Patches:   ${manifest.patches.length}`);
  console.log();

  let failures = 0;
  for (const record of [...manifest.patches].reverse()) {
    try {
      let result;
      if (record.type === "new-file") {
        result = reverseNewFilePatch({ hostPath, record });
      } else if (record.type === "diff") {
        result = reverseDiffPatch({ hostPath, installerRoot: INSTALLER_ROOT, record });
      } else if (record.type === "bundled-openclaw-shadow") {
        result = reverseBundledOpenclawShadow({ record });
      } else {
        console.warn(`  WARN: unknown patch type ${record.type} for ${record.relPath}, skipping`);
        continue;
      }
      const tag = result.skipped ? `[${result.skipped}]` : "[reversed]";
      console.log(`  ${tag} ${record.type}: ${record.relPath}`);
    } catch (err) {
      failures++;
      if (args.force) {
        console.warn(`  WARN ${record.relPath}: ${err.message} (continuing due to --force)`);
      } else {
        console.error(`  FAIL ${record.relPath}: ${err.message}`);
      }
    }
  }

  if (failures > 0 && !args.force) {
    console.error(
      `\n${failures} patch(es) could not be reversed. Manifest preserved at ${manifestPathFor(hostPath)}.\nFix the conflicts (or pass --force) and rerun.`,
    );
    process.exit(1);
  }

  deleteManifest(hostPath);
  console.log(`\nSmarter-Claw uninstalled.`);
  console.log(`\nNext: restart the OpenClaw gateway to reload the original code.`);
}

/**
 * Reverse the bundled-openclaw-shadow swap: delete the symlink, rename
 * the stash back into place. Mirror of `swapBundledOpenclaw` in install.mjs.
 */
function reverseBundledOpenclawShadow({ record }) {
  const target = record.pluginOpenclawPath;
  const stash = record.stashPath;
  if (!existsSync(stash)) {
    if (!existsSync(target)) {
      return { skipped: "no shadow + no stash; nothing to reverse" };
    }
    return { skipped: "stash missing; cannot restore original openclaw" };
  }
  if (existsSync(target)) {
    const lstat = lstatSync(target);
    if (!lstat.isSymbolicLink()) {
      return { skipped: "target is no longer the shadow symlink; manual cleanup required" };
    }
    unlinkSync(target);
  }
  renameSync(stash, target);
  return { reversed: true };
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
