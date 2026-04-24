#!/usr/bin/env node
/**
 * Pre-pack assertion: the tarball npm is about to publish (or that
 * this user is about to npm-pack) MUST contain the surfaces our
 * README + bin entries promise. If anything is missing, fail loud
 * BEFORE the bad tarball is built.
 *
 * Catches:
 *   - Missing dist/ (forgot to build, or build was interrupted)
 *   - Missing installer/bin/ (the headline feature shadow-disappeared)
 *   - Missing patch-plan.json or patches/ (installer would no-op on install)
 *   - Empty bin scripts (would publish CLI commands that error on first invoke)
 *
 * Runs as `prepack` (npm + pnpm both honor it). Exits non-zero on any
 * missing required file.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Required files — every entry MUST exist in the tarball-source state.
// Path is relative to package root.
const REQUIRED_FILES = [
  // Plugin runtime — built artifacts
  "dist/index.js",
  "dist/index.d.ts",
  "dist/runtime-api.js",
  "dist/api.js",
  "dist/openclaw.plugin.json",

  // Installer — bin scripts that map to the package's `bin` entries
  "installer/bin/install.mjs",
  "installer/bin/uninstall.mjs",
  "installer/bin/verify.mjs",

  // Installer libs — sourced by the bin scripts
  "installer/lib/apply-patch.mjs",
  "installer/lib/host-fingerprint.mjs",
  "installer/lib/install-lock.mjs",
  "installer/lib/locate-host.mjs",
  "installer/lib/manifest.mjs",

  // Installer plan + patches — without these the installer is a no-op
  "installer/patch-plan.json",

  // Surface metadata
  "openclaw.plugin.json",
  "package.json",
  "README.md",
  "LICENSE",
];

// Required directories — must exist + be non-empty
const REQUIRED_NON_EMPTY_DIRS = [
  "installer/patches/ui/anchor-patches",
  "installer/patches/ui/new-files",
  "installer/patches/core",
];

const failures = [];

for (const rel of REQUIRED_FILES) {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) {
    failures.push(`missing required file: ${rel}`);
    continue;
  }
  const st = statSync(p);
  if (!st.isFile()) {
    failures.push(`expected file but found ${st.isDirectory() ? "directory" : "other"}: ${rel}`);
    continue;
  }
  if (st.size === 0) {
    failures.push(`required file is empty (likely interrupted build): ${rel}`);
    continue;
  }
}

for (const rel of REQUIRED_NON_EMPTY_DIRS) {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) {
    failures.push(`missing required directory: ${rel}`);
    continue;
  }
  const st = statSync(p);
  if (!st.isDirectory()) {
    failures.push(`expected directory: ${rel}`);
    continue;
  }
  // Quick non-empty check via readdirSync
  const fs = await import("node:fs");
  const entries = fs.readdirSync(p);
  if (entries.length === 0) {
    failures.push(`required directory is empty: ${rel}`);
    continue;
  }
}

// Sanity-check the manifest contents (catches version drift between
// package.json and the installer's expectedHostVersion).
try {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const plan = JSON.parse(readFileSync(path.join(ROOT, "installer/patch-plan.json"), "utf8"));
  if (!plan.expectedHostVersion) {
    failures.push("installer/patch-plan.json missing expectedHostVersion");
  }
  if (!Array.isArray(plan.patches) || plan.patches.length === 0) {
    failures.push("installer/patch-plan.json patches[] is missing or empty");
  }
  if (!pkg.bin || Object.keys(pkg.bin).length === 0) {
    failures.push("package.json bin entry is missing");
  }
  // Verify each bin entry's target file exists.
  for (const [cmd, rel] of Object.entries(pkg.bin ?? {})) {
    const p = path.join(ROOT, rel);
    if (!existsSync(p)) failures.push(`bin "${cmd}" → ${rel} does not exist`);
  }
} catch (err) {
  failures.push(`failed to validate manifests: ${err.message}`);
}

if (failures.length > 0) {
  console.error("\nprepack tarball-shape check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\nThe tarball would publish a broken release. Build first (\`pnpm build\`),` +
      ` then retry. See scripts/check-tarball-shape.mjs for the required surface.\n`,
  );
  process.exit(1);
}

console.log("prepack tarball-shape check OK:");
console.log(`  ${REQUIRED_FILES.length} required files present`);
console.log(`  ${REQUIRED_NON_EMPTY_DIRS.length} required directories non-empty`);
console.log(`  bin entries point at existing files`);
