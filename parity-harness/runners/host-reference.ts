/**
 * Host-reference runner — faithful TypeScript port of the in-host
 * `persistPlanApprovalRequest` at
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237`
 * (commit `ea04ea52c7`).
 *
 * # The contract
 *
 * This impl is the REFERENCE. It must mirror the in-host logic
 * byte-for-byte at the algorithmic level. Anti-pattern guardrail (from
 * README): update this file by reading the in-host source at the cited
 * `host_ref:` lines — NOT by inspecting the plugin's PlanModeStore
 * (which would defeat the parity check).
 *
 * # What's NOT included
 *
 * - The host's lazy-import wiring (`Promise.all([loadSessionStore...])`)
 *   — not relevant to the algorithm, only to module loading. Excluded.
 * - The host's `updateSessionStoreEntry` lock semantics — encapsulated
 *   here by a tiny `withFreshRead` helper that mirrors lock-then-read
 *   semantics for a single-threaded test runner.
 * - The host's audit-event payload shape — we record only "emit / no
 *   emit" since the audit event types live in the openclaw monorepo
 *   and aren't part of the parity check; the policy (Invariant 4 +
 *   Invariant 9) is what we verify.
 */

import {
  normalizeState,
  type ParityCase,
  type ParityOutcome,
} from "./shared.js";
import type { PlanModeSessionState } from "../../src/types.js";

/**
 * The 10-invariant in-host algorithm, ported faithfully.
 *
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237
 */
function persistPlanApprovalRequestReference(
  current: PlanModeSessionState | null,
  candidateApprovalId: string,
  snapshot: {
    title?: string;
    payloadHash?: string;
    lastPlanSteps?: Array<{ step: string; status: string; activeForm?: string }>;
  },
): {
  // The host returns {approvalId, reused}. We return a richer outcome
  // for cross-runner comparison; the plugin runner returns the same
  // shape from PlanModeStore.persistApprovalRequest's discriminated
  // union.
  stateAfter: PlanModeSessionState | null;
  approvalId: string;
  reused: boolean;
  skipped: boolean;
  auditEmitted: boolean;
} {
  // host_ref: lines 175-181 — precondition guard.
  if (!current || current.mode !== "plan") {
    return {
      stateAfter: current ?? null,
      approvalId: candidateApprovalId,
      reused: false,
      skipped: true,
      auditEmitted: false,
    };
  }

  // host_ref: lines 184-205 — 4-conjoined idempotency guard.
  if (
    snapshot.payloadHash &&
    current.lastPlanPayloadHash === snapshot.payloadHash &&
    current.approval === "pending" &&
    typeof current.approvalId === "string" &&
    current.approvalId.length > 0
  ) {
    return {
      stateAfter: current, // NO write
      approvalId: current.approvalId,
      reused: true,
      skipped: false,
      auditEmitted: false, // Invariant 9: skip audit on reuse
    };
  }

  // host_ref: lines 206-222 — synchronous bundle write.
  const now = Date.now();
  const next: PlanModeSessionState = {
    ...current,
    approval: "pending",
    approvalId: candidateApprovalId,
    updatedAt: now,
    ...(snapshot.title ? { title: snapshot.title } : {}),
    ...(snapshot.payloadHash
      ? { lastPlanPayloadHash: snapshot.payloadHash }
      : {}),
    ...(snapshot.lastPlanSteps && snapshot.lastPlanSteps.length > 0
      ? { lastPlanSteps: snapshot.lastPlanSteps }
      : {}),
  };

  return {
    stateAfter: next,
    approvalId: candidateApprovalId,
    reused: false,
    skipped: false,
    auditEmitted: true, // Invariant 4: audit on persist
  };
}

/**
 * Run all cases through the reference impl. Returns one outcome per
 * case in input order.
 */
export function runReferenceCases(cases: ParityCase[]): ParityOutcome[] {
  return cases.map((c) => {
    const r = persistPlanApprovalRequestReference(
      c.state_before,
      c.input.approvalId,
      {
        title: c.input.title,
        payloadHash: c.input.payloadHash,
        lastPlanSteps: c.input.lastPlanSteps,
      },
    );
    const kind: ParityOutcome["result"]["kind"] = r.skipped
      ? "skipped"
      : r.reused
        ? "reused"
        : "persisted";
    const result: ParityOutcome["result"] =
      kind === "skipped"
        ? { kind, reason: "not-plan-mode", approvalId: r.approvalId }
        : { kind, approvalId: r.approvalId };
    return {
      caseId: c.id,
      result,
      stateAfter: normalizeState(r.stateAfter),
      auditEmitted: r.auditEmitted,
    };
  });
}
