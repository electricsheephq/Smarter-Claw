/**
 * Layer-1 check: `sanitizeFeedbackForInjection` + `newPlanApprovalId`
 * shape.
 *
 * `sanitize` is exhaustively case-tested against the vendored in-host
 * reference. `newPlanApprovalId` is a crypto-RNG-driven minter — we
 * verify the SHAPE (canonical `plan-<v4-uuid>` regex) across N
 * generated calls, NOT exact byte equality (the bytes are entropy by
 * construction).
 *
 * host_ref: src/agents/plan-mode/types.ts:104-160 (commit ea04ea52c7)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newPlanApprovalId, isPlanApprovalId } from "../../src/helpers/approval-id.js";
import { sanitizeFeedbackForInjection } from "../../src/helpers/sanitize.js";
import {
  PLAN_APPROVAL_ID_SHAPE_REF,
  sanitizeFeedbackForInjectionReference,
} from "../runners/sanitize-and-approval-id.reference.js";
import type { CheckCaseResult, CheckReport, ParityCheck } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SanitizeCase {
  id: string;
  description: string;
  raw: string;
}

function loadSanitizeCases(): SanitizeCase[] {
  const path = join(__dirname, "..", "inputs", "sanitize.json");
  return JSON.parse(readFileSync(path, "utf8")) as SanitizeCase[];
}

function diffStrings(a: string, b: string): string {
  if (a === b) return "";
  return [
    "outputs differ:",
    `      plugin   =${JSON.stringify(a)}`,
    `      reference=${JSON.stringify(b)}`,
  ].join("\n    ");
}

export const sanitizeAndApprovalIdCheck: ParityCheck = {
  name: "sanitizeAndApprovalId",
  run(): CheckReport {
    const results: CheckCaseResult[] = [];

    // sanitize cases — exhaustive over the input table.
    const cases = loadSanitizeCases();
    for (const c of cases) {
      const plug = sanitizeFeedbackForInjection(c.raw);
      const ref = sanitizeFeedbackForInjectionReference(c.raw);
      const diff = diffStrings(plug, ref);
      results.push({
        caseId: `sanitize:${c.id}`,
        description: c.description,
        ok: diff === "",
        diff,
      });
    }

    // newPlanApprovalId — shape check across N mints. Each must
    // (a) match the canonical regex byte-for-byte, (b) start with the
    // `plan-` prefix, (c) round-trip through `isPlanApprovalId === true`,
    // and (d) NOT repeat (sanity check on entropy — should never see
    // a collision in 100 mints).
    const N = 100;
    const seen = new Set<string>();
    const shapeFailures: string[] = [];
    const isPlanApprovalIdFailures: string[] = [];
    let collisions = 0;
    for (let i = 0; i < N; i++) {
      const id = newPlanApprovalId();
      if (seen.has(id)) {
        collisions++;
      }
      seen.add(id);
      if (!PLAN_APPROVAL_ID_SHAPE_REF.test(id)) {
        shapeFailures.push(id);
      }
      if (!isPlanApprovalId(id)) {
        isPlanApprovalIdFailures.push(id);
      }
    }
    results.push({
      caseId: "approvalId:shape-regex-N-mints",
      description: `Every newPlanApprovalId() result must match /^plan-<v4-uuid>$/ (${N} samples)`,
      ok: shapeFailures.length === 0,
      diff:
        shapeFailures.length === 0
          ? ""
          : `${shapeFailures.length}/${N} failed the canonical-shape regex. Examples: ${JSON.stringify(shapeFailures.slice(0, 3))}`,
    });
    results.push({
      caseId: "approvalId:isPlanApprovalId-round-trip-N-mints",
      description: `Every newPlanApprovalId() result must pass isPlanApprovalId (${N} samples)`,
      ok: isPlanApprovalIdFailures.length === 0,
      diff:
        isPlanApprovalIdFailures.length === 0
          ? ""
          : `${isPlanApprovalIdFailures.length}/${N} failed the isPlanApprovalId round-trip. Examples: ${JSON.stringify(isPlanApprovalIdFailures.slice(0, 3))}`,
    });
    results.push({
      caseId: "approvalId:entropy-sanity-no-collisions",
      description: `Across ${N} mints, no two approvalIds should collide (sanity check on crypto-RNG path)`,
      ok: collisions === 0,
      diff: collisions === 0 ? "" : `${collisions} collisions across ${N} mints — entropy source is broken`,
    });

    // isPlanApprovalId — negative cases (the regex is the contract;
    // a divergence here would silently fail-open staleness checks).
    // Negative cases — both reference regex AND plugin's isPlanApprovalId
    // must reject these. The plugin's regex (intentionally) does NOT
    // assert v4-version or variant nibbles; it just shape-checks the
    // canonical 8-4-4-4-12 lowercase-hex form. So negative cases here
    // are limited to actually-invalid shapes: wrong prefix, uppercase
    // hex, truncated, non-string, etc.
    const negativeCases: Array<{ id: string; desc: string; value: unknown }> = [
      { id: "wrong-prefix", desc: "missing 'plan-' prefix", value: "00000000-0000-4000-8000-000000000001" },
      { id: "uppercase-hex", desc: "uppercase hex (the regex is lowercase-only)", value: "plan-AAAAAAAA-AAAA-4AAA-9AAA-AAAAAAAAAAAA" },
      { id: "wrong-length", desc: "truncated UUID", value: "plan-abc-def" },
      { id: "extra-segments", desc: "extra hex segment", value: "plan-00000000-0000-4000-8000-000000000001-extra" },
      { id: "non-string", desc: "non-string input", value: 12345 },
      { id: "null", desc: "null input", value: null },
      { id: "undefined", desc: "undefined input", value: undefined },
      { id: "empty-string", desc: "empty string", value: "" },
      { id: "trailing-whitespace", desc: "trailing whitespace breaks regex anchors", value: "plan-00000000-0000-4000-8000-000000000001 " },
    ];
    for (const nc of negativeCases) {
      const matchesShape = typeof nc.value === "string" && PLAN_APPROVAL_ID_SHAPE_REF.test(nc.value);
      const pluginAccepts = isPlanApprovalId(nc.value);
      const ok = matchesShape === pluginAccepts && pluginAccepts === false;
      results.push({
        caseId: `approvalId:negative-${nc.id}`,
        description: nc.desc,
        ok,
        diff: ok
          ? ""
          : `plugin isPlanApprovalId=${pluginAccepts}, reference regex test=${matchesShape}; both must be false for negative cases`,
      });
    }

    return { name: "sanitizeAndApprovalId", cases: results };
  },
};
