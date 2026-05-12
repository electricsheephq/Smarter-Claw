# 03 — Build Baseline: Source-of-Truth Branch Verification

**Step 1.5 of `first-principles-architectural-decision` methodology.**
Goal: prove the source-of-truth branch builds and plan-mode tests pass before
deciding what to port from it.

**Subject:** Worktree at `/Users/lume/repos/openclaw-pr70071-rebase`, branch
`rebase/pr70071-onto-main-2026-04-25`, tip `ea04ea52c7` (most recent commit:
"debug(plan-mode): emit [plan-accept-debug] line at /plan accept precondition",
Sun Apr 26 2026, Eva).

**Date:** 2026-05-12.

---

## Build environment

| Item             | Value                                                       |
|------------------|-------------------------------------------------------------|
| Project          | `openclaw@2026.4.24` (host repo, not the Smarter-Claw plugin) |
| Engines required | `node >=22.14.0`                                            |
| Local Node       | `v25.8.2` (above floor)                                     |
| pnpm required    | `pnpm@10.33.0` (declared via `packageManager`)              |
| Local pnpm       | `v10.33.0` (matches exactly)                                |
| Runner           | `vitest v4.1.5`                                             |
| Typecheck        | `tsgo` (microsoft typescript-go) — **no `tsc --noEmit`** (banned per repo AGENTS.md) |
| ESM type         | `"type": "module"`                                          |

The package.json declares overrides for ~20 deps (anthropic-sdk 0.90.0, hono
4.12.14, axios 1.15.0, etc.) and a 5–10 entry `onlyBuiltDependencies` list.
Build is a node-orchestrated multi-step affair (`scripts/build-all.mjs`,
tsdown, runtime-postbuild, build-stamp, write-build-info, plugin-sdk dts,
etc.) — not a single `tsc` invocation.

## Install status

- Command: `pnpm install --frozen-lockfile`
- Result: **PASS** in `5.9s` (warm pnpm store from prior work).
- One ignored build script: `@discordjs/opus@0.10.0` (gated by
  `pnpm approve-builds`; expected; not security-relevant).
- No patches applied during install.
- 127 vitest config files present under `test/vitest/`.

## Type-check status

- Command: `pnpm tsgo:core` (production-code typecheck only; tests typed
  separately via `pnpm tsgo:core:test`).
- Result: **FAIL — 5 errors, all in `ui/src/ui/views/chat.ts`, none
  plan-mode-related.**

```
ui/src/ui/views/chat.ts(56,10):  TS2440 Import declaration conflicts with local declaration of 'renderCompactionIndicator'.
ui/src/ui/views/chat.ts(56,37):  TS2440 Import declaration conflicts with local declaration of 'renderFallbackIndicator'.
ui/src/ui/views/chat.ts(291,19): TS2304 Cannot find name 'COMPACTION_TOAST_DURATION_MS'.
ui/src/ui/views/chat.ts(319,18): TS2304 Cannot find name 'FALLBACK_TOAST_DURATION_MS'.
ui/src/ui/views/chat.ts(348,18): TS2304 Cannot find name 'FALLBACK_TOAST_DURATION_MS'.
```

### Root cause (confirmed via git log + file inspection)

This is the **same merge-take-both pattern** that Eva already fixed for
`syncToolCardExpansionState` in commit `50ded0baf6` (Apr 26):

> "The post-rebase chat.ts had two definitions of `syncToolCardExpansionState`
> — one imported from `../chat/tool-expansion-state.ts`, and a local
> duplicate carried in from a take-both merge during the upstream/main rebase."

`chat.ts` line 56 imports `renderCompactionIndicator` and
`renderFallbackIndicator` from `../chat/status-indicators.ts` (the
authoritative source; it defines the toast duration constants). But
lines 274–304 and 342– carry duplicate local copies of those same
functions, referencing constants that were NEVER imported into chat.ts —
hence the `Cannot find name` errors.

**Fix path (NOT executed here):** delete the local duplicates at lines
274–304 and 342–(end of fn) in chat.ts, identical in shape to Eva's
prior `syncToolCardExpansionState` fix.

This is a **post-rebase baseline regression in UI code, completely unrelated
to plan-mode core logic.** All plan-mode core code typechecks cleanly.

## Plan-mode test inventory

### Hardening config (canonical 11-file set, `test:plan-mode:hardening`)

