/**
 * Universal `/plan` slash commands for non-webchat channels.
 *
 * Lets any channel (Telegram chat, Discord DM, Signal, iMessage, Slack
 * threads, CLI) drive plan-mode approvals via plain text instead of
 * inline buttons. Subcommands match the webchat chip + approval card
 * affordances:
 *
 *   /plan accept              → planApproval { action: "approve" }
 *   /plan accept edits        → planApproval { action: "edit" }
 *   /plan revise <feedback>   → planApproval { action: "reject", feedback }
 *   /plan auto on|off         → planApproval { action: "auto", autoEnabled }
 *   /plan on|off              → planMode "plan"|"normal" toggle
 *   /plan status              → print current plan-mode state
 *   /plan restate             → re-render the active plan checklist into
 *                               the channel (so the user can see it
 *                               without re-asking the agent)
 *   /plan answer <text>       → answer a pending ask_user_question
 *
 * The `api.registerCommand` wiring lives in `index.ts`; this module
 * exports the parser + handler so the surface is testable in isolation.
 *
 * The handler is shaped around the Plugin SDK's `PluginCommandContext`
 * surface; it reads the in-flight session state via the runtime-api
 * helpers, decides the response, and (for mutating subcommands) routes
 * through an installer-supplied `applyPlanPatch` callback. The
 * installer wires that callback to whatever session-update mechanism
 * the host gateway exposes (today, the openclaw-1 gateway routes it
 * through `sessions.patch`).
 */

import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

// `PluginCommandResult` is `ReplyPayload` per the Plugin SDK types
// (`OpenClawPluginCommandDefinition.handler` returns it). The
// definition module doesn't re-export the alias, so we re-derive it
// here from the underlying ReplyPayload import.
type PluginCommandResult = ReplyPayload;
import { readSmarterClawState } from "../runtime-api.js";
import {
  type PlanRenderFormat,
  type PlanStepForRender,
  renderPlanChecklist,
} from "./plan-render.js";

const COMMAND_REGEX = /^\/?plan(?:\s|$)/i;
const FOREIGN_COMMAND_MENTION_REGEX = /^\/plan@([^\s]+)(?:\s|$)/i;

type PlanSubcommand =
  | { kind: "status" }
  | { kind: "view" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "restate" }
  | { kind: "auto"; autoEnabled: boolean }
  | { kind: "accept"; allowEdits: boolean }
  | { kind: "revise"; feedback: string }
  | { kind: "answer"; answer: string };

type ParsedPlanCommand = { ok: true; sub: PlanSubcommand } | { ok: false; error: string };

const PLAN_USAGE_TEXT =
  "Usage: /plan <accept|accept edits|revise <feedback>|answer <text>|on|off|status|view|auto on|auto off|restate>";

