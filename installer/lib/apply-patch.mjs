/**
 * Apply patches to host files.
 *
 * Two patch types are supported:
 *
 * 1. **new-file**: copy a Smarter-Claw-shipped file verbatim into the
 *    host tree at a given relative path. Used for net-new UI components
 *    (PR #70071's plan-cards.ts, mode-switcher.ts, etc.) that have no
 *    counterpart in vanilla v2026.4.22. Refuses to overwrite if the
 *    target already exists with non-null content (prevents clobbering
 *    a user's local file).
 *
 * 2. **diff**: apply a unified-diff patch to an existing host file.
 *    The patch is version-pinned: the installer computes SHA256 of
 *    the host file BEFORE patching and refuses if it doesn't match
 *    `expectedOriginalSha256`. This catches host drift (e.g., user
 *    is on a fork, or has manually edited the file) and refuses to
 *    proceed rather than corrupting it.
 *
 * Both patch types are TRANSACTIONAL — caller is responsible for
 * collecting completed patches and rolling back on failure (see
 * install.mjs for the orchestration loop).
 *
 * Returns the full PatchRecord written to the manifest.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readAndHashFile, sha256OfFile } from "./host-fingerprint.mjs";

/**
 * Containment guard for every path the installer touches.
 *
 * Two levels of defense:
 *   1. Reject relPaths that look obviously dangerous before we resolve
 *      them — absolute paths, NUL bytes, backslash separators on POSIX
 *      (Windows-style separators that path.posix won't normalize).
 *   2. After resolving relPath against hostPath, refuse if the resulting
 *      target is outside hostPath (path.relative starts with "..").
 *
 * This covers:
 *   - "../escape.txt"        — climbs out via path.relative check
 *   - "/etc/passwd"          — rejected by isAbsolute check
 *   - "a/../../escape.txt"   — climbs out, caught after resolve
 *   - "foo\0bar"             — rejected by NUL byte check
 *
 * Throws synchronously on violation so callers (apply + reverse) cannot
 * accidentally write or unlink anything outside the host tree.
 */
function assertSafeRelPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(`Refusing patch with invalid relPath: ${JSON.stringify(relPath)}`);
  }
  if (relPath.includes("\0")) {
    throw new Error(`Refusing patch with NUL byte in relPath: ${JSON.stringify(relPath)}`);
  }
  if (path.isAbsolute(relPath) || relPath.startsWith("/") || relPath.startsWith("\\")) {
    throw new Error(`Refusing patch with absolute relPath: ${JSON.stringify(relPath)}`);
  }
}

