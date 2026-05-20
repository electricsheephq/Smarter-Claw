/**
 * Layer-1 check: byte-identical full-archetype plan markdown render.
 *
 * Closes Wave-6 finding W6-2: the W1-F2 plan-persister
 * (`src/plan-mode/plan-render.ts` `renderFullPlanArchetypeMarkdown`)
 * was a byte-faithful port of the in-host
 * `src/agents/plan-render.ts:268-355` (commit `ea04ea52c7`) but its
 * tests are all `.toContain()` / `.toMatch()` / section-ordering
 * checks — there was no byte-fixture pin against the in-host bytes.
 * This check adds the pin: a curated input matrix is run through BOTH
 * the plugin's implementation AND a vendored in-host reference, and
 * any byte divergence FAILS CI.
 *
 * # Why bytes matter
 *
 * The plan markdown is persisted to disk and later attached as a file
 * to channel deliveries (Telegram + Slack mirrors). A byte drift here
 * means operators see different artifacts depending on which side of
 * the in-host / plugin split rendered the plan — defeats W1-F2's
 * "byte-faithful port" promise and re-opens the W1-D3 antipattern
 * the Wave-2 promptsCheck closed for system-prompt artifacts.
 *
 * # Why a curated input matrix, not a single byte fixture
 *
 * The renderer is INPUT-DRIVEN — there's no single "the bytes" to
 * snapshot, since the output depends on the input. The harness
 * approach is to fix a small representative input table (empty plan,
 * full archetype, edge cases, markdown-escape, mention-neutralization)
 * and diff the two implementations' outputs PER CASE. This is the
 * same shape as the existing `runtimeRejectAndPlanStepsCheck` (which
 * pins another input-driven helper port).
 *
 * # When this check fails
 *
 * Two paths:
 *   - Plugin's `renderFullPlanArchetypeMarkdown` drifted: fix
 *     `src/plan-mode/plan-render.ts` to match the reference at the
 *     cited `host_ref:` line range.
 *   - In-host source-of-truth itself changed (rare; Wave-0 pinned
 *     `ea04ea52c7`): re-port the reference at
 *     `parity-harness/runners/plan-render.reference.ts` from the
 *     new in-host code, then update the plugin to match.
 *
 * NEVER edit the reference to make a failing plugin pass — that
 * defeats the parity check.
 *
 * host_ref: src/agents/plan-render.ts:268-355 (renderFullPlanArchetypeMarkdown)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderFullPlanArchetypeMarkdown,
  type PlanArchetypeMarkdownInput,
} from "../../src/plan-mode/plan-render.js";
import {
  renderFullPlanArchetypeMarkdownReference,
  type PlanArchetypeMarkdownInputReference,
} from "../runners/plan-render.reference.js";
import type { CheckCaseResult, CheckReport, ParityCheck } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * JSON-encodable input case. `generatedAt` is serialized as an ISO
 * string and revived to a Date on load (the renderer accepts Date,
 * not string, so the harness MUST revive it — JSON round-trip would
 * otherwise yield mismatched timestamp strings).
 */
interface PlanRenderCaseJson {
  id: string;
  description: string;
  input: Omit<PlanArchetypeMarkdownInput, "generatedAt"> & {
    generatedAt?: string;
  };
}

interface PlanRenderCase {
  id: string;
  description: string;
  input: PlanArchetypeMarkdownInput & PlanArchetypeMarkdownInputReference;
}

function loadCases(): PlanRenderCase[] {
  const path = join(__dirname, "..", "inputs", "planRender.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as PlanRenderCaseJson[];
  return raw.map((c) => ({
    id: c.id,
    description: c.description,
    input: {
      ...c.input,
      generatedAt: c.input.generatedAt ? new Date(c.input.generatedAt) : undefined,
    } as PlanArchetypeMarkdownInput & PlanArchetypeMarkdownInputReference,
  }));
}

/**
 * Byte-level diff of plugin output vs reference output. Returns "" on
 * match; multi-line summary on mismatch.
 */
function diffBytes(plugin: string, reference: string): string {
  if (plugin === reference) return "";
  if (plugin.length !== reference.length) {
    const min = Math.min(plugin.length, reference.length);
    for (let i = 0; i < min; i++) {
      if (plugin[i] !== reference[i]) {
        const ctx = (s: string) =>
          JSON.stringify(s.slice(Math.max(0, i - 30), i + 30));
        return `length differs (plugin=${plugin.length}, reference=${reference.length}); first byte-diff at index ${i}: plugin=${ctx(plugin)}, reference=${ctx(reference)}`;
      }
    }
    return `length differs (plugin=${plugin.length}, reference=${reference.length}); prefix identical, ${plugin.length > reference.length ? "plugin" : "reference"} has extra trailing bytes`;
  }
  for (let i = 0; i < plugin.length; i++) {
    if (plugin[i] !== reference[i]) {
      const ctx = (s: string) =>
        JSON.stringify(s.slice(Math.max(0, i - 30), i + 30));
      return `first byte-diff at index ${i}: plugin=${ctx(plugin)}, reference=${ctx(reference)}`;
    }
  }
  return "strings differ but no per-character diff found (codepoint mismatch?)";
}

export const planRenderCheck: ParityCheck = {
  name: "planRender",
  run(): CheckReport {
    const cases = loadCases();
    const results: CheckCaseResult[] = cases.map((c) => {
      const plug = renderFullPlanArchetypeMarkdown(c.input);
      const ref = renderFullPlanArchetypeMarkdownReference(c.input);
      const diff = diffBytes(plug, ref);
      return {
        caseId: c.id,
        description: c.description,
        ok: diff === "",
        diff,
      };
    });
    return { name: "planRender", cases: results };
  },
};
