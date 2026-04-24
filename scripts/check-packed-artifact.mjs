#!/usr/bin/env node
/**
 * Post-pack assertion: inspect the actual .tgz produced by `pnpm pack`.
 * This complements check-tarball-shape.mjs, which validates the source tree
 * before packing. CI should fail if package.json `files` drift excludes a
 * runtime, installer, or CLI surface from the publish artifact.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const tgz = process.argv[2];
if (!tgz) {
  console.error("usage: node scripts/check-packed-artifact.mjs <package.tgz>");
  process.exit(2);
}

const REQUIRED_FILES = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/runtime-api.js",
  "dist/api.js",
  "dist/openclaw.plugin.json",
  "installer/bin/install.mjs",
  "installer/bin/uninstall.mjs",
  "installer/bin/verify.mjs",
  "installer/lib/apply-patch.mjs",
  "installer/lib/host-fingerprint.mjs",
  "installer/lib/install-lock.mjs",
  "installer/lib/locate-host.mjs",
  "installer/lib/manifest.mjs",
  "installer/patch-plan.json",
  "openclaw.plugin.json",
  "package.json",
  "README.md",
  "LICENSE",
];

const REQUIRED_NON_EMPTY_DIRS = [
  "installer/patches/ui/anchor-patches",
  "installer/patches/ui/new-files",
  "installer/patches/core",
];

function packagePath(rel) {
  return `package/${rel}`;
}

let entries;
try {
  entries = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.replace(/\/$/, ""))
    .filter(Boolean);
} catch (err) {
  console.error(`failed to list packed artifact ${tgz}:`);
  console.error(err.stderr?.toString() || err.message);
  process.exit(1);
}

const entrySet = new Set(entries);
const failures = [];

for (const rel of REQUIRED_FILES) {
  if (!entrySet.has(packagePath(rel))) {
    failures.push(`missing packed file: ${rel}`);
  }
}

for (const rel of REQUIRED_NON_EMPTY_DIRS) {
  const prefix = `${packagePath(rel)}/`;
  if (!entries.some((entry) => entry.startsWith(prefix))) {
    failures.push(`missing or empty packed directory: ${rel}`);
  }
}

try {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const [cmd, rel] of Object.entries(pkg.bin ?? {})) {
    if (!entrySet.has(packagePath(rel))) {
      failures.push(`packed bin "${cmd}" target is missing: ${rel}`);
    }
  }
} catch (err) {
  failures.push(`failed to validate package.json bin entries: ${err.message}`);
}

if (failures.length > 0) {
  console.error("\npacked artifact smoke FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\nPacked file: ${tgz}\n`);
  process.exit(1);
}

console.log("packed artifact smoke OK:");
console.log(`  ${REQUIRED_FILES.length} required files present`);
console.log(`  ${REQUIRED_NON_EMPTY_DIRS.length} required directories non-empty`);
console.log("  bin entries point at packed files");
