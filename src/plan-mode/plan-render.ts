/**
 * Plan-archetype markdown renderer.
 *
 * **Parity contract**: byte-faithful port of the in-host
 * `renderFullPlanArchetypeMarkdown` (+ private helpers
 * `escapeMarkdown`, `neutralizeMentions`, `renderPlanChecklist`'s
 * markdown branch) at `src/agents/plan-render.ts:268-355` (commit
 * `ea04ea52c7`).
 *
 * Renders a plan archetype as a single markdown document suitable
 * for persistence to disk. Used by the `exit_plan_mode` tool path
 * (W1-F2 fix) — the persister writes the output of this function
 * to `~/.openclaw/agents/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md`.
 *
 * Plugin-port scope: only the FULL ARCHETYPE markdown path. The
 * in-host `plan-render.ts` is a multi-format renderer (HTML,
 * markdown, plaintext, slack-mrkdwn) used by channel adapters
 * across the gateway; the plugin does not own channel rendering,
 * so we port just the markdown path needed by the W1-F2 persister.
 *
 * # Why the helpers are inlined (not re-exported from elsewhere)
 *
 * The in-host's `escapeMarkdown` + `neutralizeMentions` live as
 * file-private helpers in `plan-render.ts`. To stay byte-faithful
 * and avoid an unnecessary file split, we duplicate them here as
 * file-private helpers. They are pure functions; future re-use
 * (if the plugin ever ships another markdown surface) would split
 * them then.
 *
 * host_ref: src/agents/plan-render.ts:268-355
 *           (renderFullPlanArchetypeMarkdown + private helpers)
 */

import type { PlanStep } from "../types.js";

/**
 * Input shape for the full plan-archetype markdown renderer. Matches
 * the in-host `PlanArchetypeMarkdownInput` field-for-field except
 * that the plugin's `PlanStep` type stands in for the in-host's
 * `PlanStepForRender` (the relevant fields — `step`, `status`,
 * `activeForm` — are byte-compatible; the in-host's optional
 * `acceptanceCriteria` / `verifiedCriteria` extensions are not used
 * by the full-archetype markdown path).
 *
 * host_ref: src/agents/plan-render.ts:255-266
 *           (`PlanArchetypeMarkdownInput`)
 */
export interface PlanArchetypeMarkdownInput {
  title: string;
  summary?: string;
  analysis?: string;
  plan: PlanStep[];
  assumptions?: string[];
  risks?: Array<{ risk: string; mitigation: string }>;
  verification?: string[];
  references?: string[];
  /** Optional ISO date footer; defaults to `new Date().toISOString().slice(0,10)`. */
  generatedAt?: Date;
}

/**
 * Render the full plan archetype as a single markdown document
 * suitable for persistence to disk and delivery as a file attachment.
 *
 * Produces sections in canonical order:
 *   # <title>
 *   ## Summary
 *   ## Analysis
 *   ## Plan        (checklist via renderPlanChecklist markdown branch)
 *   ## Assumptions (bullet list)
 *   ## Risks       (bullet list with mitigation)
 *   ## Verification (bullet list)
 *   ## References  (bullet list)
 *
 * Each optional section is omitted when its field is absent or empty,
 * so a minimal plan (title + steps only) renders as just the H1 +
 * `## Plan` + checklist. All user-controlled text passes through
 * `escapeMarkdown` + `neutralizeMentions` to defeat injection vectors
 * (matching the PR-11 deep-dive review B1 fix in-host).
 *
 * host_ref: src/agents/plan-render.ts:268-355
 *           (`renderFullPlanArchetypeMarkdown`)
 */
export function renderFullPlanArchetypeMarkdown(
  input: PlanArchetypeMarkdownInput,
): string {
  const lines: string[] = [];
  // Title is REQUIRED; render even if empty (downstream callers should
  // provide a fallback like "Untitled plan").
  const safeTitle = (input.title || "Untitled plan")
    .replace(/[\n\r]+/g, " ")
    .trim();
  lines.push(`# ${escapeMarkdown(neutralizeMentions(safeTitle))}`);

  if (input.summary && input.summary.trim()) {
    lines.push(
      "",
      "## Summary",
      escapeMarkdown(neutralizeMentions(input.summary.trim())),
    );
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
  // user knows how to act on this plan from any channel where the
  // file is later surfaced. Mirrors the in-host footer verbatim so
  // operators see identical files whether the plan came from in-host
  // or this plugin.
  const generatedAt = (input.generatedAt ?? new Date())
    .toISOString()
    .slice(0, 10);
  lines.push(
    "",
    "---",
    `_Generated by OpenClaw on ${generatedAt}. Resolve with \`/plan accept\` | \`/plan accept edits\` | \`/plan revise <feedback>\`._`,
  );

  return lines.join("\n") + "\n";
}

/**
 * Renders plan steps as a GitHub-flavored markdown checklist. Ported
 * from the in-host `renderPlanChecklist(..., "markdown")` branch at
 * `src/agents/plan-render.ts:42-71` + `renderStepLine(..., "markdown")`
 * branch at the same file's renderStepLine helper.
 *
 * Status → marker:
 *   pending      → `- [ ] <step>`
 *   in_progress  → `- [>] **<activeForm or step>**`
 *   completed    → `- [x] <step>`
 *   cancelled    → `- [~] ~~<step>~~`
 *
 * host_ref: src/agents/plan-render.ts:42-71 (renderPlanChecklist) +
 *           the markdown branch of renderStepLine
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
        s.status === "in_progress" && hasUsableActiveForm
          ? s.activeForm!
          : s.step;
      // Strip newlines from model-generated step text to prevent
      // broken checklists.
      const label = rawLabel.replace(/[\n\r]+/g, " ").trim();
      // PR-11 deep-dive review B1 (in-host BLOCKER): markdown renders
      // on Discord, Mattermost, Matrix, MSTeams, GoogleChat, Feishu,
      // web, CLI. Without neutralization, an agent-controlled step
      // text containing "@everyone" pings the entire channel on
      // Discord + Mattermost. escapeMarkdown handles `*`/`[`/etc but
      // does NOT touch `@`, so we need a separate pass.
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
 * Escape markdown meta-characters in user-controlled text so a step
 * like "Deploy `rm -rf /`", "[click](evil)", or "Deploy ~~prod~~ now"
 * doesn't render as a code span, link, or break out of the
 * cancelled-step `~~...~~` strikethrough wrapper.
 *
 * host_ref: src/agents/plan-render.ts:406-420 (`escapeMarkdown`)
 *
 * PR-C review fix in-host (Codex P2 #3096528415 / Copilot
 * #3096792952): `~` is in the escape set so that step text containing
 * `~~` doesn't close the outer strikethrough wrapper used for
 * cancelled steps.
 */
function escapeMarkdown(text: string): string {
  // Order matters: backslash first so we don't re-escape our own escapes.
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, "\\$&");
}

/**
 * Insert U+FE6B between '@' and known mention triggers to prevent
 * @channel / @here / @everyone notifications from user-controlled
 * text. Also neutralize Discord raw user mentions (`<@123>` /
 * `<@!123>` / `<@&123>`) by inserting U+200B between `<` and `@`.
 *
 * host_ref: src/agents/plan-render.ts:435-441 (`neutralizeMentions`)
 */
function neutralizeMentions(text: string): string {
  return text
    .replace(/@(channel|here|everyone)\b/gi, "@\uFE6B$1")
    .replace(/<@/g, "<\u200B@");
}
