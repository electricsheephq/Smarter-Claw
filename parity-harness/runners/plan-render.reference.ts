/**
 * Vendored reference for `renderFullPlanArchetypeMarkdown`.
 *
 * **Parity contract**: byte-faithful port of the in-host
 * `renderFullPlanArchetypeMarkdown` (+ private helpers
 * `escapeMarkdown`, `neutralizeMentions`, `renderPlanChecklist`'s
 * markdown branch — restricted to the `step` / `status` / `activeForm`
 * fields the plugin uses) at `src/agents/plan-render.ts:268-355`
 * (commit `ea04ea52c7`).
 *
 * # Scope (intentional)
 *
 * Only the FULL-ARCHETYPE markdown path. The in-host `plan-render.ts`
 * is a multi-format renderer (html / markdown / plaintext /
 * slack-mrkdwn) used by channel adapters across the gateway. The
 * plugin's `src/plan-mode/plan-render.ts` ports just the markdown
 * path needed by the W1-F2 plan-persister; this reference mirrors
 * that scope.
 *
 * The in-host's optional `acceptanceCriteria` / `verifiedCriteria`
 * extensions (PR-9 Wave B1 closure-gate fields) are NOT exercised by
 * the full-archetype markdown path the plugin ports — they only affect
 * `renderPlanChecklist`'s per-step output via `renderAcceptanceCriteria`,
 * and the plugin's `PlanStep` interface doesn't carry them. The
 * reference here omits them for that reason; if a future PR adds them
 * to the plugin, this reference must grow to match.
 *
 * # Anti-pattern guardrail (from parity-harness/README.md)
 *
 * This impl IS the reference. Update it by reading the in-host source
 * at the cited `host_ref:` line range — NOT by inspecting the plugin's
 * own `plan-render.ts` (which would defeat the parity check).
 *
 * host_ref:
 *   - src/agents/plan-render.ts:255-266 (PlanArchetypeMarkdownInput)
 *   - src/agents/plan-render.ts:268-355 (renderFullPlanArchetypeMarkdown)
 *   - src/agents/plan-render.ts:42-71  (renderPlanChecklist — markdown branch)
 *   - src/agents/plan-render.ts:406-420 (escapeMarkdown)
 *   - src/agents/plan-render.ts:435-441 (neutralizeMentions)
 */

import type { PlanStep } from "../../src/types.js";

/**
 * Input shape for the full plan-archetype markdown renderer. Mirrors
 * the in-host `PlanArchetypeMarkdownInput` field-for-field, except
 * that the plugin's `PlanStep` type (no `acceptanceCriteria` /
 * `verifiedCriteria`) stands in for the in-host's `PlanStepForRender`.
 *
 * host_ref: src/agents/plan-render.ts:255-266
 */
export interface PlanArchetypeMarkdownInputReference {
  title: string;
  summary?: string;
  analysis?: string;
  plan: PlanStep[];
  assumptions?: string[];
  risks?: Array<{ risk: string; mitigation: string }>;
  verification?: string[];
  references?: string[];
  /** Optional ISO date footer; defaults to new Date().toISOString().slice(0,10). */
  generatedAt?: Date;
}

/**
 * Render the full plan archetype as a single markdown document.
 *
 * Byte-faithful port of the in-host implementation at
 * `src/agents/plan-render.ts:268-355` (commit `ea04ea52c7`).
 */
