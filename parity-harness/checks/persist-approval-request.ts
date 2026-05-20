/**
 * Layer-1 check: `PlanModeStore.persistApprovalRequest`.
 *
 * Wraps the existing `runners/host-reference.ts` + `runners/plugin-under-test.ts`
 * pair as a uniform `ParityCheck`. The input table at
 * `inputs/persistApprovalRequest.json` carries 11 cases covering the
 * 10-invariant in-host algorithm.
 *
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237
 *   (commit ea04ea52c7) — the in-host `persistPlanApprovalRequest`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runReferenceCases } from "../runners/host-reference.js";
import { runPluginCases } from "../runners/plugin-under-test.js";
import type { ParityCase, ParityOutcome } from "../runners/shared.js";
import type { CheckCaseResult, CheckReport, ParityCheck } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadCases(): ParityCase[] {
  const path = join(__dirname, "..", "inputs", "persistApprovalRequest.json");
  return JSON.parse(readFileSync(path, "utf8")) as ParityCase[];
}

function computeDiff(ref: ParityOutcome, plug: ParityOutcome): string {
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
  return issues.join("\n    ");
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

export const persistApprovalRequestCheck: ParityCheck = {
  name: "persistApprovalRequest",
  async run(): Promise<CheckReport> {
    const cases = loadCases();
    const ref = runReferenceCases(cases);
    const plug = await runPluginCases(cases);
    const results: CheckCaseResult[] = cases.map((c, i) => {
      const diff = computeDiff(ref[i]!, plug[i]!);
      return {
        caseId: c.id,
        description: c.description,
        ok: diff.length === 0,
        diff,
      };
    });
    return { name: "persistApprovalRequest", cases: results };
  },
};
