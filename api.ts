/**
 * Smarter Claw — public API surface.
 *
 * Other extensions (Cortex, lossless-claw, qa-compare, etc.) may import
 * from this module to read plan-mode types and constants. Runtime helpers
 * live in `runtime-api.ts`. The plugin entry itself lives in `index.ts`.
 *
 * Stability: BREAKING changes here trigger a major version bump.
 */

export type {
  PlanMode,
  PlanApprovalState,
  PlanStep,
  PlanProposal,
  SmarterClawSessionState,
} from "./src/types.js";

export {
  SMARTER_CLAW_PLUGIN_ID,
  PLAN_APPROVAL_KIND,
  PLANNING_RETRY_MARKER,
  PLAN_DECISION_MARKER,
} from "./src/types.js";

/**
 * The exact OpenClaw host version this Smarter-Claw release is pinned
 * against. The installer's patch SHAs are computed against this
 * version's bytes; running the installer against a different host
 * version will fail SHA verification (issue #13).
 *
 * Other plugins or tooling can probe this constant to build doctor /
 * compatibility-check commands ("does my host match what Smarter-Claw
 * needs?"). Bump this string in lockstep with installer/patch-plan.json
 * `expectedHostVersion` whenever Smarter-Claw moves to a new host
 * baseline.
 */
export const SUPPORTED_OPENCLAW_VERSION = "2026.4.23";

/**
 * Runtime guard: throw a clear error if the host version doesn't exactly
 * match SUPPORTED_OPENCLAW_VERSION. Called from index.ts at plugin
 * registration so a mismatched install fails loudly at gateway start
 * rather than silently producing odd behavior at first tool call.
 *
 * Default behavior is `throw` so an unsupported host fails fast. Pass
 * `mode: "warn"` to log without throwing — useful when you want to allow
 * a known-compatible newer host through. The thrown error includes the
 * host version so operators can see the mismatch in the gateway log.
 */
export function assertOpenclawVersionSupported(
  hostVersion: string | undefined,
  opts: { mode?: "throw" | "warn" } = {},
): void {
  if (!hostVersion) {
    // Host version unknown — nothing to assert. Caller should pass the
    // version it learned via package.json or process.env.
    return;
  }
  if (hostVersion === SUPPORTED_OPENCLAW_VERSION) {
    return;
  }
  const msg =
    `Smarter-Claw v0.2.0-dev is pinned to OpenClaw ${SUPPORTED_OPENCLAW_VERSION}, ` +
    `but the host is ${hostVersion}. Patch SHAs and runtime seams are not ` +
    `verified against this version. Install may fail or produce undefined ` +
    `behavior. Pin your host to ${SUPPORTED_OPENCLAW_VERSION} or wait for a ` +
    `Smarter-Claw release that supports your host.`;
  if (opts.mode === "warn") {
    console.warn(`[smarter-claw] ${msg}`);
    return;
  }
  throw new Error(msg);
}