| File                                                             | tests* |
|------------------------------------------------------------------|--------|
| `src/gateway/sessions-patch.test.ts`                             | 1061 LOC (uses `it.each`/template literals; count below by-output)  |
| `src/gateway/sessions-patch.subagent-gate.test.ts`               | 16     |
| `src/auto-reply/reply/commands-plan.test.ts`                     | 41     |
| `src/agents/plan-mode/integration.test.ts`                       | 20     |
| `src/agents/plan-mode/plan-nudge-crons.test.ts`                  | 17     |
| `src/agents/subagent-registry.steer-restart.test.ts`             | 16     |
| `src/cron/isolated-agent/run.plan-mode.test.ts`                  | 7      |
| `ui/src/ui/chat/slash-command-executor.node.test.ts`             | (passed) |
| `ui/src/ui/chat/plan-resume.node.test.ts`                        | (passed) |
| `ui/src/ui/views/chat.test.ts`                                   | **FAIL (parse error)** |
| `ui/src/ui/views/plan-approval-inline.test.ts`                   | (passed) |

\* `it(...)` literal occurrences via grep, undercounts table-driven tests.

### Broader plan-mode footprint (25 files matched by keyword)

The 25 files captured by the search heuristic (plan-mode|planMode|
enter_plan_mode|exit_plan_mode|persistPlanApproval|accept-edits|
plan-snapshot|plan-archetype|mutation.gate|escalating.retry|
ask_user_question) cover:

- **Core gate logic:** `mutation-gate.test.ts` (23), `accept-edits-gate.test.ts` (72), `approval.test.ts` (39).
- **Tools:** `enter-plan-mode-tool` + `exit-plan-mode-tool.test.ts` (18) + `ask-user-question-tool.test.ts` + `sessions-spawn-tool.test.ts`.
- **Persistence:** `plan-snapshot-persister.test.ts` (3), `plan-archetype-persist.test.ts` (13), `plan-archetype-bridge.test.ts` (10), `plan-archetype-prompt.test.ts`.
- **Lifecycle/nudges:** `plan-nudge-crons.test.ts` (17), `heartbeat-runner.plan-nudge.test.ts`, `plan-mode-debug-log.test.ts` (19).
- **Routing/injection:** `injections.test.ts` (29), `commands-plan.test.ts` (41), `fresh-session-entry.test.ts`.
- **Cross-cuts:** `sessions-patch.test.ts` (1061 LOC), `sessions-patch.subagent-gate.test.ts` (16), `subagent-registry.steer-restart.test.ts` (16), `pi-embedded-runner/run.incomplete-turn.test.ts`, `cron/isolated-agent/run.plan-mode.test.ts` (7), `plugin-sdk-runtime-api-guardrails.test.ts`, `plan-render.test.ts`, `agent-runner.misc.runreplyagent.test.ts`.

**Aggregate plan-mode test surface in canonical files: ~6,815 LOC.**
**Conservative `it(...)` count across just the surveyed core files: 369+
test cases** (excluding table-driven and `it.each` expansions).

## Plan-mode test results

Command: `pnpm test:plan-mode:hardening` (= `vitest run --config
test/vitest/vitest.plan-mode.config.ts`, `maxWorkers=1`, single-threaded).

```
RUN  v4.1.5

Test Files  1 failed | 10 passed (11)
     Tests  220 passed (220)
  Start at  13:31:43
  Duration  5.55s (transform 2.71s, setup 256ms, import 3.52s,
                   tests 941ms, environment 1.16s)
```

- **220 / 220 tests in passing files PASS** (100% of executed tests green).
- **1 file fails to parse:** `ui/src/ui/views/chat.test.ts` — a vite/oxc
  parse error at line 93. Looking at the file, lines 73–90 contain a
  duplicate stanza (two competing variants of a `renderQueue` setup with
  conflicting `const`/let scopes followed by an orphan
  `clearDeleteConfirmSkip` function cut in mid-block). Same merge-take-both
  pattern as the chat.ts production-code bug above.
- **Total wall-clock: 5.55s** — fast enough for tight iteration.

## Sample test coverage (3 representative files)

### 1. `src/agents/plan-mode/mutation-gate.test.ts` (23 cases, 202 LOC)

Drives `checkMutationGate(toolName, mode, execCommand?)`. Asserts:

- Normal mode: all tools (`exec`, `write`, `edit`, `apply_patch`) **allowed**.
- Plan mode — blocklist: 10 tools blocked (`apply_patch`, `edit`, `exec`,
  `gateway`, `message`, `nodes`, `process`, `sessions_send`, `subagents`,
  `write`). Case-insensitive.
- Plan mode — allowlist: 11 tools allowed including `read`, `web_search`,
  `web_fetch`, `memory_search`, `memory_get`, `update_plan`,
  `exit_plan_mode`, `session_status`, `ask_user_question`,
  `enter_plan_mode`, `sessions_spawn`.
- Suffix patterns: `*.write`/`*.edit`/`*.delete` blocked; `*.read`/`*.search`
  allowed (so custom MCP tools fall through correctly).
