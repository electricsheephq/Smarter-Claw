/**
 * Tool descriptions for `enter_plan_mode` and `exit_plan_mode`.
 *
 * **Parity contract**: byte-identical port of
 * `src/agents/tool-description-presets.ts:12-15, 98-145` at commit
 * `ea04ea52c7`
 * (`/Users/lume/repos/openclaw-pr70071-rebase/src/agents/tool-description-presets.ts`).
 *
 * Only adaptation: this file is plan-mode-scoped — the in-host puts
 * every tool preset in one shared file; the plugin only needs the two
 * plan-mode ones. No content adapted.
 *
 * # Why these descriptions are load-bearing
 *
 * Eva's live-test iter-2/iter-3 cycles found the agent demonstrably:
 *   - Halted after enter_plan_mode (no exit_plan_mode follow-up)
 *   - Posted the plan as chat text after exit_plan_mode in the same turn
 *   - Called update_plan with all-terminal steps and expected approval
 *   - Submitted exit_plan_mode before spawned subagents completed
 *
 * Each clause in describeEnterPlanModeTool / describeExitPlanModeTool
 * exists to steer the model away from a specific failure mode that
 * really happened during live testing. Do NOT prune for length.
 *
 * Surgical-port rationale (2026-05-12): Wave-1 audit slice S1 found
 * the prior plugin descriptions had drifted by ~70% — they conveyed
 * the gist but dropped TOOL LIFECYCLE (4-state machine), STOP AFTER,
 * the chat-text-banned clause, the WAIT FOR SUBAGENTS clause, and the
 * reference-card pointer. Re-porting the full strings verbatim is the
 * fix.
 *
 * host_ref: src/agents/tool-description-presets.ts:12-15, 98-145
 */

export const ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY =
  "Enter plan mode — block mutation tools until the user approves a plan.";

export const EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY =
  "Exit plan mode and request user approval of the proposed plan.";

export function describeEnterPlanModeTool(): string {
  return [
    "Enter plan mode for this session.",
    "Mutation tools (write, edit, exec, bash, sessions_send, etc.) become BLOCKED until you call exit_plan_mode and the user approves the proposed plan.",
    "Read-only tools (read, web_search, web_fetch, update_plan) remain available so you can investigate before proposing changes.",
    "Use this when the user explicitly asks for a plan-first workflow, or when the agent wants to confirm a multi-step change before executing.",
    // Live-test iter-2 Bug F: lifecycle clarity. Agent demonstrably
    // misordered tool calls (called update_plan with all-terminal
    // steps and expected approval card; called exit_plan_mode then
    // posted more chat). Spell out the lifecycle so the agent treats
    // these tools as a small state machine.
    "TOOL LIFECYCLE — use the right tool for the right phase: " +
      "(1) enter_plan_mode = ONCE at the start of a planning cycle (no-op if already in plan mode). " +
      "(2) update_plan = DURING investigation/execution to track progress (steps + status). Does NOT submit. " +
      "(3) exit_plan_mode = ONCE when ready to propose. Submits the plan for user approval. " +
      "After approval, mutations unlock — continue executing without re-entering plan mode unless the user requests a NEW planning cycle.",
    // Iter-3 D3: pointer to reference card + self-test for full context.
    "For the full plan-mode reference (state diagram, [PLAN_*]: tag taxonomy, /plan slash commands, common pitfalls, debugging tips): see the bootstrap-injected reference card visible on every in-mode turn. To inspect live plan-mode state at runtime, call `plan_mode_status` (read-only diagnostic).",
  ].join(" ");
}

