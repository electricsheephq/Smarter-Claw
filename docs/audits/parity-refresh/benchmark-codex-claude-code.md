# Benchmark: Smarter-Claw Plan Mode vs Codex CLI & Claude Code

**Date**: 2026-05-19
**Author**: parity-refresh audit
**Scope**: formal feature-by-feature comparison of the Smarter-Claw plan-mode
plugin (`1.0.0-port.15`, against `openclaw@2026.5.10-beta.5`+) against the two
industry references — **Codex CLI plan mode** and **Claude Code plan mode** —
both as of May 2026.
**Quality bar (operator)**: "as good as Codex's built-in plan mode, or Claude
Code's plan mode — if not better."

This document is deliberately adversarial. The goal is to find the rows where
the references genuinely beat Smarter-Claw, not to flatter the plugin. Every
`⚠️` / `❌` carries a concrete finding feeding the Wave-1 catalog.

---

## Method & sources

- **Smarter-Claw**: read of the plugin source (`src/tools/*`, `src/gates/*`,
  `src/prompt/*`, `src/runtime/escalating-retry.ts`, `src/plan-mode/*`,
  `src/ui/*`), `README.md`, `RELEASE_NOTES.md`, and the
  `docs/audits/wave-1.5-post-surgical-summary.md` feature roll-up.
- **Codex CLI**: `developers.openai.com/codex/cli/features`,
  `developers.openai.com/codex/changelog`, the SmartScope and danielvaughan
  plan-mode write-ups, OpenAI mobile/Slack release notes (see Sources).
- **Claude Code**: `code.claude.com/docs/en/permission-modes` (authoritative),
  plus the anyonebuilds 2026 guide.

A caveat on the references: Codex plan mode is **prompt-level only — there is
no runtime sandbox** that physically blocks mutations (documented explicitly
in the OpenAI-community/SmartScope material). Claude Code plan mode IS
runtime-enforced (`plan` permission mode, reads-only, protected paths). This
asymmetry matters for several rows below.

---

## Comparison matrix

Legend: ✅ = Smarter-Claw at-or-above parity · ⚠️ = present but weaker ·
❌ = missing.

