#!/usr/bin/env node
/**
 * Smarter-Claw installer entry.
 *
 * Usage:
 *   node installer/bin/install.mjs [--host=PATH] [--dry-run] [--force]
 *   smarter-claw install [--host=PATH] [--dry-run] [--force]
 *
 * The installer is a Spicetify-style host patcher: it copies UI files
 * into the host's ui/src/ui/ tree and applies version-pinned diffs to
 * core seam files. All changes are recorded in
 * <hostPath>/.smarter-claw-install-manifest.json so uninstall is fully
 * reversible.
 *
 * v0.1.0 patch surface:
 *   - UI new-files: PR #70071 components (plan-cards, mode-switcher,
 *     plan-resume, slash-command-executor, plan-approval-inline) +
 *     stylesheets + i18n keys
 *   - UI diffs: chat.ts, app.ts, app-tool-stream.ts, app-render.ts,
 *     types.ts mounts (small additive diffs to render plan-mode UI)
 *   - Core diffs: before_tool_call hook in attempt.ts (mutation gate
 *     activation), session-write API in session-store-runtime,
 *     synthetic-message-injection seam in agent runner
 *
 * Behavior:
 *   - Refuses if a manifest already exists (run uninstall first, or
 *     pass --force to wipe + reinstall).
 *   - Refuses if any host file has drifted from the expected SHA
 *     (host is on wrong version, or file was manually edited).
 *   - On any patch failure, ROLLS BACK all completed patches in
 *     reverse order. Manifest is written only on full success.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyDiffPatch, applyNewFilePatch, reverseDiffPatch, reverseNewFilePatch } from "../lib/apply-patch.mjs";
import { locateHost } from "../lib/locate-host.mjs";
import {
  deleteManifestBackup,
  manifestPathFor,
  newManifest,
  readManifest,
  writeManifest,
  writeManifestBackup,
} from "../lib/manifest.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INSTALLER_ROOT = path.resolve(__dirname, "..");
const SMARTER_CLAW_ROOT = path.resolve(INSTALLER_ROOT, "..");
const PATCH_PLAN_PATH = path.join(INSTALLER_ROOT, "patch-plan.json");

function parseArgs(argv) {
  const args = { hostOverride: undefined, dryRun: false, force: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg.startsWith("--host=")) args.hostOverride = arg.slice("--host=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "smarter-claw install [--host=PATH] [--dry-run] [--force]\n\n" +
          "  --host=PATH   override host openclaw install location\n" +
          "  --dry-run     print what would be done; make no changes\n" +
          "  --force       overwrite an existing install manifest (re-install)\n",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function loadPatchPlan() {
  if (!existsSync(PATCH_PLAN_PATH)) {
    throw new Error(
      `installer/patch-plan.json missing — Smarter-Claw is not packaged correctly. (Expected ${PATCH_PLAN_PATH})`,
    );
  }
  return JSON.parse(readFileSync(PATCH_PLAN_PATH, "utf8"));
}

function loadSmarterClawVersion() {
  const pkg = JSON.parse(readFileSync(path.join(SMARTER_CLAW_ROOT, "package.json"), "utf8"));
  return pkg.version;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log("Smarter-Claw installer\n");

  const { hostPath, hostVersion } = locateHost(args);
  console.log(`Host:    ${hostPath}`);
  console.log(`Version: ${hostVersion}`);

  const plan = loadPatchPlan();
  const smarterClawVersion = loadSmarterClawVersion();

  if (plan.expectedHostVersion !== hostVersion && !args.force) {
    throw new Error(
      `Host version mismatch.\n  expected: ${plan.expectedHostVersion}\n  actual:   ${hostVersion}\n\nThe v${smarterClawVersion} installer is pinned to host version ${plan.expectedHostVersion}. Pass --force to attempt patching anyway (high risk of context-mismatch failures).`,
    );
  }

  const existingManifest = readManifest(hostPath);
  if (existingManifest && !args.force) {
    throw new Error(
      `Smarter-Claw v${existingManifest.smarterClawVersion} is already installed (manifest at ${manifestPathFor(hostPath)}).\n\nRun 'smarter-claw uninstall' first, or pass --force to wipe and reinstall.`,
    );
  }

  // Track whether a backup manifest exists for this run so the rollback
  // path can re-apply it on mid-install failure.
  let backupPath = null;
  if (existingManifest && args.force) {
    // Persist the OLD manifest to a backup file BEFORE any reverse work,
    // so we can recover if anything below fails. The live manifest is
    // intentionally left in place — it is only deleted after the new
    // install successfully writes its replacement (atomic swap below).
    // See issue #6 for the failure scenarios this prevents.
    backupPath = writeManifestBackup(hostPath, existingManifest);
    console.log(`\nForce reinstall: backed up v${existingManifest.smarterClawVersion} manifest to:`);
    console.log(`  ${backupPath}`);
    console.log(`\nReversing existing v${existingManifest.smarterClawVersion} install...`);

    // Reverse all patches from the existing manifest. Track failures —
    // unlike before, a single reverse failure aborts the reinstall to
    // avoid stranding the host in a frankenstate where some old patches
    // are partially applied AND the new install is partially applied
    // with no clear way to recover.
    let reverseFailures = 0;
    for (const record of [...existingManifest.patches].reverse()) {
      try {
        if (record.type === "new-file") {
          reverseNewFilePatch({ hostPath, record });
        } else if (record.type === "diff") {
          reverseDiffPatch({ hostPath, installerRoot: INSTALLER_ROOT, record });
        }
      } catch (err) {
        reverseFailures++;
        console.warn(`  WARN reversing ${record.relPath}: ${err.message}`);
      }
    }
    if (reverseFailures > 0) {
      console.error(
        `\n${reverseFailures} patch(es) from the previous install could not be reversed.\n` +
          "Refusing to proceed with --force reinstall to avoid stranding the host.\n" +
          `\nThe pre-wipe manifest is preserved at: ${backupPath}\n` +
          "  - Inspect the warnings above to find drifted files.\n" +
          "  - Resolve the drift (restore the file, or accept that it's intentional and re-record its sha).\n" +
          "  - Then re-run install --force.\n",
      );
      process.exit(1);
    }
  }

  console.log(`\nApplying ${plan.patches.length} patches...`);
  const manifest = newManifest({
    hostPath,
    hostVersion,
    expectedHostVersion: plan.expectedHostVersion,
    smarterClawVersion,
  });

  const completed = [];
  try {
    for (const planRecord of plan.patches) {
      if (args.dryRun) {
        console.log(`  [dry-run] ${planRecord.type}: ${planRecord.relPath}`);
        continue;
      }
      let result;
      if (planRecord.type === "new-file") {
        result = applyNewFilePatch({
          hostPath,
          installerRoot: INSTALLER_ROOT,
          relPath: planRecord.relPath,
          sourceRelPath: planRecord.sourceRelPath,
        });
      } else if (planRecord.type === "diff") {
        result = applyDiffPatch({
          hostPath,
          installerRoot: INSTALLER_ROOT,
          relPath: planRecord.relPath,
          patchRelPath: planRecord.patchRelPath,
          expectedOriginalSha256: planRecord.expectedOriginalSha256,
        });
      } else {
        throw new Error(`Unknown patch type: ${planRecord.type}`);
      }
      completed.push(result);
      const tag = result.skipped ? `[${result.skipped}]` : "[applied]";
      console.log(`  ${tag} ${planRecord.type}: ${planRecord.relPath}`);
    }
  } catch (err) {
    console.error(`\nPATCH FAILED: ${err.message}`);
    console.error("Rolling back new patches...");
    for (const record of [...completed].reverse()) {
      try {
        if (record.type === "new-file") reverseNewFilePatch({ hostPath, record });
        else if (record.type === "diff") reverseDiffPatch({ hostPath, installerRoot: INSTALLER_ROOT, record });
        console.error(`  rolled back: ${record.relPath}`);
      } catch (rbErr) {
        console.error(`  ROLLBACK FAILED for ${record.relPath}: ${rbErr.message}`);
      }
    }
    if (backupPath) {
      // We were in --force-reinstall mode: the old install was reversed
      // but the new install failed. Inform the operator how to recover.
      // The live manifest still references the old install (we never
      // deleted it — atomic swap was supposed to happen on success), so
      // the simplest recovery is to leave both files in place and let
      // the user decide whether to re-attempt or restore from backup.
      console.error(`\nForce reinstall failed mid-stream.`);
      console.error(`  - Backup manifest preserved at: ${backupPath}`);
      console.error(`  - Live manifest still at:       ${manifestPathFor(hostPath)}`);
      console.error(
        `\nTo recover the previous install state, copy the backup over the live\n` +
          `manifest, then run \`smarter-claw uninstall --force\` to walk the host\n` +
          `back to baseline. (Or re-run install --force after fixing the cause.)`,
      );
    }
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(`\n[dry-run] Would have installed Smarter-Claw v${smarterClawVersion} into ${hostPath}.`);
    return;
  }

  manifest.patches = completed;

  // Bundled-openclaw shadow: swap the plugin's `node_modules/openclaw`
  // symlink so dynamic imports `import("openclaw/plugin-sdk/...")`
  // resolve to the HOST's openclaw (with the installer's patched
  // exports), not the npm-published v2026.4.22 dev dependency. Without
  // this, persistSmarterClawState reports "missing
  // updateSessionStoreEntry" because the plugin's local copy is the
  // unpatched npm version. Recorded in the manifest as a synthetic
  // patch so uninstall reverses it.
  const pluginRoot = SMARTER_CLAW_ROOT;
  const pluginNodeModulesOpenclaw = path.join(pluginRoot, "node_modules", "openclaw");
  let bundledOpenclawShadow = null;
  if (!args.dryRun) {
    bundledOpenclawShadow = swapBundledOpenclaw(pluginNodeModulesOpenclaw, hostPath);
    if (bundledOpenclawShadow) {
      manifest.patches.push(bundledOpenclawShadow);
      console.log(`  [shadowed] bundled openclaw → host symlink`);
    }
  }

  // Atomic-ish swap: write the new manifest (overwrites old in place; on
  // POSIX writeFileSync is one syscall). Only after this succeeds do we
  // delete the backup, so a crash between writeManifest and
  // deleteManifestBackup leaves both files on disk — the live one is
  // authoritative, the backup is harmless leftovers.
  writeManifest(hostPath, manifest);
  if (backupPath) {
    deleteManifestBackup(hostPath);
  }

  console.log(`\nSmarter-Claw v${smarterClawVersion} installed.`);
  console.log(`Manifest: ${manifestPathFor(hostPath)}`);
  console.log(`\nNext: restart the OpenClaw gateway to load the patched code.`);
}

/**
 * Replace the plugin's bundled `node_modules/openclaw` (the npm-published
 * v2026.4.22 dev dep) with a symlink to the host repo. This is the only
 * way to make `import("openclaw/plugin-sdk/...")` from the plugin's
 * runtime resolve to the host's PATCHED copy (which has the
 * `updateSessionStoreEntry` re-export the plugin needs). Stashes the
 * original bundled copy as a tarball so uninstall can restore it.
 *
 * Returns a synthetic patch record with type `bundled-openclaw-shadow`
 * for the manifest, or null when the swap is a no-op (already symlinked
 * to the same target).
 */