export function describeExitPlanModeTool(): string {
  return [
    // Live-test iter-2 Bug A + Bug F: this is the FIRST and most
    // important rule. The agent kept emitting chat text after
    // exit_plan_mode in the same turn, which (combined with the
    // post-approval planMode-deletion stale-cache bug) broke the
    // approval flow end-to-end. Hard-stop the agent immediately
    // after the tool call.
    "STOP AFTER THIS TOOL CALL — do NOT emit any further assistant text in the same turn. The exit_plan_mode call IS your final action; trailing chat text breaks the approval card lifecycle and the user gets stuck. If you want to give context, put it BEFORE the tool call OR inside the tool's `summary`/`analysis` fields.",
    "REQUIRED when the session is in plan mode: submits the proposed plan to the user for Approve/Edit/Reject.",
    "When the user asks for a plan while in plan mode, your reply MUST be a brief acknowledgement followed by an exit_plan_mode tool call — do NOT write the plan as a markdown list in chat text, that bypasses the approval flow.",
    // PR-8 follow-up: belt-and-suspenders steer paired with a hard-block
    // runtime check. Eva's post-mortem flagged treating "research
    // launched" as "research complete" as the exact bug this prevents.
    // W1-A1: the in-host description claims "the runtime rejects
    // submission with an error listing pending child run ids" — true
    // in-host (it has a tool-side subagent gate) but FALSE in the
    // plugin, which has no such gate. Shipping that sentence would
    // tell the model the runtime enforces something it doesn't. The
    // steering is kept (the agent SHOULD wait); the false
    // runtime-enforcement claim is dropped.
    "WAIT FOR SPAWNED SUBAGENTS BEFORE CALLING THIS TOOL. If you used sessions_spawn during plan-mode investigation (research, adversarial review, etc.), wait for ALL of them to return their completion messages before calling exit_plan_mode. Treat unresolved children as a blocking dependency of the investigation phase — 'research launched' is not 'research complete.'",
    "Pass the full plan via `plan` using the same shape as update_plan (array of {step, status, activeForm?}).",
    // PR-9 Tier 1: explicit title field. Without this, the agent's chat
    // text leaked into the title slot ("I checked all five VMs..." as
    // the plan title). Title belongs in the tool call, not in chat.
    'ALSO PASS `title` (under 80 chars) — a concise plan name used as the approval-card header AND the persisted markdown filename slug. Examples: "Migrate VM provisioning to golden snapshot", "Fix websocket reconnect race in PR-67721". Do NOT put plan content in `title` — that goes in `plan` and `summary`.',
    "Optionally pass `summary` (one sentence) — surfaced as the subtitle next to the title.",
    "The runtime emits an approval card; the user can Approve (mutations unlock and you proceed), Approve with edits (same), Reject with feedback (you stay in plan mode and revise; feedback arrives in your next turn as [PLAN_DECISION]: rejected), or let it Time Out.",
    "Calling this without an active plan-mode session is a no-op; calling it without `plan` content is rejected.",
    // Iter-3 D3: pointer to reference card + self-test for full context.
    "For the full plan-mode reference (state diagram, [PLAN_*]: tag taxonomy, /plan slash commands, common pitfalls, debugging tips): see the bootstrap-injected reference card visible on every in-mode turn. To inspect live plan-mode state at runtime, call `plan_mode_status` (read-only diagnostic).",
  ].join(" ");
}

/**
 * `ask_user_question` tool description.
 *
 * **Parity contract**: byte-identical port of the in-host
 * `describeAskUserQuestionTool()` at
 * `src/agents/tool-description-presets.ts:32-42` (commit `ea04ea52c7`).
 *
 * Wave-1 finding W1-A3: the prior plugin description was a ~70-word
 * paraphrase that dropped the structured USE FOR / DO NOT USE FOR
 * lists, the channel-answer mechanics, and the `allowFreetext`
 * pointer. Re-ported verbatim — same drift class PR #87 fixed for
 * enter/exit.
 *
 * host_ref: src/agents/tool-description-presets.ts:32-42
 */
export function describeAskUserQuestionTool(): string {
  return [
    "Ask the user a clarifying question with 2-6 selectable options.",
    "The runtime emits a pending question interaction and pauses your run until the user answers. Control UI shows an inline card; non-web channels answer through `/plan answer` text commands (or free text when allowed).",
    "The chosen answer arrives in your next turn as a synthetic user message tagged `[QUESTION_ANSWER]: <answer text>`.",
    "USE FOR: tradeoffs you cannot resolve via local investigation (product/scope choices, design preferences, organizational priorities, ambiguous user intent).",
    "DO NOT USE FOR: things you could grep / read / web_search yourself, trivial defaults already covered by AGENTS.md, or confirmation requests (that's what exit_plan_mode does).",
    "Plan-mode safe: asking a question DOES NOT exit plan mode. The session stays armed and you can submit `exit_plan_mode` after receiving the answer.",
    "Pass `allowFreetext: true` to add an 'Other...' affordance when your N options might not cover the user's intent.",
  ].join(" ");
}
