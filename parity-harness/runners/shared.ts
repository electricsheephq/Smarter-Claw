/**
 * Common snapshot shape produced by both parity runners.
 *
 * The diff tool compares these per-case. Any unexplained divergence
 * means the plugin's PlanModeStore.persistApprovalRequest has drifted
 * from the in-host reference.
 */

import type { PlanModeSessionState } from "../../src/types.js";

export interface ParityCase {
  id: string;
  description: string;
  state_before: PlanModeSessionState | null;
  input: {
    sessionKey: string;
    approvalId: string;
    title?: string;
    payloadHash?: string;
    lastPlanSteps?: Array<{
      step: string;
      status: string;
      activeForm?: string;
    }>;
  };
}

export interface ParityOutcome {
  /** Case id from the input table; copied through. */
  caseId: string;
  /** What was returned: discriminated kind + the effective approvalId. */
  result:
    | { kind: "persisted"; approvalId: string }
    | { kind: "reused"; approvalId: string }
    | { kind: "skipped"; reason: string; approvalId: string };
  /** State on disk AFTER the call. Stripped of __schemaVersion + updatedAt
   *  for stable diff (those are derived/timestamp-dependent and don't
   *  participate in cross-impl parity — only structural fields do). */
  stateAfter: Omit<PlanModeSessionState, "updatedAt"> & {
    updatedAt?: "<set>" | undefined;
  } | null;
  /** Did the runner emit an audit event? Counts only — the in-host
   *  audit shape is a different object than the plugin's, so we compare
   *  by occurrence boolean (Invariant 4 + 9 cross-check). */
  auditEmitted: boolean;
}

/**
 * Normalize a state for stable cross-runner comparison. The
 * `updatedAt` field is a real-clock timestamp that differs between
 * runners; we replace its value with the marker `"<set>"` when present
 * and `undefined` when absent. All OTHER fields participate in the diff.
 */
export function normalizeState(
  state: PlanModeSessionState | undefined | null,
): ParityOutcome["stateAfter"] {
  if (!state) return null;
  const { updatedAt, ...rest } = state;
  return {
    ...rest,
    updatedAt: updatedAt != null ? ("<set>" as const) : undefined,
  };
}
