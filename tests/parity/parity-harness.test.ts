/**
 * Vitest wrapper around the parity harness.
 *
 * Runs every case in `inputs/persistApprovalRequest.json` through both
 * runners and asserts byte-identical outcomes. CI gate: `pnpm test`
 * fails on any drift.
 *
 * This test is intentionally one-massive-assertion: a per-case loop
 * with descriptive failure messages so the report shows EVERY case
 * that diverged, not just the first.
 */

import { describe, expect, it } from "vitest";
import { runParityCheck } from "../../parity-harness/diff.js";

describe("P-3.5 parity harness — Layer 1 (persistApprovalRequest)", () => {
  it("plugin's PlanModeStore matches the in-host reference across all input cases", async () => {
    const report = await runParityCheck();

    if (report.failingCases > 0) {
      const detail = report.failures
        .map(
          (f) =>
            `\n  ✗ ${f.caseId}: ${f.description}\n    ${f.diffSummary}`,
        )
        .join("");
      throw new Error(
        `Parity harness Layer 1: ${report.failingCases}/${report.totalCases} cases diverged from in-host reference.\n${detail}`,
      );
    }

    expect(report.failingCases).toBe(0);
    expect(report.passingCases).toBe(report.totalCases);
    expect(report.totalCases).toBeGreaterThanOrEqual(10); // sanity: input table must have ≥10 cases
  });
});
