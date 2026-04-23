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

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyDiffPatch, applyNewFilePatch, reverseDiffPatch, reverseNewFilePatch } from "../lib/apply-patch.mjs";
import { locateHost } from "../lib/locate-host.mjs";
import { manifestPathFor, newManifest, readManifest, writeManifest } from "../lib/manifest.mjs";

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

  if (existingManifest && args.force) {
    console.log(`\nForce reinstall: removing existing v${existingManifest.smarterClawVersion} install...`);
    // Reverse all patches from the existing manifest (best-effort)
    for (const record of [...existingManifest.patches].reverse()) {
      try {
        if (record.type === "new-file") {
          reverseNewFilePatch({ hostPath, record });
        } else if (record.type === "diff") {
          reverseDiffPatch({ hostPath, installerRoot: INSTALLER_ROOT, record });
        }
      } catch (err) {
        console.warn(`  WARN reversing ${record.relPath}: ${err.message}`);
      }
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
    console.error("Rolling back...");
    for (const record of [...completed].reverse()) {
      try {
        if (record.type === "new-file") reverseNewFilePatch({ hostPath, record });
        else if (record.type === "diff") reverseDiffPatch({ hostPath, installerRoot: INSTALLER_ROOT, record });
        console.error(`  rolled back: ${record.relPath}`);
      } catch (rbErr) {
        console.error(`  ROLLBACK FAILED for ${record.relPath}: ${rbErr.message}`);
      }
    }
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(`\n[dry-run] Would have installed Smarter-Claw v${smarterClawVersion} into ${hostPath}.`);
    return;
  }

  manifest.patches = completed;
  writeManifest(hostPath, manifest);

  console.log(`\nSmarter-Claw v${smarterClawVersion} installed.`);
  console.log(`Manifest: ${manifestPathFor(hostPath)}`);
  console.log(`\nNext: restart the OpenClaw gateway to load the patched code.`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
