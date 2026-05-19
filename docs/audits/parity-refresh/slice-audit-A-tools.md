# Parity Refresh — Slice Audit A: tools cluster

**Auditor**: parity-refresh adversarial diff (tools cluster)
**Date**: 2026-05-19
**Scope**: slices S1 (enter/exit tools) + part of S5 (ask_user_question, auto-enable)
**In-host source-of-truth**: branch `rebase/pr70071-onto-main-2026-04-25` @ `ea04ea52c7`
in `/Volumes/LEXAR/repos/openclaw-pr70071-rebase`.
**Post-surgical context**: PR #87 re-ported S1 (enter/exit), PR #88 touched S5 (auto-enable).

---

## Per-file verdict

| Plugin file | In-host counterpart | Verdict |
|---|---|---|
| `src/tools/enter-plan-mode.ts` | `src/agents/tools/enter-plan-mode-tool.ts` | **clean** (sound thick-tool adaptation) |
| `src/tools/exit-plan-mode.ts` | `src/agents/tools/exit-plan-mode-tool.ts` | **drift** — see A1, A2, A6 |
| `src/tools/ask-user-question.ts` | `src/agents/tools/ask-user-question-tool.ts` | **regressed** — description not re-ported (A3) |
| `src/tools/common.ts` | `src/agents/tools/common.ts` | **drift** — no snake_case aliasing (A4) |
| `src/plan-mode/tool-descriptions.ts` | `src/agents/tool-description-presets.ts` | **clean** (byte-identical, but untested — A7) |
| `src/plan-mode/auto-enable.ts` | `src/agents/plan-mode/auto-enable.ts` | **regressed** — byte-identical helper but never wired (A5) |

**Severity counts**: P0 = 0, P1 = 3 (A1, A3, A5), P2 = 4 (A2, A4, A6, A7).

---

## Detailed analysis

### enter-plan-mode.ts — CLEAN

Description via `describeEnterPlanModeTool()` is byte-identical to in-host (verified
char-for-char incl. TOOL LIFECYCLE block + reference-card pointer). `TOOL_OUTPUT_TEXT`
is byte-identical to the in-host inline `text` array. Schema (`reason?` +
`additionalProperties:false`) matches. The thick-tool adaptation (tool body calls
`store.enterPlanMode()` vs in-host runner-intercept) is documented in the header and
sound. `no-session` / `failed` soft-error paths are a plugin-only addition with no
in-host equivalent — justified (plugin has no runner to catch a thrown error). The
`displaySummary` omission is documented (SDK tool shape surfaces only `label` +
`description`); constant still exported for parity. No findings.

### exit-plan-mode.ts — DRIFT

Schema (title, plan, summary, 5 archetype fields) byte-identical to in-host incl. every
field `description`. `readPlanSteps` + `readPlanArchetypeFields` are line-faithful ports.
Title-required guard + 80-char clamp present and correctly ordered (title check BEFORE
plan validation — matches in-host). Findings A1/A2/A6 below.

### ask-user-question.ts — REGRESSED

Schema is byte-identical to in-host (incl. `additionalProperties:false`). Validation
logic (2-6 options, dedupe, trim/filter, deterministic `questionId`) is a faithful port.
**But the tool description was NOT re-ported** — see A3. This is the exact drift class
S1 fixed for enter/exit; S5's surgical PR #88 missed `ask_user_question`'s description.

### common.ts — DRIFT

`ToolInputError` + `readStringParam` are functionally close. The plugin version is a
hand-rewrite, not a copy: it lacks the `status: 400` field, the function overloads, the
`trim`/`allowEmpty` options, and (most importantly) snake_case param aliasing — see A4.

### tool-descriptions.ts — CLEAN (untested)

Byte-identical port of `describeEnterPlanModeTool` / `describeExitPlanModeTool` +
3 display-summary constants. Diff against in-host `tool-description-presets.ts` is empty.
Note: in-host also has `describeAskUserQuestionTool` — the plugin chose NOT to port it
into this file (root cause of A3). Test gap A7.

### auto-enable.ts — REGRESSED (dead code)