function assertInsideHost(hostPath, target) {
  const resolvedHost = path.resolve(hostPath);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedHost, resolvedTarget);
  if (rel === "" || rel === ".") {
    // target IS the host root — also disallow (no patches operate on the
    // host directory itself).
    throw new Error(
      `Refusing to operate on hostPath itself: ${target} (hostPath=${hostPath})`,
    );
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to operate on path outside hostPath: ${target} (hostPath=${hostPath})`,
    );
  }
}

/**
 * Apply a single new-file patch.
 *
 * @param {object} args
 * @param {string} args.hostPath  Absolute path to host openclaw root
 * @param {string} args.installerRoot  Absolute path to Smarter-Claw installer root
 * @param {string} args.relPath  Relative path of the target file inside hostPath
 * @param {string} args.sourceRelPath  Relative path of the patch source inside installerRoot
 * @param {boolean} [args.allowOverwrite=false]  Override the safety check (uninstall reverse)
 * @returns {object} PatchRecord
 */
export function applyNewFilePatch({ hostPath, installerRoot, relPath, sourceRelPath, allowOverwrite = false }) {
  assertSafeRelPath(relPath);
  const target = path.join(hostPath, relPath);
  assertInsideHost(hostPath, target);
  const source = path.join(installerRoot, sourceRelPath);

  if (!existsSync(source)) {
    throw new Error(`Patch source missing: ${sourceRelPath} (resolved to ${source})`);
  }

  if (existsSync(target) && !allowOverwrite) {
    const existingSha = sha256OfFile(target);
    const sourceSha = sha256OfFile(source);
    if (existingSha === sourceSha) {
      // Target already matches source — idempotent re-apply. No-op.
      return {
        type: "new-file",
        relPath,
        originalSha256: existingSha,
        newSha256: existingSha,
        sourceRelPath,
        skipped: "already-applied",
      };
    }
    throw new Error(
      `Cowardly refusing to overwrite ${relPath}: file exists in host with different content (sha=${existingSha}). Pass allowOverwrite=true to force.`,
    );
  }

  // Make sure the parent directory exists
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);

  return {
    type: "new-file",
    relPath,
    originalSha256: null, // file did not exist before
    newSha256: sha256OfFile(target),
    sourceRelPath,
  };
}

/**
 * Apply a single unified-diff patch.
 *
 * Format: standard unified diff. Supports only the subset of unified diff
 * used by `diff -u` / `git diff` output (`@@ -a,b +c,d @@` headers,
 * leading `-`/`+`/space line markers). No multi-file diff headers
 * (`---`/`+++`) — the patch file is for a SINGLE target.
 *
 * Strict-context mode: the installer requires every context (` `) and
 * removed (`-`) line to match exactly. No fuzz factor. If the host file
 * has drifted, refuse and tell the operator.
 *
 * @param {object} args
 * @param {string} args.hostPath
 * @param {string} args.installerRoot
 * @param {string} args.relPath
 * @param {string} args.patchRelPath
 * @param {string} args.expectedOriginalSha256
 * @returns {object} PatchRecord
 */
export function applyDiffPatch({ hostPath, installerRoot, relPath, patchRelPath, expectedOriginalSha256 }) {
  assertSafeRelPath(relPath);
  const target = path.join(hostPath, relPath);
  assertInsideHost(hostPath, target);
  const patchSource = path.join(installerRoot, patchRelPath);

  if (!existsSync(patchSource)) {
    throw new Error(`Patch source missing: ${patchRelPath} (resolved to ${patchSource})`);
  }
  if (!existsSync(target)) {
    throw new Error(
      `Cannot apply diff to ${relPath}: target file does not exist in host. (Are you on the wrong host version?)`,
    );
  }

  // Read + hash the file in a single fd-bound operation so the buffer we
  // patch is provably the buffer we just verified. Eliminates the
  // read-twice TOCTOU window described in issue #11: if we hashed the
  // file via sha256OfFile and then re-read it via readFileSync, an
  // attacker could swap the contents between calls and slip through
  // attacker-chosen bytes that the SHA already approved.
  const read = readAndHashFile(target);
  if (!read) {
    throw new Error(
      `Cannot apply diff to ${relPath}: target file disappeared between existence check and read. (Concurrent installer? Try again.)`,
    );
  }
  if (read.sha256 !== expectedOriginalSha256) {
    throw new Error(
      `Host file drift detected: ${relPath}\n  expected sha256: ${expectedOriginalSha256}\n  actual sha256:   ${read.sha256}\n\nThe Smarter-Claw installer is pinned to a specific OpenClaw version. Either you're on a different host version than expected, or this file has been manually modified. Refusing to patch.`,
    );
  }

  const originalContent = read.buffer.toString("utf8");
  const patchContent = readFileSync(patchSource, "utf8");
  const patchedContent = applyUnifiedDiff(originalContent, patchContent, relPath);

  writeFileSync(target, patchedContent, "utf8");

  return {
    type: "diff",
    relPath,
    originalSha256: read.sha256,
    newSha256: sha256OfFile(target),
    patchRelPath,
    expectedOriginalSha256,
  };
}

/**
 * Pure-JS unified-diff applier. Strict-context, no fuzz.
 * Returns the patched content. Throws on context mismatch.
 */
