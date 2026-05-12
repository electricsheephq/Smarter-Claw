/**
 * Plugin-under-test runner — drives the actual PlanModeStore over the
 * shared input table, captures outputs as ParityOutcome for diff.
 *
 * If this runner's outputs diverge from `host-reference.ts`, the
 * plugin has drifted from the in-host contract.
 */

import { PlanModeStore } from "../../src/state/store.js";
import type { PlanModeSessionState } from "../../src/types.js";
import { InMemoryGateway } from "../../tests/state/in-memory-gateway.js";
import {
  normalizeState,
  type ParityCase,
  type ParityOutcome,
} from "./shared.js";

export async function runPluginCases(
  cases: ParityCase[],
): Promise<ParityOutcome[]> {
  const outcomes: ParityOutcome[] = [];
  for (const c of cases) {
    const gw = new InMemoryGateway();
    let auditCount = 0;
    const store = new PlanModeStore(gw, undefined, () => {
      auditCount++;
    });
    if (c.state_before) {
      gw.seed(c.input.sessionKey, c.state_before);
    }
    const r = await store.persistApprovalRequest({
      sessionKey: c.input.sessionKey,
      approvalId: c.input.approvalId,
      title: c.input.title,
      payloadHash: c.input.payloadHash,
      lastPlanSteps: c.input.lastPlanSteps,
    });
    // Map plugin discriminated-union → shared parity outcome shape.
    let result: ParityOutcome["result"];
    switch (r.kind) {
      case "persisted":
      case "reused":
        result = { kind: r.kind, approvalId: r.approvalId };
        break;
      case "skipped":
        result = {
          kind: "skipped",
          reason: r.reason,
          approvalId: r.approvalId,
        };
        break;
      case "failed":
        // Failed is plugin-only (IO error). The in-host reference
        // can't model this because the in-host swallows IO into a
        // candidate-return path silently. We map failed→skipped for
        // the shared shape so parity-harness can flag the divergence;
        // P-3.5's inputs.json doesn't include failure cases.
        result = {
          kind: "skipped",
          reason: "io-failed",
          approvalId: r.approvalId,
        };
        break;
    }

    // Capture state-after via the gateway peek. Strip __schemaVersion
    // for the comparison — the reference impl doesn't stamp the
    // version field (it's a plugin-side concern; the host doesn't
    // care). Including it here would create a noise diff.
    const peekedRaw = gw.peek(c.input.sessionKey);
    let peeked: PlanModeSessionState | undefined;
    if (peekedRaw) {
      const { __schemaVersion: _omit, ...rest } = peekedRaw as PlanModeSessionState & {
        __schemaVersion?: number;
      };
      peeked = rest as PlanModeSessionState;
    } else {
      peeked = undefined;
    }

    outcomes.push({
      caseId: c.id,
      result,
      stateAfter: normalizeState(peeked ?? null),
      auditEmitted: auditCount > 0,
    });
  }
  return outcomes;
}
