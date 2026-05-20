/**
 * Parity diff CLI — Layer 1.
 *
 * Drives a registered list of checks (each pinning one plugin surface
 * against an in-host reference), aggregates results, prints a
 * structured report, and exits non-zero on any divergence.
 *
 * Usage:
 *   pnpm parity-harness
 *
 * The vitest wrapper (`tests/parity/parity-harness.test.ts`) runs the
 * same `runParityCheck()` and fails CI on divergence. The CLI is for
 * humans debugging locally.
 *
 * # Adding a check
 *
 * 1. Build `parity-harness/checks/<name>.ts` exporting a `ParityCheck`.
 * 2. Add it to `ALL_CHECKS` below.
 * 3. Re-run `pnpm parity-harness`. The new check's cases must pass.
 *
 * # When a check goes RED
 *
 * Two paths:
 *   - Drift in `src/` → fix `src/` to match the in-host reference.
 *   - Drift in the in-host source itself → re-capture the vendored
 *     reference (or snapshot file) from `git -C ... show ea04ea52c7:...`
 *     and commit the new bytes alongside the plugin's matching update.
 *
 * NEVER edit a vendored reference / snapshot to match a buggy plugin —
 * that defeats the parity check.
 */

import { acceptEditsGateCheck } from "./checks/accept-edits-gate.js";
import { escalatingRetryCheck } from "./checks/escalating-retry.js";
import { mutationGateCheck } from "./checks/mutation-gate.js";
import { persistApprovalRequestCheck } from "./checks/persist-approval-request.js";
import { promptsCheck } from "./checks/prompts.js";
import { resolvePlanApprovalCheck } from "./checks/resolve-plan-approval.js";
import { runtimeRejectAndPlanStepsCheck } from "./checks/runtime-reject-and-plan-steps.js";
import { sanitizeAndApprovalIdCheck } from "./checks/sanitize-and-approval-id.js";
import type { CheckReport, ParityCheck } from "./checks/types.js";

const ALL_CHECKS: ParityCheck[] = [
  persistApprovalRequestCheck,
  resolvePlanApprovalCheck,
  acceptEditsGateCheck,
  escalatingRetryCheck,
  sanitizeAndApprovalIdCheck,
  promptsCheck,
  mutationGateCheck,
  // Bonus targets (W1-D1 + W1-D2):
  runtimeRejectAndPlanStepsCheck,
];

export interface ParityReport {
  totalCases: number;
  passingCases: number;
  failingCases: number;
  checkReports: CheckReport[];
}

export async function runParityCheck(): Promise<ParityReport> {
  const checkReports = await Promise.all(
    ALL_CHECKS.map(async (c) => c.run()),
  );
  let totalCases = 0;
  let passingCases = 0;
  let failingCases = 0;
  for (const r of checkReports) {
    for (const c of r.cases) {
      totalCases++;
      if (c.ok) passingCases++;
      else failingCases++;
    }
  }
  return { totalCases, passingCases, failingCases, checkReports };
}

function summarizeFailure(checkName: string, caseId: string, description: string, diff: string): string {
  return `  ✗ [${checkName}] ${caseId}: ${description}\n    ${diff}`;
}

// ────────────────────────────────────────────────────────────────────
// CLI entry — exits non-zero on any divergence so CI can gate.
// ────────────────────────────────────────────────────────────────────

const isCliRun = import.meta.url === `file://${process.argv[1]}`;
if (isCliRun) {
  runParityCheck()
    .then((report) => {
      if (report.failingCases === 0) {
        console.log(
          `[parity-harness] ✓ ${report.passingCases}/${report.totalCases} cases parity-clean across ${report.checkReports.length} checks`,
        );
        for (const r of report.checkReports) {
          console.log(`  ✓ ${r.name}: ${r.cases.length} cases`);
        }
        process.exit(0);
      }
      console.log(
        `[parity-harness] ✗ ${report.failingCases}/${report.totalCases} cases diverged:`,
      );
      for (const r of report.checkReports) {
        const failing = r.cases.filter((c) => !c.ok);
        if (failing.length === 0) {
          console.log(`  ✓ ${r.name}: ${r.cases.length}/${r.cases.length}`);
          continue;
        }
        console.log(`  ✗ ${r.name}: ${failing.length}/${r.cases.length} failing`);
        for (const f of failing) {
          console.log(summarizeFailure(r.name, f.caseId, f.description, f.diff));
        }
      }
      process.exit(1);
    })
    .catch((err) => {
      console.error("[parity-harness] crashed:", err);
      process.exit(2);
    });
}
