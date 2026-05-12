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
 * pipeline. P-8 ships the TOOL itself (input validation + structured
 * result). Full question→answer wiring (the approval pipeline + the
 * pendingAgentInjections write on user reply) lands at P-11 alongside
 * rejection-cycle tracking.
 */

import { Type } from "@sinclair/typebox";
import { ToolInputError, readStringParam } from "./common.js";

interface ToolContext {
  sessionKey?: string;
}

export interface CreateAskUserQuestionToolInput {
  // No deps in P-8 — the tool is stateless input-validation.
  // P-11 will inject a PlanModeStore reference for question-cycle
  // tracking.
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

const TOOL_DESCRIPTION =
  "Ask the user a clarifying question with 2-6 option buttons. The " +
  "user's choice arrives in the next turn as a synthetic " +
  "`[QUESTION_ANSWER]:` message. Use during plan-mode investigation " +
  "for genuine product/scope tradeoffs where the answer changes the " +
  "plan shape. The session STAYS in plan mode while waiting (this " +
  "tool does NOT exit plan mode). NOT for confirmation requests — " +
  "that's what exit_plan_mode is for.";

export function createAskUserQuestionTool(
  _opts: CreateAskUserQuestionToolInput = {},
) {
  return (_ctx: ToolContext) => ({
    label: "Ask User Question",
    name: "ask_user_question",
    description: TOOL_DESCRIPTION,
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
