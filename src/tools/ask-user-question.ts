/**
 * `ask_user_question` agent tool.
 *
 * host_ref: src/agents/tools/ask-user-question-tool.ts (PR-10 in-host)
 *
 * Surfaces a clarifying question to the user via the same approval-
 * card pipeline that exit_plan_mode uses (kind: "plugin"). The user
 * picks one of N options (or types free text when allowed) and the
 * answer arrives in the next agent turn as a synthetic user message
 * tagged `[QUESTION_ANSWER]: <text>`.
 *
 * # Plan-mode safety
 *
 * Questions DO NOT exit plan mode. The session stays in plan mode
 * while waiting; the answer just unblocks the agent's next turn. Use
 * this when you need a tradeoff resolution before submitting a plan,
 * NOT for confirmation requests (that's what exit_plan_mode does).
 *
 * # In-host vs plugin port
 *
 * In-host: the runtime intercepts the tool result and emits a
 * question approval event via the existing kind:"plugin" approval
 * pipeline; the gateway's `plan-snapshot-persister.ts:184-209`
 * subscribes to that stream and writes `pendingInteraction` on the
 * SessionEntry, so `/plan answer` can resolve the question.
 *
 * Plugin: the plugin CANNOT subscribe to the host's `approval`
 * stream (it is `bundled-plugin-only` — see
 * `docs/audits/parity-refresh/blocker-W1-F1.md` §2 and the
 * `HOST_OWNED_AGENT_EVENT_STREAMS` Set in the installed loader). So
 * the tool body itself persists the pending-question state into the
 * plugin's own `pluginExtensions["smarter-claw"]["plan-mode"]`
 * namespace via `store.persistPendingQuestion`. The slash-command
 * surface (`src/ui/slash-commands.ts`) reads from the same slot to
 * route `/plan answer <text>` cross-surface. **Wave-1 W1-F5 fix
 * (2026-05-20).**
 *
 * The store wire is optional for the tool's stateless input-validation
 * tests (which never construct a PlanModeStore). Production wiring
 * in `src/index.ts` always supplies it.
 */

import { Type } from "typebox";
import { describeAskUserQuestionTool } from "../plan-mode/tool-descriptions.js";
import type { PlanModeNotificationSink } from "../runtime/plan-notifications.js";
import type { PlanModeStore } from "../state/store.js";
import { ToolInputError, readStringParam } from "./common.js";

interface ToolContext {
  sessionKey?: string;
}

export interface CreateAskUserQuestionToolInput {
  /**
   * Optional PlanModeStore wire. When supplied, the tool body persists
   * the pending-question state into the plan-mode session-extension
   * namespace so cross-surface answering (`/plan answer <text>` on
   * Telegram/Slack/Discord/CLI) can resolve the question.
   *
   * When omitted (input-validation tests), persistence is silently
   * skipped — the tool's return shape is unaffected, and the
   * in-host-equivalent webchat path (Control UI projecting the
   * session-extension into the sidebar) is the same regardless of
   * whether the store is wired (both paths read from the persisted
   * state).
   *
   * Wave-1 W1-F5 fix (2026-05-20). Closes the cross-surface answer
   * gap originally flagged in PR #93 and re-catalogued in
   * `docs/audits/parity-refresh/wave-1-catalog.md:W1-F5`.
   */
  store?: PlanModeStore;
  /**
   * Optional logger for non-fatal persist failures. Defaults to a
   * no-op. Production wiring in `src/index.ts` supplies
   * `{ warn: api.logger.warn }`.
   */
  logger?: {
    warn?: (message: string) => void;
  };
  /**
   * Optional rich-channel notification sink. Production wiring sends
   * Telegram-native question buttons when the host exposes the
   * active-session presentation seam; stable 26.5.18 falls back to
   * typed `/plan answer` when the host returns an unavailable result.
   */
  notifications?: Pick<PlanModeNotificationSink, "notifyQuestion">;
}

