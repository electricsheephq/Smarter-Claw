#!/usr/bin/env node
/**
 * Host-version parity assertion.
 *
 * Closes Wave-6 W6-1 (silent doc-vs-reality drift). Asserts that
 * `openclaw.plugin.json` `minHostVersion` is byte-identical to the
 * `package.json#openclaw.target.version` host target. When that target
 * is available on npm, the `devDependencies.openclaw` SDK pin must match.
 * When the target is a GitHub-only prerelease, the SDK fallback must be
 * declared explicitly so CI can distinguish a deliberate fallback from
 * silent doc-vs-reality drift.
 *
 * Why this matters
 * ----------------
 *
 * Wave-0 (#97) bumped `minHostVersion` to `2026.5.18` AND
 * `devDependencies.openclaw` to `2026.5.18`. Wave-6 (W6-1) caught
 * a separate doc-drift in `README.md` + `RELEASE_NOTES.md`, but the
 * silent-breakage class to lock down is the manifest-vs-implementation
 * mismatch: a plugin that declares `minHostVersion: X` while typechecking
 * against `Y < X` is a contract violation the npm registry and the
 * gateway loader cannot detect at install time. This check turns the
 * invariant into a hard CI gate.
 *
 * Scope (intentional)
 * -------------------
 *
 * Exact string match for manifest/runtime/install/peer target fields.
 * The devDependency only gets an exact-match exemption when
 * `openclaw.target.npmPackageAvailable === false` and
 * `openclaw.sdkValidation.npmFallbackVersion` equals the devDependency.
 *
 * Exit codes
 * ----------
 *
 *   0  parity OK
 *   1  unexpected I/O failure (file missing, malformed JSON)
 *   2  drift detected (manifest vs devDep mismatch)
 *
 * Wired into
 * ----------
 *
 *   - `pnpm parity-harness` (runs as a pre-step before the vitest
 *     parity check) — so any local `pnpm parity-harness` and the CI
 *     `Layer-1 parity harness` step both catch the drift.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function loadJson(relPath) {
  const abs = resolve(REPO_ROOT, relPath);
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    console.error(`[host-version-parity] failed to read ${relPath}: ${err.message}`);
    process.exit(1);
  }
}

const manifest = loadJson("openclaw.plugin.json");
const pkg = loadJson("package.json");

const minHostVersion = manifest.minHostVersion;
const devDepOpenclaw = pkg.devDependencies?.openclaw;
const pkgOpenClaw = pkg.openclaw;
const target = pkgOpenClaw?.target;
const sdkValidation = pkgOpenClaw?.sdkValidation;

if (typeof minHostVersion !== "string" || minHostVersion.length === 0) {
  console.error(
    "[host-version-parity] openclaw.plugin.json missing minHostVersion (or empty string).",
  );
  process.exit(1);
}
if (typeof devDepOpenclaw !== "string" || devDepOpenclaw.length === 0) {
  console.error(
    "[host-version-parity] package.json missing devDependencies.openclaw (or empty string).",
  );
  process.exit(1);
}

const targetVersion = target?.version;
if (typeof targetVersion !== "string" || targetVersion.length === 0) {
  console.error(
    "[host-version-parity] package.json missing openclaw.target.version.",
  );
  process.exit(2);
}

if (minHostVersion !== targetVersion) {
  console.error(
    `[host-version-parity] DRIFT: openclaw.plugin.json minHostVersion="${minHostVersion}" does NOT match package.json openclaw.target.version="${targetVersion}".`,
  );
  console.error(
    "  These MUST be byte-identical. The manifest declares the gateway minimum; the target records the release this package is claiming compatibility with.",
  );
  console.error(
    "  Fix: bump the lagging field to match, re-run `pnpm parity-harness`.",
  );
  process.exit(2);
}

const npmPackageAvailable = target?.npmPackageAvailable !== false;
if (npmPackageAvailable && minHostVersion !== devDepOpenclaw) {
  console.error(
    `[host-version-parity] DRIFT: target ${minHostVersion} is marked npm-available but devDependencies.openclaw="${devDepOpenclaw}".`,
  );
  console.error(
    "  Fix: set devDependencies.openclaw to the exact target version, re-run `pnpm install`, re-run `pnpm parity-harness`.",
  );
  process.exit(2);
}
if (!npmPackageAvailable) {
  if (target.source !== "github-release" || typeof target.tag !== "string" || !target.tag) {
    console.error(
      "[host-version-parity] GitHub-only OpenClaw target must declare openclaw.target.source=\"github-release\" and openclaw.target.tag.",
    );
    process.exit(2);
  }
  if (sdkValidation?.npmFallbackVersion !== devDepOpenclaw) {
    console.error(
      `[host-version-parity] GitHub-only target must declare openclaw.sdkValidation.npmFallbackVersion="${devDepOpenclaw}"; got ${JSON.stringify(sdkValidation?.npmFallbackVersion)}.`,
    );
    process.exit(2);
  }
  if (sdkValidation?.githubReleaseTag !== target.tag) {
    console.error(
      `[host-version-parity] openclaw.sdkValidation.githubReleaseTag must match openclaw.target.tag (${target.tag}).`,
    );
    process.exit(2);
  }
}

const expectedInstallFloor = `>=${targetVersion}`;
if (pkgOpenClaw?.install?.minHostVersion !== expectedInstallFloor) {
  console.error(
    `[host-version-parity] package.json openclaw.install.minHostVersion="${pkgOpenClaw?.install?.minHostVersion}" must be "${expectedInstallFloor}" for OpenClaw's canonical package install gate.`,
  );
  process.exit(2);
}

if (pkgOpenClaw?.build?.command !== "pnpm build") {
  console.error(
    `[host-version-parity] package.json openclaw.build.command must be "pnpm build"; got ${JSON.stringify(pkgOpenClaw?.build?.command)}.`,
  );
  process.exit(2);
}

const requiredTools = [
  "enter_plan_mode",
  "exit_plan_mode",
  "ask_user_question",
];
const declaredTools = new Set(manifest.contracts?.tools ?? []);
const missingTools = requiredTools.filter((tool) => !declaredTools.has(tool));
if (missingTools.length > 0) {
  console.error(
    `[host-version-parity] openclaw.plugin.json contracts.tools missing: ${missingTools.join(", ")}.`,
  );
  process.exit(2);
}
if (!(manifest.contracts?.sessionAttachments ?? []).includes("active-session")) {
  console.error(
    '[host-version-parity] openclaw.plugin.json contracts.sessionAttachments must include "active-session".',
  );
  process.exit(2);
}

// Optional: also sanity-check peerDependencies.openclaw (range-spec
// allowed; the invariant here is "the range INCLUDES minHostVersion").
// We do a conservative startsWith on a `>=` prefix to keep this script
// dependency-free; the simple case is sufficient today.
const peerOpenclaw = pkg.peerDependencies?.openclaw;
if (typeof peerOpenclaw === "string" && peerOpenclaw.startsWith(">=")) {
  const peerPin = peerOpenclaw.slice(2).trim();
  if (peerPin !== targetVersion) {
    console.error(
      `[host-version-parity] peerDependencies.openclaw="${peerOpenclaw}" pins ">=${peerPin}" but targetVersion="${targetVersion}". Convention: peer-dep pin = manifest target exactly.`,
    );
    process.exit(2);
  }
}

console.log(
  `[host-version-parity] OK — manifest minHostVersion=${minHostVersion} == target=${targetVersion}; devDependencies.openclaw=${devDepOpenclaw}${npmPackageAvailable ? "" : " (declared SDK fallback)"}${peerOpenclaw ? ` (peer=${peerOpenclaw})` : ""}; package install floor=${expectedInstallFloor}; contracts.tools=${requiredTools.join(",")}; sessionAttachments=active-session`,
);