`evaluateAutoEnableForMatch` + `compilePattern` + cache are byte-identical to in-host.
**But the function is never called anywhere in `src/`** (grep: only self-references in
the file's own doc comments). In-host wires it into `src/cron/isolated-agent/run.ts:580-605`.
The plugin port restored the helper but not the wiring — see A5.

---

## Findings

| id | severity | type | plugin loc | in-host loc | description | suggested fix |
|---|---|---|---|---|---|---|
| **A1** | P1 | parity-gap | `src/tools/exit-plan-mode.ts:321-364` | `src/agents/tools/exit-plan-mode-tool.ts:~205-280` | **Subagent-completion gate not ported.** In-host `exit_plan_mode` hard-blocks plan submission while spawned subagents are still in flight (throws `ToolInputError` listing pending child run ids) AND enforces a `SUBAGENT_SETTLE_GRACE_MS` settle window after the last subagent returns. The plugin tool body has neither check. The plugin header documents skipping the subagent-gate "depends on host-internal `getAgentRunContext`; the gateway-side gate at sessions-patch.ts remains authoritative" — but the plugin has no gateway-side `sessions-patch.ts` either, so for the plugin there is **no** subagent gate at all. The exit_plan_mode tool *description* still tells the model "the runtime rejects submission with an error listing pending child run ids" (tool-descriptions.ts:76) — a promise the plugin runtime does not keep. Either a real gate must exist or the description over-promises. | Decide: (a) if the plugin genuinely cannot track subagents, soften the `WAIT FOR SPAWNED SUBAGENTS` description clause to drop "the runtime rejects submission…" (it is now a false statement); OR (b) port a plugin-side equivalent gate keyed on whatever subagent-tracking the plugin SDK exposes. Document the decision in the file header — the current header asserts a gateway gate that does not exist in the plugin. |
| **A2** | P2 | parity-gap | `src/tools/exit-plan-mode.ts:438-451` | `src/agents/tools/exit-plan-mode-tool.ts` (`logPlanModeDebug` calls) | **Plan-mode debug-log events not emitted.** In-host `exit_plan_mode` emits two structured debug events (`gate_decision` and `tool_call` with `{title, stepCount, payloadHash}`) via `logPlanModeDebug` + an always-on `agents/exit-plan-gate` subsystem logger. The plugin emits none. Watcher-style log tailers that correlate "plan submitted" with "approval landed" (an Eva live-test workflow) lose this signal in the plugin. | If the plugin has a debug-log sink (check `src/agents/plan-mode/plan-mode-debug-log.ts` analog), emit at least the `tool_call` event on persist. If no sink exists, note the gap explicitly in the file header as a deliberate adaptation rather than leaving it silent. |
| **A3** | P1 | parity-gap | `src/tools/ask-user-question.ts:70-77` | `src/agents/tool-description-presets.ts` `describeAskUserQuestionTool()` | **`ask_user_question` description is a paraphrase, not the in-host string.** The plugin uses a hardcoded ~70-word `TOOL_DESCRIPTION`. The in-host `describeAskUserQuestionTool()` is a 7-clause structured description that additionally carries: (1) the runtime-pauses-your-run behavior, (2) Control-UI-vs-`/plan answer` channel detail, (3) an explicit **USE FOR** list (product/scope/design/priority tradeoffs), (4) an explicit **DO NOT USE FOR** list (things you could grep/read/web_search, AGENTS.md defaults, confirmation requests), (5) the `allowFreetext` pointer. This is the same drift class Wave-1 S1 found for enter/exit — PR #88 re-ported S5's `auto-enable` but missed this description. The plugin's `host_ref:` cites `ask-user-question-tool.ts` but the description does not match it. | Add `describeAskUserQuestionTool()` to `src/plan-mode/tool-descriptions.ts` as a byte-identical port of the in-host preset, export `ASK_USER_QUESTION_TOOL_DISPLAY_SUMMARY` alongside the other two summaries, and have `ask-user-question.ts` import + use it (deleting the local `TOOL_DESCRIPTION`). Mirrors exactly how enter/exit already work. |
| **A4** | P2 | bug | `src/tools/common.ts:27-53` | `src/agents/tools/common.ts:88-120` + `src/param-key.ts` | **`readStringParam` drops snake_case param aliasing.** In-host `readStringParam` reads via `readSnakeCaseParamRaw`, so a tool arg declared `activeForm` is also accepted as `active_form` (and `allowFreetext`↔`allow_freetext`). The plugin's `readStringParam` reads `params[key]` verbatim — no aliasing. A model (or replayed transcript) that emits snake_case keys silently loses those values in the plugin where in-host would accept them. Lower severity because the typebox schema declares camelCase and the SDK normally round-trips the declared casing, but it is a genuine silent behavioral divergence vs the cited `host_ref`. | Either port `param-key.ts`'s `readSnakeCaseParamRaw` and route `readStringParam` through it (full parity), OR update the `common.ts` `host_ref:` comment to explicitly state snake_case aliasing is intentionally dropped and why. Do not leave the citation implying parity it does not have. |
| **A5** | P1 | parity-gap | `src/plan-mode/auto-enable.ts` (whole file) | `src/cron/isolated-agent/run.ts:580-605` | **`evaluateAutoEnableForMatch` is exported but never called — dead code.** The helper is a byte-identical port, but no plugin code invokes it. In-host wires it into the cron isolated-agent path: when `planMode.enabled` is true, `sessionEntry.planMode` is `undefined` (never toggled), and `autoEnableFor` is non-empty, a matching model auto-flips the session into `mode:"plan"` before the turn. The plugin's file header itself claims "this helper restores that capability" and that the `before_prompt_build` hook is the seam — but the hook does not call it. Net effect: a configured `agents.defaults.planMode.autoEnableFor` does nothing in the plugin. | Wire `evaluateAutoEnableForMatch` into the plugin's session-start / `before_prompt_build` seam: read `planMode.autoEnableFor` from config, resolve the session's model id, and if it matches AND the session has no existing plan-mode state, call `store.enterPlanMode()`. Match the in-host guard precisely — do NOT auto-enable when plan-mode state exists with `mode:"normal"` (user explicitly turned it off). Add an integration test. |
| **A6** | P2 | test-gap | `src/tools/exit-plan-mode.ts:429-430` | `src/agents/tools/exit-plan-mode-tool.ts` (`headlineLabel` fallback) | **`summary`-as-headline fallback is untested.** In-host result text falls back `title ?? summary ?? bare-count`. The plugin's persist-branch text uses `title ? ... : ...`; since title is now always required, the summary branch is structurally dead but still present. Tests in `exit-plan-mode.test.ts` only exercise the title-present branch. Minor — the dead branch is harmless, but the divergence-from-in-host (in-host can still hit `summary` if title were ever absent) is unverified. | Either delete the now-unreachable `title ? ...` ternary in the `persisted`/`reused` text (title is guaranteed non-empty past the guard at line 350) and simplify, OR add a test pinning the behavior. Prefer deletion — clamped `title` is always truthy here, so the ternary is misleading. |
| **A7** | P2 | test-gap | `src/plan-mode/tool-descriptions.ts` (whole file) | n/a | **`tool-descriptions.ts` has no direct test.** The byte-identical-port parity contract for `describeEnterPlanModeTool` / `describeExitPlanModeTool` is only checked indirectly by `enter-plan-mode.test.ts` / `exit-plan-mode.test.ts` via loose `toMatch(/substring/)` assertions. A future edit that drops a clause but keeps the matched substring would pass CI. The file's own header says "Do NOT prune for length" — that intent is unenforced. | Add `tests/plan-mode/tool-descriptions.test.ts` that asserts the full strings byte-for-byte against an inline expected constant (or a checked-in fixture copied from in-host). This converts the "byte-identical port" claim from a comment into a guarded invariant — and would have caught A3 had `describeAskUserQuestionTool` been in scope. |

---

## Cross-cluster observations

- **S1 surgical port (PR #87) is correct.** enter/exit descriptions, schema, title-required,
  80-char clamp, archetype fields, and validation ordering all verified at parity. The
  thick-tool adaptation is documented and sound. The remaining S1 gaps (A1, A2) are
  *features the surgical port did not cover*, not regressions of what it did cover.
- **S5 surgical port (PR #88) is incomplete.** It re-ported `auto-enable.ts` byte-for-byte
  but (a) left it unwired (A5) and (b) did not touch `ask_user_question`'s description
  (A3). Both are parity-gaps the S5 PR should have closed.
- **`host_ref:` citation accuracy**: all six files carry a `host_ref:` line. Three are
  precise. Three are misleading and should be corrected as part of the fixes above:
  `ask-user-question.ts` (cites the in-host tool but the description does not match it —
  A3), `common.ts` (cites in-host `readStringParam` but the port silently drops
  snake_case aliasing — A4), and `exit-plan-mode.ts` (header asserts a "gateway-side gate
  at sessions-patch.ts remains authoritative" that does not exist in the plugin — A1).
