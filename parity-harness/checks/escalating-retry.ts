/**
 * Layer-1 check: escalating-retry instruction selection + constants.
 *
 * Pins all three resolvers (planning-retry, plan-ack-only, plan-yield)
 * across attempt 0/1/2/3 against the vendored in-host reference values.
 * Also pins each individual instruction constant byte-for-byte (so a
 * single-character drift in the bytes the agent sees is caught even if
 * the resolver shape is unchanged).
 *
 * # Why the constant checks live here, not in a separate prompt-bytes check
 *
 * The escalating-retry constants ARE prompt bytes — same byte-fixture
 * pattern as PLAN_ARCHETYPE_PROMPT. Combining the resolver dispatch
 * check with the byte-pinning check in ONE place keeps both side-by-
 * side; a drift in either fails the check.
 *
 * host_ref:
 *   - src/agents/pi-embedded-runner/run/incomplete-turn.ts:66-267 (constants)
 *   - src/agents/pi-embedded-runner/run/incomplete-turn.ts:731-739 (resolveEscalatingPlanningRetryInstruction)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACK_EXECUTION_FAST_PATH_INSTRUCTION,
  AUTO_CONTINUE_FAST_PATH_INSTRUCTION,
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT,
  DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT,
  DEFAULT_PLANNING_ONLY_RETRY_LIMIT,
  DEFAULT_REASONING_ONLY_RETRY_LIMIT,
  EMPTY_RESPONSE_RETRY_INSTRUCTION,
  PLAN_APPROVED_YIELD_RETRY_INSTRUCTION,
  PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM,
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION,
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM,
  PLAN_MODE_INVESTIGATIVE_TOOL_NAMES,
  PLANNING_ONLY_RETRY_INSTRUCTION,
  PLANNING_ONLY_RETRY_INSTRUCTION_FINAL,
  PLANNING_ONLY_RETRY_INSTRUCTION_FIRM,
  REASONING_ONLY_RETRY_INSTRUCTION,
  resolveEscalatingPlanAckOnlyInstruction,
  resolveEscalatingPlanningRetryInstruction,
  resolveEscalatingPlanYieldInstruction,
  STRICT_AGENTIC_BLOCKED_TEXT,
  STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT,
} from "../../src/runtime/escalating-retry-constants.js";
import {
  ACK_EXECUTION_FAST_PATH_INSTRUCTION_REF,
  AUTO_CONTINUE_FAST_PATH_INSTRUCTION_REF,
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT_REF,
  DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT_REF,
  DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT_REF,
  DEFAULT_PLANNING_ONLY_RETRY_LIMIT_REF,
  DEFAULT_REASONING_ONLY_RETRY_LIMIT_REF,
  EMPTY_RESPONSE_RETRY_INSTRUCTION_REF,
  PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM_REF,
  PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_REF,
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM_REF,
  PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_REF,
  PLAN_MODE_INVESTIGATIVE_TOOL_NAMES_REF,
  PLANNING_ONLY_RETRY_INSTRUCTION_FINAL_REF,
  PLANNING_ONLY_RETRY_INSTRUCTION_FIRM_REF,
  PLANNING_ONLY_RETRY_INSTRUCTION_REF,
  REASONING_ONLY_RETRY_INSTRUCTION_REF,
  resolveEscalatingPlanAckOnlyInstructionReference,
  resolveEscalatingPlanningRetryInstructionReference,
  resolveEscalatingPlanYieldInstructionReference,
  STRICT_AGENTIC_BLOCKED_TEXT_REF,
  STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT_REF,
} from "../runners/escalating-retry.reference.js";
import type { CheckCaseResult, CheckReport, ParityCheck } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface EscalatingRetryCase {
  id: string;
  description: string;
  resolver: "planning" | "planAckOnly" | "planYield";
  attemptIndex: number;
}

function loadCases(): EscalatingRetryCase[] {
  const path = join(__dirname, "..", "inputs", "escalatingRetry.json");
  return JSON.parse(readFileSync(path, "utf8")) as EscalatingRetryCase[];
}

function diffStrings(a: string, b: string): string {
  if (a === b) return "";
  if (a.length !== b.length) {
    return `length differs: plugin=${a.length}, reference=${b.length}`;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      const ctx = (s: string) =>
        JSON.stringify(s.slice(Math.max(0, i - 20), i + 20));
      return `first byte-diff at index ${i}: plugin=${ctx(a)}, reference=${ctx(b)}`;
    }
  }
  return "strings differ but no per-byte diff found (codepoint mismatch?)";
}

function arraysEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

export const escalatingRetryCheck: ParityCheck = {
  name: "escalatingRetry",
  run(): CheckReport {
    const cases = loadCases();
    const results: CheckCaseResult[] = [];

    // Resolver-shape cases (from the JSON input table).
    for (const c of cases) {
      let plug: string;
      let ref: string;
      switch (c.resolver) {
        case "planning":
          plug = resolveEscalatingPlanningRetryInstruction(c.attemptIndex);
          ref = resolveEscalatingPlanningRetryInstructionReference(c.attemptIndex);
          break;
        case "planAckOnly":
          plug = resolveEscalatingPlanAckOnlyInstruction(c.attemptIndex);
          ref = resolveEscalatingPlanAckOnlyInstructionReference(c.attemptIndex);
          break;
        case "planYield":
          plug = resolveEscalatingPlanYieldInstruction(c.attemptIndex);
          ref = resolveEscalatingPlanYieldInstructionReference(c.attemptIndex);
          break;
      }
      const diff = diffStrings(plug, ref);
      results.push({
        caseId: c.id,
        description: c.description,
        ok: diff === "",
        diff,
      });
    }

    // Constant byte-pin cases — every exported instruction string + limit
    // constant must match the reference. Generated programmatically so
    // adding a new constant is a one-line edit on both sides.
    const constPairs: Array<[string, string, string]> = [
      ["PLANNING_ONLY_RETRY_INSTRUCTION", PLANNING_ONLY_RETRY_INSTRUCTION, PLANNING_ONLY_RETRY_INSTRUCTION_REF],
      ["PLANNING_ONLY_RETRY_INSTRUCTION_FIRM", PLANNING_ONLY_RETRY_INSTRUCTION_FIRM, PLANNING_ONLY_RETRY_INSTRUCTION_FIRM_REF],
      ["PLANNING_ONLY_RETRY_INSTRUCTION_FINAL", PLANNING_ONLY_RETRY_INSTRUCTION_FINAL, PLANNING_ONLY_RETRY_INSTRUCTION_FINAL_REF],
      ["REASONING_ONLY_RETRY_INSTRUCTION", REASONING_ONLY_RETRY_INSTRUCTION, REASONING_ONLY_RETRY_INSTRUCTION_REF],
      ["EMPTY_RESPONSE_RETRY_INSTRUCTION", EMPTY_RESPONSE_RETRY_INSTRUCTION, EMPTY_RESPONSE_RETRY_INSTRUCTION_REF],
      ["ACK_EXECUTION_FAST_PATH_INSTRUCTION", ACK_EXECUTION_FAST_PATH_INSTRUCTION, ACK_EXECUTION_FAST_PATH_INSTRUCTION_REF],
      ["AUTO_CONTINUE_FAST_PATH_INSTRUCTION", AUTO_CONTINUE_FAST_PATH_INSTRUCTION, AUTO_CONTINUE_FAST_PATH_INSTRUCTION_REF],
      ["STRICT_AGENTIC_BLOCKED_TEXT", STRICT_AGENTIC_BLOCKED_TEXT, STRICT_AGENTIC_BLOCKED_TEXT_REF],
      ["PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION", PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION, PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_REF],
      ["PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM", PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM, PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION_FIRM_REF],
      ["PLAN_APPROVED_YIELD_RETRY_INSTRUCTION", PLAN_APPROVED_YIELD_RETRY_INSTRUCTION, PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_REF],
      ["PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM", PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM, PLAN_APPROVED_YIELD_RETRY_INSTRUCTION_FIRM_REF],
    ];
    for (const [name, plug, ref] of constPairs) {
      const diff = diffStrings(plug, ref);
      results.push({
        caseId: `const:${name}`,
        description: `constant ${name} must match in-host byte-for-byte`,
        ok: diff === "",
        diff,
      });
    }

    // Retry-limit numeric constants.
    const limitPairs: Array<[string, number, number]> = [
      ["DEFAULT_PLANNING_ONLY_RETRY_LIMIT", DEFAULT_PLANNING_ONLY_RETRY_LIMIT, DEFAULT_PLANNING_ONLY_RETRY_LIMIT_REF],
      ["STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT", STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT, STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT_REF],
      ["DEFAULT_REASONING_ONLY_RETRY_LIMIT", DEFAULT_REASONING_ONLY_RETRY_LIMIT, DEFAULT_REASONING_ONLY_RETRY_LIMIT_REF],
      ["DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT", DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT, DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT_REF],
      ["DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT", DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT, DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT_REF],
      ["DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT", DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT, DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT_REF],
    ];
    for (const [name, plug, ref] of limitPairs) {
      const ok = plug === ref;
      results.push({
        caseId: `limit:${name}`,
        description: `retry-limit constant ${name} must match in-host`,
        ok,
        diff: ok ? "" : `plugin=${plug}, reference=${ref}`,
      });
    }

    // Investigative-tool catalog (set equality).
    {
      const ok = arraysEqual(
        PLAN_MODE_INVESTIGATIVE_TOOL_NAMES,
        PLAN_MODE_INVESTIGATIVE_TOOL_NAMES_REF,
      );
      results.push({
        caseId: "set:PLAN_MODE_INVESTIGATIVE_TOOL_NAMES",
        description: "investigative-tool catalog must match in-host set",
        ok,
        diff: ok
          ? ""
          : `plugin=${JSON.stringify([...PLAN_MODE_INVESTIGATIVE_TOOL_NAMES].sort())}, reference=${JSON.stringify([...PLAN_MODE_INVESTIGATIVE_TOOL_NAMES_REF].sort())}`,
      });
    }

    return { name: "escalatingRetry", cases: results };
  },
};