function applyUnifiedDiff(original, patch, relPathForError) {
  const originalLines = original.split("\n");
  const patchLines = patch.split("\n");

  // Index into originalLines (cursor) — advanced as we apply hunks.
  let cursor = 0;
  const output = [];

  let i = 0;
  while (i < patchLines.length) {
    const line = patchLines[i];
    if (!line.startsWith("@@")) {
      i++;
      continue;
    }
    // Parse hunk header: @@ -oldStart,oldLen +newStart,newLen @@
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      throw new Error(`Bad hunk header in ${relPathForError}: ${line}`);
    }
    const oldStart = parseInt(match[1], 10) - 1; // unified diff is 1-indexed; we use 0-indexed
    const oldLen = match[2] !== undefined ? parseInt(match[2], 10) : 1;

    // Bounds-check the hunk header BEFORE the cursor-advance loop.
    // If oldStart references a line past the end of the file, the
    // advance loop would push `undefined` into output and silently
    // synthesize blank lines (see issue #2). The only legal "past EOF"
    // case is a pure-add hunk (oldLen === 0) appending after the last
    // line, where oldStart === originalLines.length - 1 is OK.
    const minRequiredLines = oldStart + (oldLen > 0 ? oldLen : 0);
    if (oldStart < 0) {
      throw new Error(
        `Hunk header out-of-bounds in ${relPathForError}: oldStart=${oldStart + 1} is non-positive`,
      );
    }
    if (oldStart > originalLines.length) {
      throw new Error(
        `Hunk header out-of-bounds in ${relPathForError}: oldStart=${oldStart + 1} exceeds file length ${originalLines.length}`,
      );
    }
    if (minRequiredLines > originalLines.length) {
      throw new Error(
        `Hunk header out-of-bounds in ${relPathForError}: hunk references original lines ${oldStart + 1}..${minRequiredLines} but file has only ${originalLines.length} lines`,
      );
    }
    if (cursor > oldStart) {
      throw new Error(
        `Hunk header out-of-order in ${relPathForError}: oldStart=${oldStart + 1} is before current cursor=${cursor + 1}`,
      );
    }

    // Copy any unchanged lines between cursor and oldStart into output.
    // Bounded above by originalLines.length so we never push undefined.
    while (cursor < oldStart) {
      if (cursor >= originalLines.length) {
        throw new Error(
          `Hunk header out-of-bounds in ${relPathForError}: cursor=${cursor + 1} ran past file length ${originalLines.length} while seeking oldStart=${oldStart + 1}`,
        );
      }
      output.push(originalLines[cursor]);
      cursor++;
    }

    i++;
    // Process hunk body until next @@ or EOF
    while (i < patchLines.length && !patchLines[i].startsWith("@@")) {
      const hunkLine = patchLines[i];
      if (hunkLine === "" || hunkLine === "\\ No newline at end of file") {
        i++;
        continue;
      }
      const marker = hunkLine[0];
      const body = hunkLine.slice(1);
      if (marker === " ") {
        // Context — must match the original
        if (originalLines[cursor] !== body) {
          throw new Error(
            `Context mismatch in ${relPathForError} at original line ${cursor + 1}:\n  expected: ${JSON.stringify(body)}\n  actual:   ${JSON.stringify(originalLines[cursor])}`,
          );
        }
        output.push(body);
        cursor++;
      } else if (marker === "-") {
        // Removal — verify and skip
        if (originalLines[cursor] !== body) {
          throw new Error(
            `Removal mismatch in ${relPathForError} at original line ${cursor + 1}:\n  expected: ${JSON.stringify(body)}\n  actual:   ${JSON.stringify(originalLines[cursor])}`,
          );
        }
        cursor++;
      } else if (marker === "+") {
        // Addition — emit
        output.push(body);
      } else {
        throw new Error(`Unknown patch marker ${JSON.stringify(marker)} in ${relPathForError}: ${hunkLine}`);
      }
      i++;
    }
  }

  // Copy any remaining original lines (bounded — never push undefined).
  while (cursor < originalLines.length) {
    output.push(originalLines[cursor]);
    cursor++;
  }

  return output.join("\n");
}

// Export internal helpers for unit testing.
export const __test = { assertSafeRelPath, assertInsideHost, applyUnifiedDiff };