function swapBundledOpenclaw(pluginOpenclawPath, hostPath) {
  if (!existsSync(pluginOpenclawPath)) {
    // No bundled openclaw — plugin was installed via `pnpm openclaw plugins
    // install` which strips dev deps. Nothing to shadow.
    return null;
  }
  const lstat = lstatSync(pluginOpenclawPath);
  if (lstat.isSymbolicLink()) {
    const currentTarget = readlinkSync(pluginOpenclawPath);
    const expected = path.resolve(hostPath);
    if (path.resolve(path.dirname(pluginOpenclawPath), currentTarget) === expected) {
      // Already symlinked to this host — idempotent re-install.
      return null;
    }
  }
  // Stash the bundled copy under a sibling name so uninstall can restore
  // it. We don't tarball — the plugin's node_modules already contains the
  // raw tree from pnpm install, so a sibling-rename is enough.
  const stashPath = pluginOpenclawPath + ".smarter-claw-original";
  if (existsSync(stashPath)) {
    rmSync(stashPath, { recursive: true, force: true });
  }
  renameSync(pluginOpenclawPath, stashPath);
  symlinkSync(path.resolve(hostPath), pluginOpenclawPath);
  return {
    type: "bundled-openclaw-shadow",
    relPath: path.relative(hostPath, pluginOpenclawPath) || "../Smarter-Claw/node_modules/openclaw",
    pluginOpenclawPath,
    stashPath,
    targetHostPath: path.resolve(hostPath),
  };
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
