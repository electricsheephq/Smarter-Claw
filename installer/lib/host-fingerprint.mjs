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
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

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
 * Read a file once via an open fd, return both the buffer AND the SHA256
 * of that exact buffer. Eliminates the TOCTOU window between hash and
 * read that exists when sha256OfFile + readFileSync are called separately
 * (issue #11): an attacker could swap the file contents between the two
 * reads, causing the patcher to apply against a buffer that did not match
 * the SHA we just verified.
 *
 * Returns { buffer, sha256 } where buffer is a Buffer of the file contents
 * and sha256 is the hex digest of that buffer. Returns null when the file
 * doesn't exist.
 *
 * Implementation: opens the fd once with openSync, reads the full file
 * via fstat-driven readSync loop, then hashes the captured buffer. The
 * fd is held open for the duration of the read so the kernel hands us a
 * stable inode for the whole operation. Symlinks are followed by openSync
 * (the patcher already prevents creating links along the target path —
 * see assertInsideHost in apply-patch.mjs).
 */
export function readAndHashFile(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  const fd = openSync(filePath, "r");
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
      if (bytesRead <= 0) {
        break;
      }
      offset += bytesRead;
    }
    // If the file shrank between fstat and read, slice down to the actual
    // bytes we got. Better than hashing trailing zeros from allocUnsafe.
    const finalBuffer = offset === size ? buffer : buffer.subarray(0, offset);
    const sha256 = createHash("sha256").update(finalBuffer).digest("hex");
    return { buffer: finalBuffer, sha256 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Compute SHA256 of a string (used for verifying patch-source equivalence
 * to baseline expectations).
 */
export function sha256OfString(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}