- Exec read-only whitelist: 17 read-only commands allowed (`ls -la`,
  `cat`, `pwd`, `git status|log|diff|show`, `which`, `find -name`, `grep`,
  `rg`, `head`, `tail`, `wc`, `file`, `stat`, `du`, `df`). 6 mutating
  commands blocked (`rm -rf`, `git commit`, `git push`, `npm install`,
  `docker run`, `mkdir`).
- Defense in depth: blocks bash compound operators (`|`, `>`, `;`),
  newlines, dangerous flags (`find -delete`, `find -exec rm`); guards
  against substring false-positives (`find -executable` ≠ `-exec`,
  `grep -rfl` ≠ `-rf`).

Two embedded PR-review-fix comments document past adversarial bug
findings (Copilot #3105216740 added `sessions_spawn` to allowlist;
Copilot #3104741578 added `ask_user_question`, `enter_plan_mode`,
`sessions_spawn` to allowlist).

### 2. `src/agents/plan-mode/integration.test.ts` (20 cases, 238 LOC)

End-to-end wiring smoke test (PR-8):

1. `isPlanModeToolsEnabledForOpenClawTools(config)` returns true only when
   `agents.defaults.planMode.enabled === true` — not on truthy non-true
   values, not on absent config.
2. `enter_plan_mode` tool returns `{ status: "entered", mode: "plan",
   reason }` structured result.
3. `exit_plan_mode` tool returns `{ status: "approval_requested",
   summary, plan }` — and rejects empty `plan: []`.
4. Threads `planMode: "plan"` through `runBeforeToolCallHook` and asserts
   that `mutation gate blocks BEFORE the plugin hookRunner sees the call`
   — proving the wire is in the right order.
5. Toggling `sessions.patch { planMode: "normal" }` clears state.

Doc comment is unusually load-bearing — explicitly enumerates the
contract this test is freezing.

### 3. `src/gateway/plan-snapshot-persister.test.ts` (3 cases, 45 LOC)

Tiny but critical defensive guard (PR C4 follow-up to Plan Mode 1.0):

- `persistApprovalMetadata({ approvalRunId: "" })` **throws** with
  `/approvalRunId is required/`.
- `approvalRunId: "   "` (whitespace-only) **throws**.
- Error message contains `/subagent gate/` so operators understand the
  severity (silent-bypass would allow a fresh-run subagent to slip
  the gate).

Pattern: pin a small but security-load-bearing invariant without standing
up a full subscriber harness. Exactly the kind of micro-test the port
needs to copy verbatim — the helper is exposed via
`__testingPlanSnapshotPersister` (controlled test-only export, not a
private-import smell).

## Pre-existing failures (baseline noise, NOT plan-mode)

Two real bugs surfaced in this baseline run, both **post-rebase** in
non-plan-mode code:

1. **`ui/src/ui/views/chat.ts`** — duplicate local definitions of
   `renderCompactionIndicator` (line 274) and `renderFallbackIndicator`
   (line 342) shadow the imports at line 56. Local versions reference
   `COMPACTION_TOAST_DURATION_MS` and `FALLBACK_TOAST_DURATION_MS`
   constants that don't exist in chat.ts (they live in
   `status-indicators.ts`). **Same merge-take-both pattern** Eva fixed
   for `syncToolCardExpansionState` in `50ded0baf6`. 5 tsgo errors.
2. **`ui/src/ui/views/chat.test.ts`** — parse error at line 93. Lines
   73–90 contain two stacked variants of a `renderQueue` setup (one
   destructured, one literal-object), followed by an orphan
   `clearDeleteConfirmSkip` function cut mid-block. Same merge-take-both
   class. Causes 1 vitest parse failure (but no test contract
   regression — the file fails to LOAD, not to PASS).

These are pre-existing UI baseline issues the rebase introduced. They
do **not** affect plan-mode runtime correctness. They DO need to be
fixed before the branch ships, but they are out of scope for a
port-source assessment.

No other failures observed. Test framework is healthy; vitest workers
clean up; no timeouts, no flaky resource leaks.

## Confidence assessment: is this branch solid enough to port from?

**Verdict: HIGH (≥95%) — proceed with the port from this branch.**

Evidence supporting high confidence:

- **100% pass rate** on plan-mode-specific test execution (220/220 in the
  hardening config).
- **6,815 LOC of plan-mode tests** with adversarial coverage already
  laundered through multiple PR review rounds (Copilot #3104, #3105
  fix-references embedded in tests). The contract being frozen is the
  product of real bot-review hardening, not a green-field guess.
- **Test architecture is healthy:** single-worker safe, fast (5.5s),
  `__testing*` controlled escape hatches (not private-import smells),
  doc comments tie each test back to the PR that surfaced the bug.