export function renderFullPlanArchetypeMarkdownReference(
  input: PlanArchetypeMarkdownInputReference,
): string {
  const lines: string[] = [];
  // Title is REQUIRED; render even if empty (downstream callers should
  // provide a fallback like "Untitled plan").
  const safeTitle = (input.title || "Untitled plan").replace(/[\n\r]+/g, " ").trim();
  lines.push(`# ${escapeMarkdown(neutralizeMentions(safeTitle))}`);

  if (input.summary && input.summary.trim()) {
    lines.push("", "## Summary", escapeMarkdown(neutralizeMentions(input.summary.trim())));
  }

  if (input.analysis && input.analysis.trim()) {
    // Analysis is multi-paragraph. Preserve paragraph breaks but
    // strip carriage returns + escape per-line. Newlines in markdown
    // ARE meaningful, so we preserve `\n\n` as paragraph separators.
    const analysisBody = input.analysis
      .replace(/\r/g, "")
      .split("\n\n")
      .map((para) => escapeMarkdown(neutralizeMentions(para.trim())))
      .filter((para) => para.length > 0)
      .join("\n\n");
    if (analysisBody.length > 0) {
      lines.push("", "## Analysis", analysisBody);
    }
  }

  // Plan section is REQUIRED — but if the steps array is empty, emit
  // a placeholder note rather than an empty section header.
  lines.push("", "## Plan");
  if (input.plan && input.plan.length > 0) {
    lines.push(renderPlanChecklistMarkdown(input.plan));
  } else {
    lines.push("_No plan steps provided._");
  }

  if (input.assumptions && input.assumptions.length > 0) {
    const items = input.assumptions
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => `- ${escapeMarkdown(neutralizeMentions(entry))}`);
    if (items.length > 0) {
      lines.push("", "## Assumptions", items.join("\n"));
    }
  }

  if (input.risks && input.risks.length > 0) {
    const items = input.risks
      .filter((entry) => entry?.risk?.trim() && entry?.mitigation?.trim())
      .map((entry) => {
        const r = escapeMarkdown(neutralizeMentions(entry.risk.trim()));
        const m = escapeMarkdown(neutralizeMentions(entry.mitigation.trim()));
        return `- **${r}**: ${m}`;
      });
    if (items.length > 0) {
      lines.push("", "## Risks", items.join("\n"));
    }
  }

  if (input.verification && input.verification.length > 0) {
    const items = input.verification
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => `- ${escapeMarkdown(neutralizeMentions(entry))}`);
    if (items.length > 0) {
      lines.push("", "## Verification", items.join("\n"));
    }
  }

  if (input.references && input.references.length > 0) {
    const items = input.references
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => `- ${escapeMarkdown(neutralizeMentions(entry))}`);
    if (items.length > 0) {
      lines.push("", "## References", items.join("\n"));
    }
  }

  // Footer with the universal /plan resolution slash commands so the
  // user knows how to act on this plan from any channel that received
  // the file (Telegram primarily, but future Discord/Slack mirror the
  // same pattern via PR-11's universal slash commands).
  const generatedAt = (input.generatedAt ?? new Date()).toISOString().slice(0, 10);
  lines.push(
    "",
    "---",
    `_Generated by OpenClaw on ${generatedAt}. Resolve with \`/plan accept\` | \`/plan accept edits\` | \`/plan revise <feedback>\`._`,
  );

  return lines.join("\n") + "\n";
}

/**
 * Render plan steps as a markdown checklist (the in-host's
 * `renderPlanChecklist(steps, "markdown")` branch, restricted to the
 * step / status / activeForm fields the plugin uses).
 *
 * host_ref: src/agents/plan-render.ts:42-71 + the markdown branch of
 *           renderStepLine inside the same file.
 */
function renderPlanChecklistMarkdown(steps: PlanStep[]): string {
  if (steps.length === 0) {
    return "";
  }
  return steps
    .map((s) => {
      // Treat whitespace-only activeForm as missing — fall back to step text.
      const hasUsableActiveForm =
        typeof s.activeForm === "string" && s.activeForm.trim().length > 0;
      const rawLabel =
        s.status === "in_progress" && hasUsableActiveForm ? s.activeForm! : s.step;
      // Strip newlines from model-generated step text to prevent
      // broken checklists.
      const label = rawLabel.replace(/[\n\r]+/g, " ").trim();
      // PR-11 deep-dive review B1 (BLOCKER): markdown renders on
      // Discord, Mattermost, Matrix, MSTeams, GoogleChat, Feishu,
      // web, CLI. Without neutralization, an agent-controlled step
      // text containing "@everyone" pings the entire channel.
      const md = escapeMarkdown(neutralizeMentions(label));
      switch (s.status) {
        case "completed":
          return `- [x] ${md}`;
        case "in_progress":
          return `- [>] **${md}**`;
        case "cancelled":
          return `- [~] ~~${md}~~`;
        case "pending":
        default:
          return `- [ ] ${md}`;
      }
    })
    .join("\n");
}

/**
 * Escapes markdown meta-characters in user-controlled text.
 *
 * host_ref: src/agents/plan-render.ts:406-420
 */
function escapeMarkdown(text: string): string {
  // Order matters: backslash first so we don't re-escape our own escapes.
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, "\\$&");
}

/**
 * Inserts U+FE6B between '@' and known mention triggers; inserts
 * U+200B between '<' and '@' to defeat Discord raw mentions.
 *
 * host_ref: src/agents/plan-render.ts:435-441
 */
function neutralizeMentions(text: string): string {
  return text
    .replace(/@(channel|here|everyone)\b/gi, "@﹫$1")
    .replace(/<@/g, "<​@");
}
