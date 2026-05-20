/**
 * Layer-1 check: `checkMutationGate` (plan-mode mutation gate).
 *
 * Drives both the plugin's `src/gates/mutation-gate.ts:checkMutationGate`
 * AND the vendored in-host reference at
 * `runners/mutation-gate.reference.ts` across the case table at
 * `inputs/mutationGate.json`. The gate is fail-CLOSED in plan mode —
 * diverging from in-host risks either over-blocking (UX regression) or
 * under-blocking (security regression).
 *
 * host_ref: src/agents/plan-mode/mutation-gate.ts (commit ea04ea52c7)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMutationGate as pluginGate } from "../../src/gates/mutation-gate.js";
import type { PlanMode } from "../../src/types.js";
import { checkMutationGate as hostGate } from "../runners/mutation-gate.reference.js";
import type { CheckCaseResult, CheckReport, ParityCheck } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MutationGateCase {
  id: string;
  description: string;
  toolName: string;
  currentMode: PlanMode;
  execCommand?: string;
}

function loadCases(): MutationGateCase[] {
  const path = join(__dirname, "..", "inputs", "mutationGate.json");
  return JSON.parse(readFileSync(path, "utf8")) as MutationGateCase[];
}

export const mutationGateCheck: ParityCheck = {
  name: "mutationGate",
  run(): CheckReport {
    const cases = loadCases();
    const results: CheckCaseResult[] = cases.map((c) => {
      const ref = hostGate(c.toolName, c.currentMode, c.execCommand);
      const plug = pluginGate(c.toolName, c.currentMode, c.execCommand);
      const ok = ref.blocked === plug.blocked && ref.reason === plug.reason;
      const diff = ok
        ? ""
        : [
            "outputs differ:",
            `      reference=${JSON.stringify(ref)}`,
            `      plugin   =${JSON.stringify(plug)}`,
          ].join("\n    ");
      return {
        caseId: c.id,
        description: c.description,
        ok,
        diff,
      };
    });
    return { name: "mutationGate", cases: results };
  },
};