| # | Capability | Smarter-Claw | Codex CLI | Claude Code | SC verdict |
|---|---|---|---|---|---|
| 1 | **Plan entry** | `enter_plan_mode` tool (agent-driven) + `/plan enter` + `/plan-mode` slash + model-pattern auto-enable (`autoEnableFor`) | `/plan [desc]` slash + `Shift+Tab` cycle (Plan/Pair/Execute) | `Shift+Tab` cycle + `/plan` prefix + `--permission-mode plan` + `defaultMode` | ✅ |
| 2 | **Read-only investigation phase** | Mutation gate enforces it in code; system prompt names allowed read tools + a logs-investigation heuristic | Read-only/consultative; up to ~4 rounds of clarifying questions; **prompt-level only** | `plan` mode: reads + exploratory shell allowed, no source edits; runtime-enforced | ✅ |
| 3 | **Mutation blocking (enforcement)** | `checkMutationGate` — fail-closed allowlist + suffix patterns + read-only exec-prefix list + dangerous-flag regex + shell-operator block; 116 adversarial cases | **None** — plan mode is a prompt instruction, no runtime block | Runtime: `plan` mode is reads-only; protected paths never auto-approved | ✅ |
| 4 | **Plan presentation / format** | Structured `exit_plan_mode(title, plan[], summary, analysis, assumptions, risks[], verification[], references[])` — a decision-complete archetype | Structured plan (steps, files, acceptance criteria) rendered in a dedicated TUI view | Numbered plain-English plan in the terminal | ✅ |
| 5 | **Approval UX (approve / edit / reject)** | Approve / Edit / Reject / Cancel via sidebar + `/plan accept\|edit\|reject\|cancel`; stale-event guard; terminal-state guard | Approve / edit / reject inline in the TUI plan view; can approve/reject steps inline | Approve (3 sub-modes) / keep-planning / reject; `Ctrl+G` opens plan in `$EDITOR` | ⚠️ |
| 6 | **Plan-mode nudges / incomplete-turn retry** | `escalating-retry.ts` — 3 detectors (PLAN_ACK_ONLY / PLAN_YIELD / PLANNING_RETRY), 2–3 escalation tiers, completion-guard | Plan-mode nudges + "action-required" terminal titles (added 2026) | No documented automatic retry/nudge; relies on prompt + user | ✅ |
| 7 | **Clarifying questions** | `ask_user_question` (2–6 options, optional freetext); stays in plan mode; answer arrives as `[QUESTION_ANSWER]:` | Native clarifying-question rounds (~4) before plan; first-class in the loop | Claude can ask in chat; no structured option-button tool in `plan` mode | ⚠️ |
| 8 | **Idle / action-required notification** | None — no idle nudge fires while an approval is pending; no surface-side "needs you" signal | "Action-required" terminal title + plan-mode nudges; mobile push to approve/deny | Terminal bell / OS notification on completion (Claude Code general); plan prompt is in-terminal | ❌ |
| 9 | **Plan persistence** | None — plan lives in session-extension state only; no markdown file is written despite the prompt/reference-card promising `plan-YYYY-MM-DD-<slug>.md` | Session-only; teams hand-roll a `PLANS.md`. No automatic persisted artifact either | Session-only; "close and reopen, plan mode is off"; **but** approving a plan auto-names the session from plan content | ⚠️ |
| 10 | **Auto-approve mode** | `autoApprove` flag + `/plan auto on\|off` + `setAutoApprove` mutator; gate reads it. Runtime that actually *fires* auto-approve on `exit_plan_mode` is **not wired** (RELEASE_NOTES known-limitation #3) | Approval modes (`/permissions`): auto / read-only / full-access | `auto` mode with a separate classifier model; approve-into-auto from the plan prompt | ⚠️ |
| 11 | **Archetype / quality steering** | `PLAN_ARCHETYPE_PROMPT` (decision-complete standard) + `PLAN_MODE_REFERENCE_CARD` (state diagram, tool contract, pitfalls) injected every in-mode turn | Recommended plan templates A/B/C in docs — guidance, not enforced/injected | No injected archetype; relies on base model + user spec quality | ✅ |
| 12 | **Post-approval constraint gate** | `checkAcceptEditsGate` — 3 hard constraints (destructive / self-restart / config-change) override `acceptEdits`; shell-escape detection; 72 adversarial cases | None specific to plan execution — governed by the general approval mode | `acceptEdits` mode + protected-path list + (in `auto`) a safety classifier | ✅ |
| 13 | **Rejection-cycle handling** | `rejectionCount` tracked; `[PLAN_DECISION]: rejected` injection carries feedback; de-escalation hint at ≥3 rejections | Reject + iterate; no documented cycle counter or escalating guidance | Type feedback → Claude revises → re-presents; no documented cycle counter | ✅ |
| 14 | **Cross-platform / multi-surface (Telegram, Slack, web, mobile)** | `/plan` registered with no channel filter (works on every channel); but approval **buttons** are sidebar-only — Telegram/Slack get text commands, no inline buttons; no mobile push | Slack integration (mention `@Codex`); ChatGPT mobile app — approve/deny pending commands, view diffs, from phone | Web (`claude.ai/code`), Desktop, VS Code, JetBrains, mobile, Remote Control — plan mode in mode selector across all | ❌ |
| 15 | **Plan-tier model override** | `planTierModel` config routes plan-mode turns to a stronger model (`before_model_resolve`) | Not a documented feature | Not a documented feature (single `/model` per session) | ✅ |
| 16 | **In-chat / inline plan card UI** | None in v0.x — sidebar widget only. Inline plan cards, mode-switcher chip, input-bar suppression all deferred to v1.0 (upstream SDK seam blocked) | Dedicated inline TUI plan view; inline step approval | Plan presented inline in the terminal/IDE; mode shown in status bar | ❌ |

---

## Matrix verdict

**16 rows scored**: **8 ✅** · **5 ⚠️** · **3 ❌**.

The plugin's *enforcement core* is its genuine strength — rows 2, 3, 6, 11,
12, 13, 15 are all at-or-above parity, and several (3, 12, 15) are things
neither reference offers at all. Where it falls down is the **delivery and
last-mile surface**: notification (row 8), persistence (row 9), multi-surface
parity (row 14), and inline UI (row 16). Those are exactly the things a user
*sees and touches*, which is why the operator's "as good as, if not better"
bar is not yet met despite a stronger backend.

---

## Findings — where the references genuinely beat Smarter-Claw

### F1 — No "action-required" notification when an approval is pending (row 8) — `❌`

**What the references do.** Codex CLI added **plan-mode nudges and
"action-required" terminal titles** specifically so a user who walked away
knows the agent is *blocked on them*. The Codex mobile app pushes a
notification to approve/deny from a phone. Claude Code rings the terminal bell
/ fires an OS notification.

**Smarter-Claw today.** When `exit_plan_mode` fires, the plan sits in
`approval: "pending"` indefinitely (timeout default 600s only flips state, it
does not *alert*). The reference card even documents that `[PLAN_NUDGE]:` is
**suppressed when pending** — i.e. the plugin deliberately goes *quiet* exactly
when the user most needs poking. There is no terminal-title change, no bell,
no channel ping.

**Recommendation: ADOPT.** Highest-leverage, lowest-risk gap. (a) Set an
"action-required" terminal/window title or emit an OS bell on
`persistApprovalRequest`. (b) On channel surfaces (Telegram/Slack), send a
short "Plan ready for your approval — /plan accept | reject" message when the
approval is persisted. This needs no new SDK seam — the session-action layer
already knows the moment the plan goes pending. **Wave-1 priority: P0.**

### F2 — Plan is never persisted to a file, despite the prompt promising it (row 9) — `⚠️`

**What the references do.** Both references are *also* session-only — so this
is not "the references have persistence and we don't." The finding is sharper:
Smarter-Claw's own `PLAN_ARCHETYPE_PROMPT` and `PLAN_MODE_REFERENCE_CARD` tell
the model the `title` "becomes the persisted markdown filename
(`plan-YYYY-MM-DD-<slug>.md`)" — **but no code writes that file.** The plugin
ships a prompt contract it does not honor.

Separately, Claude Code does one persistence-adjacent thing the plugin lacks:
**approving a plan auto-names the session from the plan content.**

**Recommendation: ADOPT (partial).** Either (a) actually write the
`plan-YYYY-MM-DD-<slug>.md` artifact on approval so the prompt is truthful, or
(b) remove the persisted-filename claim from the archetype prompt and reference
card so the model is not lied to (a model that believes a file exists may
reference it). (b) is a 5-minute honesty fix and should land immediately; (a)
is the better long-term answer. Also adopt Claude Code's **auto-name-session-
from-plan-title** on `plan.accept` — cheap, the `title` is already in state.
**Wave-1 priority: P1 (prompt-honesty sub-fix is P0).**

### F3 — No multi-surface parity: approval buttons are sidebar-only (rows 14, 16) — `❌`

**What the references do.** Codex runs plan approval in **Slack** (`@Codex`
mention) and the **ChatGPT mobile app** (approve/deny, view diffs from a
phone). Claude Code exposes plan mode across **web, Desktop, VS Code,
JetBrains, mobile, and Remote Control** — the mode selector and plan prompt
render natively on each.

**Smarter-Claw today.** `/plan` slash commands are channel-agnostic (good),
but the *approval card with Approve/Edit/Reject buttons* is a **sidebar widget
only**. On Telegram or Slack a user gets text and must type `/plan accept`.
Inline plan cards, the mode-switcher chip, and input-bar suppression are all
deferred to v1.0 behind an upstream `registerChatStreamRenderer` SDK seam.

**Recommendation: ADOPT, but acknowledge the blocker.** True inline-card
parity is genuinely upstream-blocked — that part is honest. But two things can
ship *now* without the seam: (a) when an approval goes pending, push a
channel message on Telegram/Slack with the plan summary and the literal
`/plan accept` / `/plan reject` commands (overlaps F1); (b) make the
text-command fallback *discoverable* — today a Telegram user has no signal
that a plan is even waiting. Track inline cards as a v1.0 item but stop
treating "sidebar only" as acceptable for non-webchat surfaces.
**Wave-1 priority: P1.**

### F4 — Auto-approve is a flag with no runtime (row 10) — `⚠️`

**What the references do.** Codex's `/permissions` auto mode and Claude Code's
`auto` mode are *fully wired* — the user picks the mode and the agent actually
proceeds without a prompt (Claude Code even runs a safety classifier on each
action).

**Smarter-Claw today.** `autoApprove` is a real flag with a real mutator and
`/plan auto on|off`, and the accept-edits gate reads it — but RELEASE_NOTES
known-limitation #3 is explicit: "the runtime side that actually FIRES
auto-approve on `exit_plan_mode` (skipping the pending state) lands at P-final."
So today a user can *toggle* auto-approve and it does **nothing** to the
approval flow. That is worse than not having the toggle — it is a control that
lies about its effect.

**Recommendation: ADOPT or HIDE.** Either wire the runtime (on
`persistApprovalRequest`, if `autoApprove` is set, immediately resolve via
`recordApproval` and emit `buildApprovedPlanInjection` — the accept-edits gate
already backstops the 3 hard constraints), or hide/disable the `/plan auto`
command and the sidebar toggle until the runtime exists. A non-functional
safety-relevant toggle is a bug. **Wave-1 priority: P1.**

### F5 — Clarifying questions are not as natural as Codex's loop (row 7) — `⚠️`

**What Codex does.** Codex treats clarifying questions as a **first-class
phase**: it asks up to ~4 rounds of questions *before* it proposes a plan, and
the loop ("describe → questions → answer/proceed → plan") is the documented
default UX.

**Smarter-Claw today.** `ask_user_question` is good — structured 2–6 options,
optional freetext, non-blocking, clean `[QUESTION_ANSWER]:` round-trip — and
arguably *better* than free-text Q&A in isolation. But: (a) the archetype
prompt pushes the model *away* from asking ("Do not ask the user for facts you
can discover locally", "exhaust the read-only investigation surface"), which is
correct for fact-finding but can suppress genuine tradeoff questions; and
(b) `/plan answer` is **not wired** on the slash surface at all
(`slash-commands.ts` explicitly routes the user to the approval card; plugin-
side question-state tracking does not exist) — so on Telegram/Slack a pending
question is *unanswerable* without the sidebar.

**Recommendation: ADOPT the wiring, keep the discipline.** The
"investigate-before-asking" steering is a deliberate quality choice and should
stay. But (b) is a real gap: build plugin-side question-state tracking so
`/plan answer <text>` works cross-surface. Until then a Telegram user hitting
an `ask_user_question` is stuck. **Wave-1 priority: P1.**

---

## Findings — where Smarter-Claw genuinely beats the references

### E1 — Real runtime mutation enforcement (rows 2, 3, 12)

This is the plugin's strongest, most defensible edge. **Codex plan mode is
prompt-level only — there is no sandbox.** Smarter-Claw's `checkMutationGate`
is a *fail-closed* runtime gate: explicit allowlist, mutation/read-only suffix
patterns, a read-only exec-prefix allowlist, shell-operator blocking,
word-boundary dangerous-flag regex — 116 adversarial test cases. On top of
that, `checkAcceptEditsGate` adds three hard constraints (destructive /
self-restart / config-change) that override `acceptEdits` *even at 95%
confidence*, including shell-escape-vector detection (env-var indirection,
subshells, quote concatenation, byte escapes) — 72 more adversarial cases.
Claude Code's `plan` mode is runtime-enforced too, but it has no equivalent of
the post-approval 3-constraint gate. Smarter-Claw is the only one of the three
with defense-in-depth at *both* the plan phase and the execution phase.

### E2 — Escalating incomplete-turn retry (row 6)

Smarter-Claw actively *repairs* the most common plan-mode failure modes.
`escalating-retry.ts` ships three detectors — PLAN_ACK_ONLY (model narrated a
plan as chat instead of calling `exit_plan_mode`), PLAN_YIELD (model yielded
immediately after approval without executing), PLANNING_RETRY (planning-only
narration outside plan mode) — each with 2–3 escalating instruction tiers and
a completion-signal guard so it does not nag a model that legitimately
finished. Codex's "plan-mode nudges" are real but shallower (a terminal-title
hint); Claude Code has no documented automatic retry — a model that edits
without leaving plan mode is a known open Claude Code issue with no
auto-correction. This is a meaningful reliability edge.

### E3 — Injected decision-complete archetype + reference card (row 11)

Every in-plan-mode turn, Smarter-Claw injects `PLAN_ARCHETYPE_PROMPT` (a
decision-complete-plan standard: required fields, quality bar, explicit
anti-patterns) and `PLAN_MODE_REFERENCE_CARD` (state diagram, tool contract,
tag taxonomy, pitfalls). Codex documents plan *templates* but does not inject
or enforce them — they are advice in a docs page. Claude Code relies on the
base model plus the user's spec quality. Smarter-Claw is the only one that
*systematically* steers the model toward a high-quality plan shape rather than
hoping for it — and `planTierModel` (row 15) can additionally route the
planning turn to a stronger model, which neither reference can do.

---

## Wave-1 catalog hand-off

Five findings (F1–F5) feed the Wave-1 catalog. Suggested priority:

| ID | Finding | Adopt? | Priority | SDK-blocked? |
|---|---|---|---|---|
| F1 | Action-required notification on pending approval | Yes | **P0** | No |
| F2 | Persist plan to file *or* stop the prompt promising it | Yes (honesty sub-fix P0) | P0 / P1 | No |
| F3 | Multi-surface approval — channel ping + discoverable fallback | Yes (inline cards v1.0) | P1 | Partly |
| F4 | Wire auto-approve runtime, or hide the dead toggle | Yes | P1 | No |
| F5 | Cross-surface `/plan answer` + question-state tracking | Yes | P1 | No |

The encouraging read: **four of the five gaps need no new SDK seam.** F1, F2,
F4, and F5 are all fixable inside the existing plugin surface (the
session-action layer, the prompt strings, the store). The plugin's backend is
ahead of both references; closing the last-mile delivery gap is mostly wiring,
not architecture.

---

## Sources

- [Features – Codex CLI | OpenAI Developers](https://developers.openai.com/codex/cli/features)
- [Command line options – Codex CLI | OpenAI Developers](https://developers.openai.com/codex/cli/reference)
- [Changelog – Codex | OpenAI Developers](https://developers.openai.com/codex/changelog)
- [Complete Guide to Codex Plan Mode (2026) – SmartScope](https://smartscope.blog/en/generative-ai/chatgpt/codex-plan-mode-complete-guide/)
- [Planning Mode in Practice – Codex Blog (danielvaughan)](https://codex.danielvaughan.com/2026/03/27/planning-mode-in-practice/)
- [Use Codex in Slack | OpenAI Developers](https://developers.openai.com/codex/integrations/slack)
- [OpenAI Codex Is Now on Mobile – buildfastwithai](https://www.buildfastwithai.com/blogs/openai-codex-mobile-chatgpt-app-2026)
- [Choose a permission mode – Claude Code Docs](https://code.claude.com/docs/en/permission-modes)
- [Claude Code Plan Mode: The Complete 2026 Guide – anyonebuilds](https://www.anyonebuilds.com/guides/claude-code-plan-mode)
- [Claude Code Plan Mode 2026: Complete Guide With Shortcuts – Get AI Perks](https://www.getaiperks.com/en/ai/claude-code-plan-mode)
