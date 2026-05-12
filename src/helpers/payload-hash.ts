/**
 * Plan-payload hashing for duplicate-detection / approvalId reuse.
 *
 * **Parity contract**: byte-identical port of the in-host hash
 * computation at
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/tools/exit-plan-mode-tool.ts:353-362`
 * (commit `ea04ea52c7`). The exact algorithm, exact input shape, exact
 * key order, exact truncation length — ALL part of the parity contract.
 * Any divergence would break the idempotency check inside
 * `persistApprovalRequest` and re-introduce the
 * Telegram /plan-accept duplicate-fire orphan-card regression that
 * Eva live-test surfaced on 2026-04-28.
 *
 * # The contract
 *
 * - Algorithm: SHA-1 (not SHA-256 — matches in-host explicitly)
 * - Output: lowercase hex, first 12 characters
 * - Input shape: `{t: title, s: summary, steps: [statusColonStep, ...]}`
 *   - title and summary fall back to "" (empty string) if absent
 *   - steps are pre-formatted as `${status}:${step}` strings (NOT the
 *     full PlanStep objects). The `activeForm` field is deliberately
 *     EXCLUDED — it's a derived UI hint that changes between calls
 *     for the same logical plan, which would defeat duplicate detection.
 * - Key order in the JSON: `t`, `s`, `steps` — this order matters
 *   because `JSON.stringify` preserves insertion order, and a
 *   different order changes the bytes, changes the hash.
 *
 * # Why SHA-1 here?
 *
 * The in-host chose SHA-1 because this hash is NOT a security
 * boundary — it's a fingerprint for duplicate detection. SHA-1 is
 * faster and shorter; collision risk is irrelevant (we only check
 * equality against the immediately-prior persisted hash on the same
 * session). For security boundaries (approvalId) we use crypto.randomUUID
 * — see helpers/approval-id.ts.
 */

import { createHash } from "node:crypto";

import type { PlanStep } from "../types.js";

/**
 * Input to the plan-payload hash. Mirrors the destructured fields the
 * in-host computation pulls from the exit_plan_mode tool args.
 */
export interface PlanPayloadHashInput {
  /** Plan title. If absent or empty, treated as "". */
  title?: string;
  /** Plan summary. If absent or empty, treated as "". */
  summary?: string;
  /** Plan steps. The `activeForm` field is ignored by the hash. */
  steps: ReadonlyArray<Pick<PlanStep, "step" | "status">>;
}

/**
 * Compute the duplicate-detection hash for a plan payload.
 *
 * Returns a 12-character lowercase hex string (SHA-1 prefix).
 *
 * host_ref: `src/agents/tools/exit-plan-mode-tool.ts:353-362`. Any
 *   divergence in algorithm, input shape, key order, or truncation
 *   length breaks the idempotency check in `persistApprovalRequest`.
 *
 * @example
 *   computePlanPayloadHash({
 *     title: "Bump deps",
 *     summary: "Update eslint + prettier",
 *     steps: [
 *       { step: "Bump eslint to 9.x", status: "pending" },
 *       { step: "Bump prettier to 4.x", status: "pending" },
 *     ],
 *   }); // → e.g. "9f1b2a4c5e7d"
 */
export function computePlanPayloadHash(input: PlanPayloadHashInput): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        t: input.title ?? "",
        s: input.summary ?? "",
        steps: input.steps.map((p) => `${p.status}:${p.step}`),
      }),
    )
    .digest("hex")
    .slice(0, 12);
}
