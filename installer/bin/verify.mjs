#!/usr/bin/env node
/**
 * Smarter-Claw verifier — checks every file in the install manifest
 * still matches its recorded post-patch SHA. Used by users / debug
 * tooling to confirm the install hasn't been disturbed by an OpenClaw
 * upgrade or accidental edit.
 *
 * Usage:
 *   node installer/bin/verify.mjs [--host=PATH] [--json]
 *
 * Exit codes:
 *   0 = install matches manifest
 *   1 = drift detected
 *   2 = no manifest / fatal error
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { sha256OfFile } from "../lib/host-fingerprint.mjs";
import { locateHost } from "../lib/locate-host.mjs";
import { manifestPathFor, readManifest } from "../lib/manifest.mjs";

function parseArgs(argv) {
  const args = { hostOverride: undefined, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--json") args.json = true;
    else if (arg.startsWith("--host=")) args.hostOverride = arg.slice("--host=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("smarter-claw verify [--host=PATH] [--json]");
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  const { hostPath, hostVersion } = locateHost(args);
  const manifest = readManifest(hostPath);
  if (!manifest) {
    if (args.json) {
      console.log(JSON.stringify({ status: "not-installed", hostPath }));
    } else {
      console.log(`Smarter-Claw is not installed at ${hostPath}.`);
    }
    process.exit(2);
  }

  const drifts = [];
  const missing = [];
  const ok = [];
  for (const record of manifest.patches) {
    const target = path.join(hostPath, record.relPath);
    if (!existsSync(target)) {
      missing.push(record.relPath);
      continue;
    }
    const actualSha = sha256OfFile(target);
    if (actualSha !== record.newSha256) {
      drifts.push({ relPath: record.relPath, expectedSha: record.newSha256, actualSha });
    } else {
      ok.push(record.relPath);
    }
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          status: drifts.length === 0 && missing.length === 0 ? "ok" : "drift",
          hostPath,
          hostVersion,
          smarterClawVersion: manifest.smarterClawVersion,
          patchCount: manifest.patches.length,
          ok: ok.length,
          drift: drifts,
          missing,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Smarter-Claw v${manifest.smarterClawVersion} on host ${hostVersion}`);
    console.log(`Manifest: ${manifestPathFor(hostPath)}`);
    console.log(`Patches:  ${manifest.patches.length}`);
    console.log(`OK:       ${ok.length}`);
    if (missing.length > 0) {
      console.log(`Missing:  ${missing.length}`);
      missing.forEach((p) => console.log(`  - ${p}`));
    }
    if (drifts.length > 0) {
      console.log(`Drift:    ${drifts.length}`);
      drifts.forEach((d) => console.log(`  - ${d.relPath} (expected ${d.expectedSha.slice(0, 12)}, found ${d.actualSha.slice(0, 12)})`));
    }
  }

  if (drifts.length > 0 || missing.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(2);
});
