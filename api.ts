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
