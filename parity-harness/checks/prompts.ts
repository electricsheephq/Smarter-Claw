/**
 * Layer-1 check: byte-identical prompt artifacts.
 *
 * Closes Wave-1 finding W1-D3: "no byte-fixture test pins the prompt
 * artifacts against in-host bytes". This check reads four committed
 * snapshots from `parity-harness/host-snapshots/` (captured by
 * `host-snapshots/capture.ts` via `git show` from the in-host source-
 * of-truth at commit `ea04ea52c7`) and diffs them against the plugin's
 * runtime output byte-for-byte.
 *
 * Artifacts pinned:
 *   - `PLAN_ARCHETYPE_PROMPT` (from `src/prompt/archetype-prompt.ts`)
 *   - `PLAN_MODE_REFERENCE_CARD` (from `src/prompt/reference-card.ts`)
 *   - `buildPlanModeActiveSystemContext()` (from `src/prompt/plan-mode-injection.ts`)
 *   - `buildPlanModeAvailableSystemContext()` (from `src/prompt/plan-mode-injection.ts`)
 *
 * # Why bytes matter
 *
 * Prompt-cache keys are prefix hashes of the system context. A single
 * character drift bumps the hash and forces a full prefix re-evaluation
 * on every plan-mode turn — and steers agent behavior differently
 * because the agent reads the bytes verbatim.
 *
 * host_ref:
 *   - src/agents/plan-mode/plan-archetype-prompt.ts
 *   - src/agents/plan-mode/reference-card.ts
 *   - src/agents/pi-embedded-runner/run/attempt.ts:692-748
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_ARCHETYPE_PROMPT } from "../../src/prompt/archetype-prompt.js";
import {
  buildPlanModeActiveSystemContext,
  buildPlanModeAvailableSystemContext,
} from "../../src/prompt/plan-mode-injection.js";
import { PLAN_MODE_REFERENCE_CARD } from "../../src/prompt/reference-card.js";
import type { CheckCaseResult, CheckReport, ParityCheck } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function snapshot(name: string): string {
  const path = join(__dirname, "..", "host-snapshots", name);
  return readFileSync(path, "utf8");
}

function diffBytes(plugin: string, host: string): string {
  if (plugin === host) return "";
  if (plugin.length !== host.length) {
    // Still find first byte-diff so the failure message is actionable.
    const min = Math.min(plugin.length, host.length);
    for (let i = 0; i < min; i++) {
      if (plugin[i] !== host[i]) {
        const ctx = (s: string) =>
          JSON.stringify(s.slice(Math.max(0, i - 30), i + 30));
        return `length differs (plugin=${plugin.length}, host=${host.length}); first byte-diff at index ${i}: plugin=${ctx(plugin)}, host=${ctx(host)}`;
      }
    }
    return `length differs (plugin=${plugin.length}, host=${host.length}); prefix identical, ${plugin.length > host.length ? "plugin" : "host"} has extra trailing bytes`;
  }
  for (let i = 0; i < plugin.length; i++) {
    if (plugin[i] !== host[i]) {
      const ctx = (s: string) =>
        JSON.stringify(s.slice(Math.max(0, i - 30), i + 30));
      return `first byte-diff at index ${i}: plugin=${ctx(plugin)}, host=${ctx(host)}`;
    }
  }
  return "strings differ but no per-character diff found (codepoint mismatch?)";
}

interface PromptCase {
  caseId: string;
  description: string;
  pluginValue: string;
  hostSnapshot: string;
}

function buildCases(): PromptCase[] {
  return [
    {
      caseId: "PLAN_ARCHETYPE_PROMPT",
      description:
        "PLAN_ARCHETYPE_PROMPT (src/prompt/archetype-prompt.ts) must match in-host plan-archetype-prompt.ts byte-for-byte",
      pluginValue: PLAN_ARCHETYPE_PROMPT,
      hostSnapshot: snapshot("PLAN_ARCHETYPE_PROMPT.txt"),
    },
    {
      caseId: "PLAN_MODE_REFERENCE_CARD",
      description:
        "PLAN_MODE_REFERENCE_CARD (src/prompt/reference-card.ts) must match in-host reference-card.ts byte-for-byte",
      pluginValue: PLAN_MODE_REFERENCE_CARD,
      hostSnapshot: snapshot("PLAN_MODE_REFERENCE_CARD.txt"),
    },
    {
      caseId: "buildPlanModeActiveSystemContext",
      description:
        "buildPlanModeActiveSystemContext() must match in-host attempt.ts:692-732 inline-array output (with archetype + reference-card substituted) byte-for-byte",
      pluginValue: buildPlanModeActiveSystemContext(),
      hostSnapshot: snapshot("plan-mode-active-system-context.txt"),
    },
    {
      caseId: "buildPlanModeAvailableSystemContext",
      description:
        "buildPlanModeAvailableSystemContext() must match in-host attempt.ts:735-748 inline-array output byte-for-byte",
      pluginValue: buildPlanModeAvailableSystemContext(),
      hostSnapshot: snapshot("plan-mode-available-system-context.txt"),
    },
  ];
}

export const promptsCheck: ParityCheck = {
  name: "prompts",
  run(): CheckReport {
    const results: CheckCaseResult[] = buildCases().map((c) => {
      const diff = diffBytes(c.pluginValue, c.hostSnapshot);
      return {
        caseId: c.caseId,
        description: c.description,
        ok: diff === "",
        diff,
      };
    });
    return { name: "prompts", cases: results };
  },
};