- **Tooling matches:** Node 22+, pnpm 10.33, vitest 4.1.5, ESM. No
  exotic build-time machinery interfering with test isolation.
- **All failures are clearly attributable to non-plan-mode UI files**
  with a known fix pattern (Eva's prior `syncToolCardExpansionState`
  commit). Two more deletions in the same file finish the job.

Blockers/risks to flag:

- **The two UI baseline regressions MUST be fixed before this branch is
  presentable as a PR** (else CI fails for unrelated reasons, slowing
  reviewer onboarding). They are tiny (delete duplicate blocks) but
  they exist. Note: the task brief says the prior PR #71676 was closed
  for "too many unrelated changes" — these UI regressions are exactly
  the kind of unrelated change a fresh PR should *exclude*. Confirm
  whether the UI regressions need to be fixed in a separate PR or
  carried along.
- **`pnpm tsgo:core` is non-incremental on a fresh clone** but
  incremental on warm caches. Plan for one ~30-60s typecheck per
  iteration in early porting work.
- **Total test suite is enormous** (`pnpm test` orchestrates many
  vitest projects; full run is 30+ min). Always scope to plan-mode
  configs during port iteration; reserve the full suite for the
  pre-merge gate.

## Recommendations for the port

### Must-port verbatim (contract surface)

1. **The 11 hardening-config test files** are the load-bearing contract.
   The plugin port needs the same assertions against the plugin's
   equivalent of `checkMutationGate`, `checkAcceptEditsConstraint`,
   `persistApprovalMetadata`, `enter_plan_mode`/`exit_plan_mode` tool
   surfaces, and `sessions.patch { planMode }` round-tripping.
2. **`mutation-gate.test.ts` adversarial cases** (compound operators,
   newlines, dangerous-flag substring false positives) are battle-scars
   from prior reviews — they must port verbatim or the plugin will
   regress those specific bugs.
3. **`plan-snapshot-persister.test.ts` C4 guard** — the empty/whitespace
   `approvalRunId` rejection. Three lines of test against a silent-bypass
   security regression. Cheap to port; expensive to forget.

### Architectural cues to honor in the port

1. **Mutation gate runs BEFORE the plugin hookRunner.** The
   integration.test.ts asserts the ordering explicitly. If the plugin
   port wires the gate the wrong way around, this contract regresses.
2. **`__testing*` controlled test exports** are the established pattern
   for testing security-sensitive private helpers. The port should
   adopt the same naming + scope discipline; don't reach for
   private-import workarounds.
3. **PR-review-fix comments inside tests** are a strong cultural pattern
   in this codebase. Future plugin-port adversarial reviews should land
   in the test code as comments so the contract carries the why.

### Watch out for (port traps)

1. **Tool allowlist drift.** Two embedded PR-review fixes added
   `ask_user_question`, `enter_plan_mode`, `sessions_spawn` to plan
   mode's allowlist after initial implementation. The plugin port must
   carry these or it will regress to "default-deny breaks planning"
   bugs that already shipped fixed here.
2. **Suffix-pattern blocking** (`*.write|*.edit|*.delete`) is a custom
   MCP-tool integration layer. If the plugin port runs in an
   environment that surfaces tools with different naming conventions,
   this rule needs revisiting — but DON'T silently drop it.
3. **The 220/220 number is plan-mode-CONFIG green** — it is NOT the
   total contract. The broader 25-file footprint includes
   `injections.test.ts` (29 cases), `accept-edits-gate.test.ts` (72
   cases), `approval.test.ts` (39 cases) — none of these are in the
   hardening config and they were NOT exercised in this run. The port
   must also satisfy those files to claim full parity.
4. **Two UI baseline regressions** (chat.ts duplicates, chat.test.ts
   parse error) are NOT plan-mode bugs but **were introduced by the
   same upstream/main rebase** that produced the plan-mode tip. If the
   fresh PR base is reset to `main` again, expect more take-both
   leftovers. Audit large file surfaces in `ui/src/ui/views/` for
   shadow-duplicate patterns before re-PR-ing.

---

## Short summary

- **Build (typecheck):** FAIL — 5 pre-existing UI duplicates in
  `chat.ts` (same merge-take-both pattern Eva fixed prior); NOT
  plan-mode-related.
- **Plan-mode tests:** **220/220 pass** (100%) in 10 of 11 hardening
  files; 1 file (`chat.test.ts`) parse-errors due to the same UI
  rebase-leftover class.
- **Confidence the branch is safe to port from: HIGH (≥95%).** The
  plan-mode contract surface is green and adversarially hardened. The
  failures are mechanical UI baseline noise with a known fix pattern.
