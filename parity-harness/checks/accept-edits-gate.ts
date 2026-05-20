/**
 * Layer-1 check: `checkAcceptEditsConstraint` (accept-edits gate).
 *
 * Drives both the plugin's `src/gates/accept-edits-gate.ts` AND the
 * vendored in-host reference at
 * `runners/accept-edits-gate.reference.ts` across the case table at
 * `inputs/acceptEditsGate.json`. The gate is a fail-OPEN security
 * boundary — diverging from in-host means either over-blocking (UX
 * regression) or under-blocking (security regression).
 *
 * host_ref: src/agents/plan-mode/accept-edits-gate.ts (commit ea04ea52c7)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAcceptEditsConstraint as pluginCheck } from "../../src/gates/accept-edits-gate.js";
import { checkAcceptEditsConstraint as hostCheck } from "../runners/accept-edits-gate.reference.js";
import type { CheckCaseResult, CheckReport, ParityCheck } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface AcceptEditsGateCase {
  id: string;
  description: string;
  toolName: string;
  execCommand?: string;
  filePath?: string;
  additionalPaths?: string[];
}

function loadCases(): AcceptEditsGateCase[] {
  const path = join(__dirname, "..", "inputs", "acceptEditsGate.json");
  return JSON.parse(readFileSync(path, "utf8")) as AcceptEditsGateCase[];
}

export const acceptEditsGateCheck: ParityCheck = {
  name: "acceptEditsGate",
  run(): CheckReport {
    const cases = loadCases();
    const results: CheckCaseResult[] = cases.map((c) => {
      const params = {
        toolName: c.toolName,
        execCommand: c.execCommand,
        filePath: c.filePath,
        additionalPaths: c.additionalPaths,
      };
      const refOut = hostCheck(params);
      const plugOut = pluginCheck(params);
      // Compare blocked + constraint + reason (the exact bytes
      // returned to the runtime).
      const ok =
        refOut.blocked === plugOut.blocked &&
        refOut.constraint === plugOut.constraint &&
        refOut.reason === plugOut.reason;
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
    return { name: "acceptEditsGate", cases: results };
  },
};
