/**
 * SHA256 fingerprinting for host files we plan to patch.
 *
 * Used to:
 *   - Verify the host file matches the expected baseline before patching
 *     (refuse if drifted — installer is version-pinned to v2026.4.22 on
 *     v0.1.0).
 *   - Record the original SHA in the install manifest so uninstall can
 *     verify the file hasn't been independently modified before reverting.
 *   - Record the post-patch SHA so verify.mjs can detect external
 *     tampering.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * Compute SHA256 of a file's contents. Returns null when the file
 * doesn't exist (caller decides whether that's an error).
 */
export function sha256OfFile(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Compute SHA256 of a string (used for verifying patch-source equivalence
 * to baseline expectations).
 */
export function sha256OfString(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}
