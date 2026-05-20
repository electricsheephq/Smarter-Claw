/**
 * Layer-1 check: `resolvePlanApproval`.
 *
 * Drives the plugin's `src/plan-mode/approval.ts:resolvePlanApproval`
 * AND the vendored in-host reference at
 * `runners/resolve-plan-approval.reference.ts` across the case table
 * at `inputs/resolvePlanApproval.json`. Diffs structural fields.
 *
 * # Determinism
 *
 * The plugin's `resolvePlanApproval` calls `Date.now()` directly; the
 * reference accepts an injected `now`. To keep the diff deterministic
 * we pin a FROZEN_NOW value for the reference, and call the plugin
 * under `vi.useFakeTimers()`-style monkey patching of `Date.now`. The
 * harness does the monkey-patch itself (no test-framework dep) so the
 * CLI invocation and the vitest invocation both see the same value.
 *
 * host_ref: src/agents/plan-mode/approval.ts:36-145 (commit ea04ea52c7)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePlanApproval } from "../../src/plan-mode/approval.js";
import type { PlanModeSessionState } from "../../src/types.js";
import { resolvePlanApprovalReference } from "../runners/resolve-plan-approval.reference.js";
import type { CheckCaseResult, CheckReport, ParityCheck } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ResolvePlanApprovalCase {
  id: string;
  description: string;
  state_before: PlanModeSessionState;
  action: "approve" | "edit" | "reject" | "timeout";
  feedback?: string;
  expectedApprovalId?: string;
}

const FROZEN_NOW = 1_700_000_000_000;

function loadCases(): ResolvePlanApprovalCase[] {
  const path = join(__dirname, "..", "inputs", "resolvePlanApproval.json");
  return JSON.parse(readFileSync(path, "utf8")) as ResolvePlanApprovalCase[];
}

function withFrozenNow<T>(fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => FROZEN_NOW;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
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

export const resolvePlanApprovalCheck: ParityCheck = {
  name: "resolvePlanApproval",
  run(): CheckReport {
    const cases = loadCases();
    const results: CheckCaseResult[] = cases.map((c) => {
      const refOut = resolvePlanApprovalReference(
        c.state_before,
        c.action,
        c.feedback,
        c.expectedApprovalId,
        FROZEN_NOW,
      );
      const plugOut = withFrozenNow(() =>
        resolvePlanApproval(
          c.state_before,
          c.action,
          c.feedback,
          c.expectedApprovalId,
        ),
      );
      const ok = deepEqual(refOut, plugOut);
      const diff = ok
        ? ""
        : [
            "outputs differ:",
            `      reference=${JSON.stringify(refOut)}`,
            `      plugin   =${JSON.stringify(plugOut)}`,
          ].join("\n    ");
      return {
        caseId: c.id,
        description: c.description,
        ok,
        diff,
      };
    });
    return { name: "resolvePlanApproval", cases: results };
  },
};
