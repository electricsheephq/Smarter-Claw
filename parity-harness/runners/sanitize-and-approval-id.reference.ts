/**
 * Vendored reference for `sanitizeFeedbackForInjection` +
 * `newPlanApprovalId`.
 *
 * Both are byte-for-byte ports of the in-host
 * `src/agents/plan-mode/types.ts:104-160` at commit `ea04ea52c7`. The
 * sanitize function is pure → trivially vendored. The approvalId
 * minter is essentially crypto-RNG-driven; we vendor the SHAPE check
 * (the `plan-${uuid}` regex), then verify the plugin's output matches
 * the regex byte-for-byte.
 *
 * host_ref:
 *   - sanitize: src/agents/plan-mode/types.ts:158-160
 *   - newPlanApprovalId: src/agents/plan-mode/types.ts:113-148
 *
 * Anti-pattern guardrail: re-capture from in-host if it changes. Do
 * not mirror plugin source.
 */

/**
 * In-host sanitize function — byte-for-byte port. The U+200B
 * (zero-width space) byte at offset 1 inside the replacement is the
 * security contract.
 */
export function sanitizeFeedbackForInjectionReference(raw: string): string {
  return raw.replace(/\[\/PLAN_DECISION\]/gi, "[​/PLAN_DECISION]");
}

/**
 * The canonical regex an approvalId must match. Matches the in-host
 * `isPlanApprovalId` shape check at `types.ts` (and the plugin's
 * `helpers/approval-id.ts:isPlanApprovalId`). Lowercase hex,
 * 8-4-4-4-12, prefixed `plan-`.
 *
 * The exact format is part of the security contract — the runtime
 * compares approvalIds for staleness via the regex's shape. A
 * different format would silently fail-open every approval check.
 */
export const PLAN_APPROVAL_ID_SHAPE_REF =
  /^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
