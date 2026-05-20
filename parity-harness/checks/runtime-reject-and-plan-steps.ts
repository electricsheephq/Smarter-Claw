/**
 * Layer-1 check: bonus targets from the wave brief.
 *
 *   - `buildPlanRuntimeRejectInjection` — the runtime reject text
 *     emitter ported in W1-D1. Pinning prevents future drift back to
 *     the wrong (verbose, JSON-quoted) `buildPlanDecisionInjection`
 *     form.
 *
 *   - `planStepsToInjectionLines` — the activeForm-vs-status logic
 *     just fixed in W1-D2. Pinning prevents regression to the wrong
 *     parenthetical label on resumed/re-approved plans.
 *
 * host_ref:
 *   - sessions-patch.ts:1045-1050 (reject form)
 *   - sessions-patch.ts:1001-1003 (planSteps → lines)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlanRuntimeRejectInjection } from "../../src/runtime/injection-writer.js";
import type { PlanStep } from "../../src/types.js";
import { planStepsToInjectionLines } from "../../src/ui/session-actions.js";
import {
  buildPlanRuntimeRejectInjectionReference,
  planStepsToInjectionLinesReference,
} from "../runners/runtime-reject-and-plan-steps.reference.js";
import type { CheckCaseResult, CheckReport, ParityCheck } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RuntimeRejectCase {
  id: string;
  description: string;
  kind: "runtimeReject";
  feedback: string | null;
}

interface PlanStepsCase {
  id: string;
  description: string;
  kind: "planSteps";
  steps: PlanStep[];
}

type Case = RuntimeRejectCase | PlanStepsCase;

function loadCases(): Case[] {
  const path = join(__dirname, "..", "inputs", "runtimeRejectAndPlanSteps.json");
  return JSON.parse(readFileSync(path, "utf8")) as Case[];
}

function diffStrings(plug: string, ref: string): string {
  if (plug === ref) return "";
  return [
    "outputs differ:",
    `      plugin   =${JSON.stringify(plug)}`,
    `      reference=${JSON.stringify(ref)}`,
  ].join("\n    ");
}

function diffStringArrays(plug: string[], ref: string[]): string {
  if (plug.length !== ref.length) {
    return `length differs: plugin=${plug.length}, reference=${ref.length}`;
  }
  for (let i = 0; i < plug.length; i++) {
    if (plug[i] !== ref[i]) {
      return [
        `arrays differ at index ${i}:`,
        `      plugin   =${JSON.stringify(plug[i])}`,
        `      reference=${JSON.stringify(ref[i])}`,
      ].join("\n    ");
    }
  }
  return "";
}

export const runtimeRejectAndPlanStepsCheck: ParityCheck = {
  name: "runtimeRejectAndPlanSteps",
  run(): CheckReport {
    const cases = loadCases();
    const results: CheckCaseResult[] = cases.map((c) => {
      if (c.kind === "runtimeReject") {
        const feedbackArg = c.feedback === null ? undefined : c.feedback;
        const plug = buildPlanRuntimeRejectInjection(feedbackArg);
        const ref = buildPlanRuntimeRejectInjectionReference(feedbackArg);
        const diff = diffStrings(plug, ref);
        return {
          caseId: c.id,
          description: c.description,
          ok: diff === "",
          diff,
        };
      }
      // planSteps
      const plug = planStepsToInjectionLines(c.steps);
      const ref = planStepsToInjectionLinesReference(c.steps);
      const diff = diffStringArrays(plug, ref);
      return {
        caseId: c.id,
        description: c.description,
        ok: diff === "",
        diff,
      };
    });
    return { name: "runtimeRejectAndPlanSteps", cases: results };
  },
};
