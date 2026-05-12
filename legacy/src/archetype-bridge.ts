/**
 * Plan-mode → channel attachment bridge.
 *
 * When the runtime emits a plan-mode approval, this orchestrator:
 *   1. Renders the full archetype as a markdown document.
 *   2. Persists the markdown to ~/.openclaw/agents/<agentId>/plans/
 *      so operators have a durable audit trail across all sessions.
 *   3. If the originating session is from a channel that supports file
 *      attachments (Telegram today; Discord/Slack/etc. later), uploads
 *      the markdown as a document attachment to the chat with a short
 *      caption containing the universal /plan resolution slash
 *      commands.
 *
 * Resolution stays text-based via the universal /plan slash commands.
 * This bridge is read-only (visibility), no approval-id translator
 * required.
 *
 * Always best-effort: failures log at warn and never propagate.
 *
 * ## Relationship to `archetype-hook.ts`
 *
 * `archetype-hook.ts` injects the archetype prompt at
 * `before_prompt_build` time so the agent sees the
 * decision-completeness standard while drafting its plan. This bridge
 * fires AFTER the agent submits the plan via `exit_plan_mode`, taking
 * the rendered archetype and persisting + attaching it for the user.
 * The two modules share no runtime state — they're separate
 * lifecycle bridges (prompt-time vs. approval-time).
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ INSTALLER SEAM:                                                 │
 * │                                                                 │
 * │ Channel-aware attachment delivery (e.g. Telegram document       │
 * │ upload) requires a host-side channel client. The Plugin SDK     │
 * │ does not yet expose a generic "send-attachment-to-channel"      │
 * │ surface, so this module:                                        │
 * │                                                                 │
 * │   - Always persists the markdown to disk (works without any     │
 * │     installer wiring).                                          │
 * │   - Calls the optional `sendAttachment` callback you pass on    │
 * │     `dispatchPlanArchetypeAttachment(input)` when channel       │
 * │     delivery is desired. The installer-side glue supplies that  │
 * │     callback by binding to the host's channel registry.         │
 * │                                                                 │
 * │ Until the installer wires sendAttachment, the bridge degrades   │
 * │ gracefully to disk-only persistence — the audit trail still     │
 * │ works.                                                          │
 * └─────────────────────────────────────────────────────────────────┘
 */

import { renderFullPlanArchetypeMarkdown } from "./plan-render.js";
import { persistPlanArchetypeMarkdown, PlanPersistStorageError } from "./archetype-persist.js";

/**
 * Loose plan-step shape accepted by the bridge — matches the renderer's
 * `PlanStepForRender` so callers can hand the same array off without
 * shape conversion.
 */
export interface DispatchPlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  activeForm?: string;
  acceptanceCriteria?: string[];
  verifiedCriteria?: string[];
}

export interface DispatchPlanArchetypeAttachmentInput {
  sessionKey: string;
  agentId: string;
  /**
   * The same `details` object passed to the approval emit — carries
   * the full archetype (title, summary, plan steps, analysis,
   * assumptions, risks, verification, references).
   */
  details: {
    title?: string;
    summary?: string;
    analysis?: string;
    plan: DispatchPlanStep[];
    assumptions?: string[];
    risks?: Array<{ risk: string; mitigation: string }>;
    verification?: string[];
    references?: string[];
  };
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** Injectable now() for tests. */
  nowMs?: number;
  /**
   * Override the persistence base directory (tests use a temp dir).
   * Production never sets this — defaults to `~/.openclaw/agents` via
   * persistPlanArchetypeMarkdown.
   */
  persistBaseDir?: string;
  /**
   * Optional channel-side delivery callback. The installer wires this
   * to the host's channel registry. When omitted (or it returns
   * `null`), the bridge degrades gracefully to disk-only persistence.
   */
  sendAttachment?: (params: {
    sessionKey: string;
    absPath: string;
    filename: string;
    caption: string;
  }) => Promise<{ delivered: boolean; channel?: string; messageId?: string } | null>;
}

/**
 * Build the short caption attached to the markdown document. Includes
 * the plan title (if any) and the universal /plan resolution commands
 * so the user knows how to act on the file from their channel.
 * Truncated to ≤1000 chars by most channel-side senders (Telegram
 * caption limit is 1024).
 */
export function buildPlanAttachmentCaption(
  title: string | undefined,
  summary: string | undefined,
): string {
  const safeTitle = (title ?? "").trim() || "Plan";
  const escTitle = escapeHtml(safeTitle);
  const safeSummary = (summary ?? "").trim();
  const summaryLine = safeSummary ? `\n${escapeHtml(safeSummary)}` : "";
  return [
    `<b>${escTitle}</b> — plan submitted for approval. See attached.`,
    summaryLine,
    "",
    "Resolve with: <code>/plan accept</code> | <code>/plan accept edits</code> | <code>/plan revise &lt;feedback&gt;</code>",
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function dispatchPlanArchetypeAttachment(
  input: DispatchPlanArchetypeAttachmentInput,
): Promise<void> {
  const log = input.log;
  try {
    // 1. Render markdown.
    const markdown = renderFullPlanArchetypeMarkdown({
      title: input.details.title ?? "Plan",
      summary: input.details.summary,
      analysis: input.details.analysis,
      plan: input.details.plan,
      assumptions: input.details.assumptions,
      risks: input.details.risks,
      verification: input.details.verification,
      references: input.details.references,
      generatedAt: input.nowMs ? new Date(input.nowMs) : undefined,
    });

    // 2. Persist (always — durable audit artifact).
    const { absPath, filename } = await persistPlanArchetypeMarkdown({
      agentId: input.agentId,
      title: input.details.title,
      markdown,
      now: input.nowMs ? new Date(input.nowMs) : undefined,
      ...(input.persistBaseDir ? { baseDir: input.persistBaseDir } : {}),
    });
    log?.info?.(`plan-bridge: persisted ${filename}`);

    // 3. Optional channel-aware delivery via the installer-supplied
    // sendAttachment callback. When the callback is absent or returns
    // null, we degrade gracefully — the disk artifact stands alone.
    if (!input.sendAttachment) {
      log?.debug?.("plan-bridge: no sendAttachment callback wired; disk-only persistence");
      return;
    }
    const caption = buildPlanAttachmentCaption(input.details.title, input.details.summary);
    const sendResult = await input.sendAttachment({
      sessionKey: input.sessionKey,
      absPath,
      filename,
      caption,
    });
    if (!sendResult || !sendResult.delivered) {
      log?.debug?.(
        `plan-bridge: sendAttachment declined (channel=${sendResult?.channel ?? "none"})`,
      );
      return;
    }
    log?.info?.(
      `plan-bridge: attachment sent channel=${sendResult.channel ?? "unknown"} msgId=${sendResult.messageId ?? "?"}`,
    );
  } catch (err) {
    // Recoverable storage errors are not bugs — they're operator-
    // actionable conditions (full disk, bad permissions, hardware
    // I/O). Emit a distinctive log line so operators can grep their
    // gateway log for `[plan-bridge/storage]` without digging through
    // unrelated plan-bridge failures. Plan approval still proceeds;
    // only the durable audit artifact is lost for this cycle.
    if (err instanceof PlanPersistStorageError) {
      log?.warn?.(
        `[plan-bridge/storage] markdown persist failed (${err.code}) — ` +
          `plan approval proceeds but audit artifact was NOT written. ` +
          `Operator action: check ~/.openclaw free space / permissions. Detail: ${err.message}`,
      );
      return;
    }
    log?.warn?.(
      `plan-bridge attachment failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