const SCHEMA = Type.Object(
  {
    question: Type.String({
      description:
        "The question to ask the user (one or two short sentences). Examples: " +
        '"Should I ship this as 1 PR or split into 3?", "Preserve the legacy ' +
        'config path or migrate it?"',
    }),
    options: Type.Array(Type.String(), {
      minItems: 2,
      maxItems: 6,
      description:
        "2-6 selectable answer options. Each is one short phrase the user can " +
        "click without re-reading the question. The chosen option's text is " +
        "echoed back in the agent's next turn.",
    }),
    allowFreetext: Type.Optional(
      Type.Boolean({
        description:
          "When true, an 'Other...' affordance is added so the user can type " +
          "a custom answer. Use this when your N options might not cover the " +
          "user's intent. Defaults to false (locked to the N options).",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createAskUserQuestionTool(
  opts: CreateAskUserQuestionToolInput = {},
) {
  return (ctx: ToolContext) => ({
    label: "Ask User Question",
    name: "ask_user_question",
    // W1-A3: verbatim in-host description (was a paraphrase).
    description: describeAskUserQuestionTool(),
    parameters: SCHEMA,
    execute: async (
      toolCallId: string,
      args: unknown,
      _signal?: AbortSignal,
    ) => {
      const params = (args ?? {}) as Record<string, unknown>;
      try {
        const question = readStringParam(params, "question", {
          required: true,
        });
        if (!question || question.length === 0) {
          throw new ToolInputError(
            "question required (cannot ask an empty question)",
          );
        }
        const rawOptions = params.options;
        if (!Array.isArray(rawOptions) || rawOptions.length < 2) {
          throw new ToolInputError(
            "options required (provide 2-6 selectable answers)",
          );
        }
        const options = rawOptions
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        if (options.length < 2) {
          throw new ToolInputError(
            "options must contain at least 2 non-empty strings",
          );
        }
        if (options.length > 6) {
          throw new ToolInputError(
            "options must contain at most 6 entries (UI cap)",
          );
        }
        // Reject duplicate option text — would create ambiguous
        // routing when the user picks one.
        const seen = new Set<string>();
        for (const opt of options) {
          if (seen.has(opt)) {
            throw new ToolInputError(
              `options contain duplicate text: "${opt}"`,
            );
          }
          seen.add(opt);
        }
        const allowFreetext =
          typeof params.allowFreetext === "boolean"
            ? params.allowFreetext
            : false;
        // Derive questionId deterministically from toolCallId so the
        // tool result is byte-stable across replays. Random UUIDs
        // would invalidate prompt-cache prefixes.
        // host_ref: src/agents/tools/ask-user-question-tool.ts (PR-10
        //   review H5 fix).
        const questionId = `q-${toolCallId}`;
        // W1-F5 (2026-05-20): persist the pending-question state so
        // the `/plan answer` slash command can resolve it on
        // Telegram/Slack/Discord/CLI. The persist is BEST-EFFORT —
        // failures log at warn and never change the tool result.
        // The webchat path (which reads the same session-extension
        // slot via the Control UI sidebar descriptor) benefits from
        // the same persist, so both surfaces converge on the same
        // source of truth.
        //
        // Persist requires (a) a wired store (production wiring in
        // src/index.ts always supplies it; tests may omit), (b) a
        // sessionKey from the tool context (tool-result events
        // always carry it in production; some legacy tests stub
        // without it). When either is absent, skip silently and
        // emit a single debug-level warn — the tool's contract is
        // input-validation; persistence is the W1-F5 extension.
        if (opts.store && ctx.sessionKey) {
          try {
            const result = await opts.store.persistPendingQuestion({
              sessionKey: ctx.sessionKey,
              questionId,
              questionPrompt: question,
              options,
              allowFreetext,
            });
            if (result.kind === "failed") {
              opts.logger?.warn?.(
                `ask_user_question: persistPendingQuestion failed (sessionKey=${ctx.sessionKey} questionId=${questionId}): ${result.error.message}`,
              );
            } else {
              try {
                await opts.notifications?.notifyQuestion({
                  sessionKey: ctx.sessionKey,
                  questionId,
                  questionPrompt: question,
                  options,
                });
              } catch (notifyErr) {
                opts.logger?.warn?.(
                  `ask_user_question: notifyQuestion failed (sessionKey=${ctx.sessionKey} questionId=${questionId}): ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
                );
              }
            }
          } catch (persistErr) {
            // Defense-in-depth: persistPendingQuestion already
            // catches + returns kind:"failed"; this guards against
            // a future refactor that lets a throw escape.
            opts.logger?.warn?.(
              `ask_user_question: persistPendingQuestion threw (sessionKey=${ctx.sessionKey} questionId=${questionId}): ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
            );
          }
        } else if (!opts.store) {
          opts.logger?.warn?.(
            `ask_user_question: no store wired — pending-question persistence skipped (cross-surface /plan answer will not work). questionId=${questionId}`,
          );
        } else {
          // store present but no sessionKey — typically a tool-call
          // outside a session context. The tool itself remains valid
          // for input-validation; persistence is just skipped.
          opts.logger?.warn?.(
            `ask_user_question: no sessionKey on context — pending-question persistence skipped. questionId=${questionId}`,
          );
        }
        const text = `Question submitted to user: "${question}" (${options.length} options).`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            status: "question_submitted" as const,
            questionId,
            question,
            options,
            allowFreetext,
          },
        };
      } catch (err) {
        if (err instanceof ToolInputError) {
          return {
            content: [
              {
                type: "text" as const,
                text: `ask_user_question: ${err.message}`,
              },
            ],
            details: {
              status: "invalid-input" as const,
              error: err.message,
            },
          };
        }
        throw err;
      }
    },
  });
}
