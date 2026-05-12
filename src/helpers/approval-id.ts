/**
 * Approval ID minting.
 *
 * **Parity contract**: mirrors
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/plan-mode/types.ts:104-148`
 * at commit `ea04ea52c7`. The `plan-` prefix + crypto.randomUUID() shape
 * is part of the security contract — approvalId is a security boundary
 * token (answer-guard / plan-approval staleness protection) and MUST
 * use cryptographically secure RNG.
 *
 * # Why this matters (from Copilot review #68939 + #71676)
 *
 * The earlier in-host implementation used
 * `Math.random().toString(36).slice(2, 10)` which exposed only ~26
 * bits of entropy and was guess-feasible. `crypto.randomUUID()`
 * provides ~122 bits — an attacker observing one approvalId cannot
 * guess the next within any practical attempt budget.
 *
 * # Why hard-refuse on RNG failure
 *
 * If neither `globalThis.crypto.randomUUID` nor `node:crypto.randomUUID`
 * resolves, we THROW rather than emit a predictable token. The plugin
 * should fail loudly so operators notice the broken environment. A
 * silent fallback to weak RNG would weaken plan-approval staleness
 * protection across every session.
 */

import { randomUUID as nodeRandomUUID } from "node:crypto";

/**
 * Mints a fresh plan-approvalId. Call on every `exit_plan_mode`
 * invocation so each plan-approval cycle has its own version token.
 *
 * Returns `plan-${uuid}` where `${uuid}` is the canonical v4 UUID
 * (8-4-4-4-12 hex form).
 *
 * Resolution order:
 *   1. `globalThis.crypto.randomUUID` (Node 19+, all modern browsers)
 *   2. `node:crypto.randomUUID` (Node fallback for unusual hosts)
 *   3. Throw — operator must notice the broken environment.
 *
 * @throws if no cryptographically secure RNG is available.
 *
 * host_ref: `src/agents/plan-mode/types.ts:113-148` — the in-host
 *   `newPlanApprovalId()` function. This is a byte-identical port.
 */
export function newPlanApprovalId(): string {
  // Try globalThis.crypto first — present in Node 19+ and all modern
  // browsers. The runtime check accommodates older host environments
  // (and tests that mock globalThis.crypto).
  const cryptoApi: { randomUUID?: () => string } | undefined =
    typeof globalThis !== "undefined" && "crypto" in globalThis
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return `plan-${cryptoApi.randomUUID()}`;
  }
  // Module-scope import from `node:crypto`. Modern Node always exposes
  // it. The earlier dynamic `require("node:crypto")` was unsafe in
  // ESM-only runtimes where `require` is not defined.
  try {
    return `plan-${nodeRandomUUID()}`;
  } catch {
    // Last-resort defensive fallback: throw. A silent weak-RNG fallback
    // would weaken the security boundary across every session.
    throw new Error(
      "newPlanApprovalId: no cryptographically secure RNG available (neither globalThis.crypto.randomUUID nor node:crypto.randomUUID). Refusing to mint a non-secure approvalId — this would weaken the answer-guard / plan-approval staleness protection.",
    );
  }
}

/**
 * Quick predicate: is this string shaped like a plan-approvalId?
 * Used for input validation in places that consume approvalIds
 * (slash-command handlers, session-action handlers).
 *
 * Accepts: `plan-` followed by a v4 UUID (canonical 8-4-4-4-12 form).
 * Rejects: anything else, including non-strings.
 */
export function isPlanApprovalId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // plan-<8>-<4>-<4>-<4>-<12> hex, lowercase
  return /^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
}