function normalizeLowercaseStringOrEmpty(s: string | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Parse the `/plan ...` body into a structured subcommand. Exported
 * for testing — production callers use `handlePlanCommand`.
 */
export function parsePlanCommand(raw: string, channel: string): ParsedPlanCommand | null {
  const trimmed = raw.trim();
  // The `/cmd@bot` mention syntax is Telegram-specific. On other
  // channels (Discord/Slack/iMessage/Signal/CLI) `@<word>` after a
  // slash command is just a regular user mention and should not bail
  // the parser. Only enforce the foreign-bot disambiguation on
  // Telegram.
  if (channel.toLowerCase() === "telegram" && FOREIGN_COMMAND_MENTION_REGEX.test(trimmed)) {
    return { ok: false, error: "This /plan command targets a different Telegram bot." };
  }
  const commandMatch = trimmed.match(COMMAND_REGEX);
  if (!commandMatch) {
    return null;
  }
  const rest = trimmed.slice(commandMatch[0].length).trim();
  if (!rest) {
    return { ok: true, sub: { kind: "status" } };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  const first = normalizeLowercaseStringOrEmpty(tokens[0]);
  const second = normalizeLowercaseStringOrEmpty(tokens[1]);
  const tail = tokens.slice(1).join(" ").trim();

  // Reject trailing tokens on single-token commands so typos like
  // `/plan off later` don't silently execute the mode change.
  const rejectTrailingTokens = (verb: string) =>
    tokens.length > 1
      ? ({
          ok: false,
          error: `Usage: /plan ${verb} — unexpected trailing argument "${tokens.slice(1).join(" ")}". This command takes no arguments.`,
        } as const)
      : null;

  switch (first) {
    case "status": {
      const err = rejectTrailingTokens("status");
      if (err) {
        return err;
      }
      return { ok: true, sub: { kind: "status" } };
    }
    case "view": {
      const err = rejectTrailingTokens("view");
      if (err) {
        return err;
      }
      return { ok: true, sub: { kind: "view" } };
    }
    case "on": {
      const err = rejectTrailingTokens("on");
      if (err) {
        return err;
      }
      return { ok: true, sub: { kind: "on" } };
    }
    case "off": {
      const err = rejectTrailingTokens("off");
      if (err) {
        return err;
      }
      return { ok: true, sub: { kind: "off" } };
    }
    case "restate": {
      const err = rejectTrailingTokens("restate");
      if (err) {
        return err;
      }
      return { ok: true, sub: { kind: "restate" } };
    }
    case "accept": {
      const isBareAccept = second === "";
      const isEditsAccept = second === "edits" || second === "edit";
      if (!isBareAccept && !isEditsAccept) {
        return {
          ok: false,
          error: `Usage: /plan accept [edits] — unknown argument "${second}". Valid forms: /plan accept, /plan accept edits.`,
        };
      }
      // Reject trailing tokens beyond the `edits` / `edit` qualifier
      // so `/plan accept edits now` doesn't silently approve.
      const maxTokens = isEditsAccept ? 2 : 1;
      if (tokens.length > maxTokens) {
        return {
          ok: false,
          error: `Usage: /plan accept [edits] — unexpected trailing argument "${tokens.slice(maxTokens).join(" ")}".`,
        };
      }
      const allowEdits = isEditsAccept;
      return { ok: true, sub: { kind: "accept", allowEdits } };
    }
    case "revise": {
      // /plan revise <feedback>. Feedback is REQUIRED. A no-feedback
      // rejection silently increments rejectionCount and can roll the
      // state into a confusing "ask the user to clarify" injection
      // after 3 reflex clicks — UX regression with no operator
      // intent. Force a usage error instead.
      if (!tail) {
        return {
          ok: false,
          error:
            "Usage: /plan revise <feedback> — give the agent something to revise toward, e.g. /plan revise add error handling for the websocket reconnect.",
        };
      }
      return { ok: true, sub: { kind: "revise", feedback: tail } };
    }
    case "auto": {
      // /plan auto [on|off]. Bare /plan auto defaults to on (matches
      // the chip "switch INTO Plan ⚡" intent).
      if (!second || second === "on") {
        return { ok: true, sub: { kind: "auto", autoEnabled: true } };
      }
      if (second === "off") {
        return { ok: true, sub: { kind: "auto", autoEnabled: false } };
      }
      return { ok: false, error: `Unrecognized /plan auto value "${second}". Use on|off.` };
    }
    case "answer": {
      // Text-channel users need a way to answer ask_user_question
      // prompts since the approval card with inline option buttons
      // only renders in webchat (and Telegram via the markdown-
      // attachment path, which doesn't include buttons).
      if (!tail) {
        return {
          ok: false,
          error:
            "Usage: /plan answer <text> — answer the agent's ask_user_question prompt. The text becomes the chosen option (or a free-text response if the agent allowed it).",
        };
      }
      return { ok: true, sub: { kind: "answer", answer: tail } };
    }
    default:
      return { ok: false, error: PLAN_USAGE_TEXT };
  }
}

/**
 * Patch payload the handler hands to the installer's apply callback.
 * Mirrors the openclaw-1 `sessions.patch` shape for the planMode/
 * planApproval surfaces — keeps the wire contract stable when the
 * installer routes through the existing patch handler.
 */
export type PlanPatch =
  | { planMode: "plan" | "normal" }
  | { planApproval: { action: "auto"; autoEnabled: boolean } }
  | {
      planApproval: { action: "approve" | "edit" | "reject"; approvalId: string; feedback?: string };
    }
  | {
      planApproval: {
        action: "answer";
        answer: string;
        approvalId: string;
        questionId?: string;
      };
    };

/**
 * Installer-supplied callback that applies a patch to the active
 * session. The installer wires this to whatever session-update
 * mechanism the host exposes (typically the gateway's
 * `sessions.patch`).
 *
 * Throws on failure; the caller maps known error messages to friendly
 * chat replies (see `mapErrorToReply` below).
 */
export type ApplyPlanPatch = (params: { sessionKey: string; patch: PlanPatch }) => Promise<void>;

function pickPlanRenderFormat(
  channel: string,
  isMarkdownCapable?: (channel: string) => boolean,
): PlanRenderFormat {
  // Map the channel id to the closest renderer the channel can show
  // natively.
  // - Telegram supports HTML parse_mode.
  // - Slack uses mrkdwn (`*bold*`, `~strike~`).
  // - All other channels: consult the optional markdown-capable
  //   predicate the installer can supply. When it's absent, default to
  //   markdown (the safest middle-ground for unknown surfaces).
  const lc = channel.toLowerCase();
  if (lc === "telegram") {
    return "html";
  }
  if (lc === "slack") {
    return "slack-mrkdwn";
  }
  if (isMarkdownCapable && !isMarkdownCapable(lc)) {
    return "plaintext";
  }
  return "markdown";
}

export interface PlanCommandHandlerDeps {
  /**
   * Apply a plan patch to the active session. Required for any
   * mutating subcommand (`accept`, `revise`, `on`, `off`, `auto`,
   * `answer`). When omitted, the handler returns a friendly "not
   * wired" message so the user knows the installer hasn't completed
   * the wiring.
   */
  applyPlanPatch?: ApplyPlanPatch;
  /**
   * Resolve the active session's SessionEntry-shaped object. The
   * handler reads the plugin-namespaced state from this object via
   * `readSmarterClawState`. Required for all subcommands; when
   * omitted, the handler degrades to a minimal status response.
   */
  resolveSession?: (ctx: PluginCommandContext) => Promise<unknown> | unknown;
  /**
   * Optional channel-capability oracle. Used by `/plan restate` to
   * pick the right renderer format for the active channel. When
   * omitted, unknown channels default to markdown.
   */
  isMarkdownCapableChannel?: (channel: string) => boolean;
  log?: { warn?: (msg: string) => void; debug?: (msg: string) => void };
}

/**
 * The Plugin SDK command handler for `/plan`. Wire via
 * `api.registerCommand({ name: "plan", handler: createPlanCommandHandler(deps), ... })`
 * in the plugin entry. The deps shape lets the installer inject the
 * session-resolver + patch-apply seam (the Plugin SDK does not yet
 * expose a generic session-write surface).
 */
export function createPlanCommandHandler(deps: PlanCommandHandlerDeps = {}) {
  return async (ctx: PluginCommandContext): Promise<PluginCommandResult> => {
    const sessionKey = ctx.sessionKey;
    const args = ctx.args ?? "";
    const fullBody = ctx.commandBody ?? `/plan ${args}`.trim();
    const parsed = parsePlanCommand(fullBody, ctx.channel);
    if (!parsed) {
      // The body didn't match `/plan ...` — return the usage as a
      // safety reply so we don't silently swallow.
      return { text: PLAN_USAGE_TEXT };
    }
    if (!parsed.ok) {
      return { text: parsed.error };
    }
    if (!sessionKey) {
      return { text: "Plan commands require an active session." };
    }

    const sub = parsed.sub;
    const session = deps.resolveSession ? await deps.resolveSession(ctx) : undefined;
    const state = session ? readSmarterClawState(session) : undefined;

    if (sub.kind === "status") {
      if (!state) {
        return { text: "Plan mode is **off** for this session." };
      }
      const lines = [
        `Plan mode: **${state.planMode}**`,
        `Approval: ${state.planApproval}`,
        ...(state.autoApprove ? ["Auto-approve: **on**"] : []),
      ];
      return { text: lines.join("\n") };
    }

    if (sub.kind === "view") {
      return {
        text: "/plan view is only meaningful in the Control UI. Use /plan restate here to re-render the current plan inline.",
      };
    }

    if (sub.kind === "restate") {
      const proposal = state?.lastPlanSteps;
      const steps = proposal?.steps ?? [];
      if (steps.length === 0) {
        return {
          text:
            "No active plan to restate — the agent hasn't called update_plan or exit_plan_mode yet.",
        };
      }
      const format = pickPlanRenderFormat(ctx.channel, deps.isMarkdownCapableChannel);
      // The plugin-namespaced PlanProposal carries a richer step shape
      // than the renderer's PlanStepForRender. Map the fields the
      // renderer cares about; unrecognized fields default to pending
      // rendering inside the renderer.
      const renderable: PlanStepForRender[] = steps.map((s) => ({
        step: s.description,
        status: s.done ? "completed" : "pending",
      }));
      // Step-aware truncation — render once and drop trailing steps
      // until the rendered text fits the soft cap. Per-channel max
      // payload size varies (Telegram ~4096, Discord ~2000); 3500 is
      // the most-conservative guardrail that fits Telegram's HTML
      // parse_mode without breaking inline tags mid-character.
      const RESTATE_SOFT_CAP = 3500;
      let renderedSteps = renderable;
      let droppedCount = 0;
      let checklist = renderPlanChecklist(renderedSteps, format);
      while (checklist.length > RESTATE_SOFT_CAP && renderedSteps.length > 1) {
        droppedCount += 1;
        renderedSteps = renderedSteps.slice(0, -1);
        checklist = renderPlanChecklist(renderedSteps, format);
      }
      if (checklist.length > RESTATE_SOFT_CAP && renderedSteps.length === 1) {
        const TRUNCATED_STEP_MAX = Math.max(200, RESTATE_SOFT_CAP - 200);
        const original = renderedSteps[0];
        const truncatedStep: PlanStepForRender = {
          ...original,
          step:
            original.step.length > TRUNCATED_STEP_MAX
              ? original.step.slice(0, TRUNCATED_STEP_MAX) + "…"
              : original.step,
        };
        renderedSteps = [truncatedStep];
        checklist = renderPlanChecklist(renderedSteps, format);
        droppedCount += 1;
      }
      if (droppedCount > 0) {
        const footerNote = `\n… (${droppedCount} more step(s) truncated — open the plan-view sidebar in Control UI for the full checklist)`;
        checklist = `${checklist}${footerNote}`;
      }
      const text =
        format === "html"
          ? `<b>Current plan:</b>\n${checklist}`
          : format === "slack-mrkdwn"
            ? `*Current plan:*\n${checklist}`
            : `Current plan:\n${checklist}`;
      return { text };
    }

    if (!deps.applyPlanPatch) {
      return {
        text: "Smarter Claw plan-patch wiring is not installed yet. The installer needs to wire the host session-patch surface — see /plan status for the current state.",
      };
    }
    const apply = deps.applyPlanPatch;

    try {
      if (sub.kind === "on") {
        await apply({ sessionKey, patch: { planMode: "plan" } });
        return {
          text: "Plan mode **enabled** — write/edit/exec tools blocked until plan approved.",
        };
      }
      if (sub.kind === "off") {
        await apply({ sessionKey, patch: { planMode: "normal" } });
        return { text: "Plan mode **disabled** — mutations unblocked." };
      }
      if (sub.kind === "auto") {
        await apply({
          sessionKey,
          patch: { planApproval: { action: "auto", autoEnabled: sub.autoEnabled } },
        });
        return {
          text: sub.autoEnabled
            ? "Plan auto-approve **enabled** — future plan submissions resolve as approved without confirmation."
            : "Plan auto-approve **disabled** — plan submissions require manual confirmation.",
        };
      }
      if (sub.kind === "answer") {
        const pending = state?.pendingInteraction;
        const approvalId =
          pending?.kind === "question" ? pending.approvalId : state?.pendingQuestionApprovalId;
        if (!approvalId) {
          return {
            text:
              "No pending ask_user_question for this session — `/plan answer` requires a question to be active.",
          };
        }
        await apply({
          sessionKey,
          patch: {
            planApproval: {
              action: "answer",
              answer: sub.answer,
              approvalId,
            },
          },
        });
        return { text: "Answer delivered — agent resumes shortly." };
      }
      if (sub.kind === "accept" || sub.kind === "revise") {
        // Pre-check that there's actually a pending approval to act
        // on. Without this, the gateway returns a confusing "stale
        // approvalId" error to the user.
        const approvalId =
          state?.pendingInteraction?.kind === "approval"
            ? state.pendingInteraction.approvalId
            : undefined;
        if (state?.planApproval !== "awaiting-approval" && state?.planApproval !== "proposed") {
          return {
            text:
              "No pending plan to " +
              (sub.kind === "accept" ? "accept" : "revise") +
              " — the agent hasn't submitted a plan via exit_plan_mode yet, or the previous one was already resolved.",
          };
        }
        if (!approvalId) {
          return {
            text:
              "No pending plan to " +
              (sub.kind === "accept" ? "accept" : "revise") +
              " — the session is missing the approvalId. The agent may need to re-submit via exit_plan_mode.",
          };
        }
        if (sub.kind === "accept") {
          const action = sub.allowEdits ? "edit" : "approve";
          await apply({
            sessionKey,
            patch: { planApproval: { action, approvalId } },
          });
          return { text: `Plan ${sub.allowEdits ? "approved with edits" : "approved"} — agent resumes shortly.` };
        }
        await apply({
          sessionKey,
          patch: {
            planApproval: { action: "reject", feedback: sub.feedback, approvalId },
          },
        });
        return { text: "Plan rejected — feedback delivered to agent for revision." };
      }
    } catch (error) {
      return mapErrorToReply(error);
    }

    return { text: PLAN_USAGE_TEXT };
  };
}

function mapErrorToReply(error: unknown): PluginCommandResult {
  const errMsg = error instanceof Error ? error.message : String(error);
  if (errMsg.includes("plan mode is disabled")) {
    return {
      text: "Plan mode is disabled at the config level. Enable Smarter Claw in plugin config and restart the gateway.",
    };
  }
  // Map the gateway's "stale approvalId" / "terminal approval state"
  // wording to a friendly chat message. Common case: the user
  // double-clicks /plan accept and the second call lands on an
  // already-resolved approval.
  if (errMsg.includes("stale approvalId") || errMsg.includes("terminal approval state")) {
    return {
      text: "Plan was already resolved (likely a duplicate command). Use /plan status to see the current state.",
    };
  }
  if (errMsg.includes("PLAN_APPROVAL_GATE_STATE_UNAVAILABLE")) {
    return {
      text:
        "Refresh the session or ask the agent to resubmit the plan before approving again. The runtime could not safely reconstruct the subagent gate state for this plan cycle.",
    };
  }
  return { text: `Failed to apply /plan command: ${errMsg}` };
}