/**
 * Reverse a single new-file patch by deleting the file (only if its
 * SHA still matches the manifest's newSha256 — refuse if user has
 * modified it).
 */
export function reverseNewFilePatch({ hostPath, record }) {
  assertSafeRelPath(record.relPath);
  const target = path.join(hostPath, record.relPath);
  assertInsideHost(hostPath, target);
  if (!existsSync(target)) {
    return { skipped: "already-removed" };
  }
  // Read + hash in one fd-bound operation. Same TOCTOU rationale (#11):
  // the file we unlink must provably be the file whose SHA we just
  // verified — otherwise an attacker could swap it between the hash and
  // the unlink and trick us into deleting an unrelated file.
  const read = readAndHashFile(target);
  if (!read) {
    return { skipped: "already-removed" };
  }
  if (read.sha256 !== record.newSha256) {
    throw new Error(
      `Cannot reverse new-file patch for ${record.relPath}: file SHA differs from manifest (expected ${record.newSha256}, found ${read.sha256}). Manual cleanup required.`,
    );
  }
  unlinkSync(target);
  return { reversed: true };
}

/**
 * Reverse a single diff patch by applying it in reverse via the
 * stored expectedOriginalSha256: we need the original content back,
 * so the manifest must include either the original content blob OR
 * a reverse-diff. v0.1.0 keeps the manifest small by reverse-applying
 * the diff (swap +/- markers) — this works because our diffs are
 * strict-context.
 */
export function reverseDiffPatch({ hostPath, installerRoot, record }) {
  assertSafeRelPath(record.relPath);
  const target = path.join(hostPath, record.relPath);
  assertInsideHost(hostPath, target);
  const patchSource = path.join(installerRoot, record.patchRelPath);

  if (!existsSync(target)) {
    throw new Error(`Cannot reverse diff for ${record.relPath}: target file missing.`);
  }
  // Read + hash in one fd-bound operation. Same TOCTOU rationale as
  // applyDiffPatch (issue #11): the buffer we restore must provably be
  // the buffer whose SHA matches the manifest's newSha256.
  const read = readAndHashFile(target);
  if (!read) {
    throw new Error(
      `Cannot reverse diff for ${record.relPath}: target file disappeared between existence check and read.`,
    );
  }
  if (read.sha256 !== record.newSha256) {
    throw new Error(
      `Cannot reverse diff for ${record.relPath}: file SHA differs from manifest (expected ${record.newSha256}, found ${read.sha256}). Manual cleanup required.`,
    );
  }

  const currentContent = read.buffer.toString("utf8");
  const patchContent = readFileSync(patchSource, "utf8");
  const reversedPatch = invertUnifiedDiff(patchContent);
  const restored = applyUnifiedDiff(currentContent, reversedPatch, record.relPath);
  writeFileSync(target, restored, "utf8");

  const finalSha = sha256OfFile(target);
  if (finalSha !== record.originalSha256) {
    throw new Error(
      `Reverse-diff produced wrong content for ${record.relPath}: expected sha ${record.originalSha256}, got ${finalSha}. Restoring from manifest record.`,
    );
  }
  return { reversed: true };
}

/**
 * Swap +/- markers in a unified diff (used to compute a reverse
 * patch from a forward patch).
 */
function invertUnifiedDiff(patch) {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("@@")) {
        // Swap @@ -a,b +c,d @@ → @@ -c,d +a,b @@
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
        if (!m) return line;
        const oldStart = m[1], oldLen = m[2] ?? "", newStart = m[3], newLen = m[4] ?? "", trailer = m[5] ?? "";
        const oldRange = oldLen ? `${oldStart},${oldLen}` : oldStart;
        const newRange = newLen ? `${newStart},${newLen}` : newStart;
        return `@@ -${newRange} +${oldRange} @@${trailer}`;
      }
      if (line.startsWith("+")) return "-" + line.slice(1);
      if (line.startsWith("-")) return "+" + line.slice(1);
      return line;
    })
    .join("\n");
}
