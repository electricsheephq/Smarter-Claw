/**
 * Parity diff CLI. Runs both runners over `inputs/persistApprovalRequest.json`,
 * compares per-case outcomes, prints a report, exits non-zero on any
 * divergence.
 *
 * Usage:
 *   pnpm parity-harness
 *
 * The vitest integration test (`tests/parity/parity-harness.test.ts`)
 * runs the same diff and fails CI on divergence; this CLI is for
 * humans debugging locally.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runReferenceCases } from "./runners/host-reference.js";
import { runPluginCases } from "./runners/plugin-under-test.js";
import type { ParityCase, ParityOutcome } from "./runners/shared.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function loadCases(): ParityCase[] {
  const path = join(__dirname, "inputs", "persistApprovalRequest.json");
  return JSON.parse(readFileSync(path, "utf8")) as ParityCase[];
}

export interface ParityReport {
  totalCases: number;
  passingCases: number;
  failingCases: number;
  failures: Array<{
    caseId: string;
    description: string;
    reference: ParityOutcome;
    plugin: ParityOutcome;
    diffSummary: string;
  }>;
}

export async function runParityCheck(): Promise<ParityReport> {
  const cases = loadCases();
  const referenceOutcomes = runReferenceCases(cases);
  const pluginOutcomes = await runPluginCases(cases);

  const failures: ParityReport["failures"] = [];
  for (let i = 0; i < cases.length; i++) {
    const ref = referenceOutcomes[i]!;
    const plug = pluginOutcomes[i]!;
    const diff = computeDiff(ref, plug);
    if (diff) {
      failures.push({
        caseId: cases[i]!.id,
        description: cases[i]!.description,
        reference: ref,
        plugin: plug,
        diffSummary: diff,
      });
    }
  }

  return {
    totalCases: cases.length,
    passingCases: cases.length - failures.length,
    failingCases: failures.length,
    failures,
  };
}

/**
 * Compare two parity outcomes. Returns null when identical, or a
 * human-readable diff summary string.
 *
 * NOT a full structural diff — we look at the specific fields that
 * matter for parity:
 *   - result.kind
 *   - result.approvalId
 *   - result.reason (for skipped)
 *   - stateAfter (deep equality)
 *   - auditEmitted
 */
function computeDiff(
  ref: ParityOutcome,
  plug: ParityOutcome,
): string | null {
  const issues: string[] = [];
  if (ref.result.kind !== plug.result.kind) {
    issues.push(`kind: reference=${ref.result.kind}, plugin=${plug.result.kind}`);
  }
  if (ref.result.approvalId !== plug.result.approvalId) {
    issues.push(
      `approvalId: reference=${ref.result.approvalId}, plugin=${plug.result.approvalId}`,
    );
  }
  if (
    ref.result.kind === "skipped" &&
    plug.result.kind === "skipped" &&
    ref.result.reason !== plug.result.reason
  ) {
    issues.push(
      `skipped reason: reference=${ref.result.reason}, plugin=${plug.result.reason}`,
    );
  }
  if (ref.auditEmitted !== plug.auditEmitted) {
    issues.push(
      `auditEmitted: reference=${ref.auditEmitted}, plugin=${plug.auditEmitted}`,
    );
  }
  if (!deepEqual(ref.stateAfter, plug.stateAfter)) {
    issues.push(
      `stateAfter differs:\n      reference=${JSON.stringify(ref.stateAfter)}\n      plugin   =${JSON.stringify(plug.stateAfter)}`,
    );
  }
  return issues.length > 0 ? issues.join("\n    ") : null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a as object).sort();
  const bk = Object.keys(b as object).sort();
  if (ak.length !== bk.length) return false;
  if (!ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
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
          `[parity-harness] ✓ ${report.passingCases}/${report.totalCases} cases parity-clean`,
        );
        process.exit(0);
      }
      console.log(
        `[parity-harness] ✗ ${report.failingCases}/${report.totalCases} cases diverged:`,
      );
      for (const f of report.failures) {
        console.log(`  - ${f.caseId}: ${f.description}`);
        console.log(`    ${f.diffSummary}`);
      }
      process.exit(1);
    })
    .catch((err) => {
      console.error("[parity-harness] crashed:", err);
      process.exit(2);
    });
}
