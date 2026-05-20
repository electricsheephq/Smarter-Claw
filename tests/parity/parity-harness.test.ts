/**
 * Vitest wrapper around the parity harness.
 *
 * Runs every registered Layer-1 check and asserts ZERO byte-level
 * drift from the in-host reference. CI gate: `pnpm test` AND the
 * dedicated `pnpm parity-harness` script both fail on any divergence.
 *
 * # Per-check it() blocks
 *
 * Wave-2 expansion: each check gets its own `it()` block so a failure
 * cluster surfaces against the OWNING surface — not a single
 * aggregated `it()` that hides what diverged. The bottom sanity
 * `it()` cross-checks aggregate counts.
 */

import { describe, expect, it } from "vitest";
import { runParityCheck } from "../../parity-harness/diff.js";
import type { CheckReport } from "../../parity-harness/checks/types.js";

const REPORT_PROMISE = runParityCheck();

async function getCheckReport(name: string): Promise<CheckReport> {
  const report = await REPORT_PROMISE;
  const found = report.checkReports.find((r) => r.name === name);
  if (!found) {
    throw new Error(
      `Layer-1 parity-harness has no check named "${name}". Registered: ${report.checkReports
        .map((r) => r.name)
        .join(", ")}`,
    );
  }
  return found;
}

function assertReportClean(report: CheckReport): void {
  const failing = report.cases.filter((c) => !c.ok);
  if (failing.length > 0) {
    const detail = failing
      .map(
        (f) =>
          `\n  ✗ ${f.caseId}: ${f.description}\n    ${f.diff}`,
      )
      .join("");
    throw new Error(
      `Parity check [${report.name}]: ${failing.length}/${report.cases.length} cases diverged from in-host reference.\n${detail}`,
    );
  }
}

describe("Layer-1 parity harness — persistApprovalRequest", () => {
  it("plugin's PlanModeStore.persistApprovalRequest matches in-host across all cases", async () => {
    const r = await getCheckReport("persistApprovalRequest");
    expect(r.cases.length).toBeGreaterThanOrEqual(10);
    assertReportClean(r);
  });
});

describe("Layer-1 parity harness — resolvePlanApproval", () => {
  it("plugin's resolvePlanApproval matches in-host across all cases", async () => {
    const r = await getCheckReport("resolvePlanApproval");
    expect(r.cases.length).toBeGreaterThanOrEqual(10);
    assertReportClean(r);
  });
});

describe("Layer-1 parity harness — acceptEditsGate", () => {
  it("plugin's checkAcceptEditsConstraint matches in-host across destructive / self-restart / config-change / protected-path cases", async () => {
    const r = await getCheckReport("acceptEditsGate");
    expect(r.cases.length).toBeGreaterThanOrEqual(25);
    assertReportClean(r);
  });
});

describe("Layer-1 parity harness — escalatingRetry", () => {
  it("plugin's escalating-retry resolvers + constant strings match in-host byte-for-byte", async () => {
    const r = await getCheckReport("escalatingRetry");
    expect(r.cases.length).toBeGreaterThanOrEqual(20);
    assertReportClean(r);
  });
});

describe("Layer-1 parity harness — sanitizeAndApprovalId", () => {
  it("plugin's sanitizeFeedbackForInjection + newPlanApprovalId match in-host", async () => {
    const r = await getCheckReport("sanitizeAndApprovalId");
    expect(r.cases.length).toBeGreaterThanOrEqual(15);
    assertReportClean(r);
  });
});

describe("Layer-1 parity harness — prompts (closes W1-D3)", () => {
  it("plugin's prompt artifacts match in-host byte fixtures (closes W1-D3 — no byte fixture pinned prompts before)", async () => {
    const r = await getCheckReport("prompts");
    // 4 fixtures: PLAN_ARCHETYPE_PROMPT, PLAN_MODE_REFERENCE_CARD,
    // plan-mode-active, plan-mode-available.
    expect(r.cases.length).toBe(4);
    assertReportClean(r);
  });
});

describe("Layer-1 parity harness — mutationGate", () => {
  it("plugin's checkMutationGate matches in-host across allowlist / blocklist / exec-prefix / dangerous-flag / suffix-pattern cases", async () => {
    const r = await getCheckReport("mutationGate");
    expect(r.cases.length).toBeGreaterThanOrEqual(25);
    assertReportClean(r);
  });
});

describe("Layer-1 parity harness — runtimeRejectAndPlanSteps (bonus W1-D1 + W1-D2)", () => {
  it("buildPlanRuntimeRejectInjection + planStepsToInjectionLines match in-host", async () => {
    const r = await getCheckReport("runtimeRejectAndPlanSteps");
    expect(r.cases.length).toBeGreaterThanOrEqual(10);
    assertReportClean(r);
  });
});

describe("Layer-1 parity harness — planRender (closes W6-2)", () => {
  it("plugin's renderFullPlanArchetypeMarkdown matches in-host across curated input matrix (closes W6-2 — no byte-fixture pinned the W1-F2 persister renderer before)", async () => {
    const r = await getCheckReport("planRender");
    // 6 curated cases: minimal, full-archetype, markdown-escape,
    // mention-neutralization, edge-cases, and title-and-steps-only.
    expect(r.cases.length).toBeGreaterThanOrEqual(6);
    assertReportClean(r);
  });
});

describe("Layer-1 parity harness — aggregate", () => {
  it("total case count meets the wave-2 floor + every case is parity-clean", async () => {
    const report = await REPORT_PROMISE;
    if (report.failingCases > 0) {
      // Re-raise via the per-check assertions; this is the safety net
      // if a new check is added but its describe block was forgotten.
      const failing = report.checkReports.flatMap((r) =>
        r.cases.filter((c) => !c.ok).map((c) => `[${r.name}] ${c.caseId}`),
      );
      throw new Error(
        `Aggregate failure: ${report.failingCases}/${report.totalCases} cases diverged. Affected: ${failing.join(", ")}`,
      );
    }
    expect(report.failingCases).toBe(0);
    expect(report.passingCases).toBe(report.totalCases);
    // Wave-2 floor: the harness must have at least the persist + 7 new
    // checks worth of cases (~100 total) so the CI gate has real teeth.
    // Wave-6 floor: floor unchanged — the new planRender check adds
    // ~6 cases for ~162+ total, but the floor is a minimum, not a pin.
    expect(report.totalCases).toBeGreaterThanOrEqual(100);
  });
});
