# 07 — PR Ladder: Option C Plugin Port

**Status:** dependency-ordered, test-gated PR roadmap. 14 PRs to 100% parity.
**Architecture:** Option C (Hybrid — `PlanModeStore` + decomposed `tools/gates/prompt/lifecycle/ui/actions`).
**Source of truth:** `/Users/lume/repos/openclaw-pr70071-rebase` @ tip `ea04ea52c7`; race-fix anchor `1081067476`.
**Hard rules:** each PR <600 LOC code (excl. tests), self-contained, ≥1 new test gate, ≥1 Eva smoke. First 3 PRs revertable to bare repo; live integration smoke by PR-5.

Three blocks: **Foundation (PR-1..3, revertable)** — manifest, store, helpers. **Core race-fix loop (PR-4..8, Eva-1, Eva-2)** — tools, gate, sync-write persistence. **Hardening + UX (PR-9..14, Eva-3, Eva-4)** — prompt, retry, rejection, UI.

Totals: ~5,060 code LOC + ~6,815 test LOC. 100% parity at PR-14.

---

## PR-1: Plugin skeleton + manifest + bare entry

**Scope:** scaffolding only — no host integration, no state writes. `definePluginEntry({id, register})`, manifest with empty `configSchema`, `index.ts` registers nothing.
**Depends on:** none, foundation.
**LOC estimate:** ~120
**Files added/modified:**
- `package.json` (NEW) — `openclaw.extensions: "dist/index.js"`, `engines.node: ">=22.14"`
- `openclaw.plugin.json` (NEW) — `id: "plan-mode"`, `version: "0.1.0"`
- `tsconfig.json`, `vitest.config.ts` (NEW)
- `src/index.ts` (NEW) — `definePluginEntry({ id: "plan-mode", register: () => {} })`
- `README.md` (NEW) — porting status (not a parity claim)

**Test gate:**
- `test/plugin-loads.test.ts` — asserts `id === "plan-mode"` and zero registrations on a fresh `Api` fake.

**Eva-runnable smoke:**
- `pnpm install && pnpm build && pnpm vitest run` succeeds. `openclaw plugin install ./dist && openclaw session start` — zero crash, no plan-mode controls (expected).

**Risk (LOW):** scaffolding only.
**Revertability:** Yes — `git revert` returns to empty. No host coupling.
**Maps to:** none (infra).

---

## PR-2: PlanModeStore + namespace projector

**Scope:** the load-bearing abstraction. Single `"plan-mode"` namespace via `registerSessionExtension`. `PlanModeStore` exposes `readState`, `lockedUpdate(updater)`, `clearState`, `subscribe`. `lockedUpdate` wraps `updateSessionStoreEntry({ update })` — every state write goes through one path. Encodes the race-fix invariant in module space.
**Depends on:** PR-1.
**LOC estimate:** ~210
**Files added/modified:**
- `src/state/types.ts` (NEW) — `PlanModeSessionState` (mode, approval, approvalId, approvalRunId, lastPlanSteps, lastPlanPayloadHash, title, cycleCount, turnCount, autoApprove, rejectionCount, blockingSubagentRunIds, nudgeJobIds, recentlyApprovedAt, recentlyApprovedCycleId, postApprovalPermissions); `DEFAULT_PLAN_MODE_STATE`
- `src/state/store.ts` (NEW) — `createPlanModeStore(api)`; `lockedUpdate` implementation
- `src/state/projector.ts` (NEW) — registers namespace + cleanup callback (`reset|delete|disable|restart`)
- `src/index.ts` (MODIFIED) — wire `createPlanModeStore(api)`, pass to empty registration list

**Test gate:**
- `test/state/store.test.ts` (6 tests) — single-write atomicity, FIFO serialization under concurrent calls, default state, clearState, cleanup callback fires, projector reloads across restart

**Eva-runnable smoke:**
- `openclaw doctor state-integrity` shows the `plan-mode` namespace projecting empty state, no errors.

**Risk (LOW–MED):** store contract becomes load-bearing. Mitigation: copy `updateSessionStoreEntry` signature 1:1 from host `pi-embedded-subscribe.handlers.tools.ts:206-223`.
**Revertability:** Yes — projector removal drops slice; host treats missing namespaces as no-op.
**Maps to:** F3 foundation.

---

## PR-3: Public types + helpers (verbatim ports)

**Scope:** byte-identical port of `types.ts`, `newPlanApprovalId()`, `buildPlanDecisionInjection()` (with `sanitizeFeedbackForInjection`), constants. Pure functions, no store imports.
**Depends on:** PR-1.
**LOC estimate:** ~280
**Files added/modified:**
- `src/types.ts` (NEW) — `PlanMode`, `PlanApprovalState`, `PlanStep`; re-exports state types
- `src/helpers/approval-id.ts` (NEW) — `crypto.randomUUID()`; THROWS on weak fallback (per Appendix M)
- `src/helpers/feedback-sanitizer.ts` (NEW) — U+200B insertion defeats `[/PLAN_DECISION]` envelope escape
- `src/helpers/injections-builders.ts` (NEW) — `buildPlanDecisionInjection`, `buildApprovedPlanInjection`, `buildAcceptEditsPlanInjection` byte-identical to host `approval.ts:111-200`
- `src/constants.ts`, `src/api.ts` (NEW) — `SUBAGENT_SETTLE_GRACE_MS`, `MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE`, barrel

**Test gate:**
- `test/helpers/approval-id.test.ts` (10) — UUID prefix, 1024 distinct values, no weak fallback
- `test/helpers/feedback-sanitizer.test.ts` (8) — copies 8 adversarial cases from host `approval.test.ts:226-247`
- `test/helpers/injections-builders.test.ts` (12) — byte-identical golden output

**Eva-runnable smoke:** plugin installs clean; no behavior change.
**Risk (LOW):** pure functions.
**Revertability:** Yes — pure-function deletion.
**Maps to:** F1/F3/F8/F11/F12 building blocks.

> **Foundation revert window ends here.** PR-1..3 revertable as a unit. PR-4+ touches host SDK seams; reverts then risk orphan state.

---

## PR-4: enter_plan_mode + exit_plan_mode tools

**Scope:** register both tools via `api.registerTool`. `enter_plan_mode` → `store.lockedUpdate(s => ({...s, mode: "plan", cycleId, enteredAt}))`. `exit_plan_mode` validates schema (title ≤80, plan ≥1, ≤1 in_progress) and calls `store.lockedUpdate` with `approval, approvalId, lastPlanSteps, title, lastPlanPayloadHash` — **all in one lockedUpdate**. THIS IS the race fix at module level.
**Depends on:** PR-2, PR-3.
**LOC estimate:** ~520
**Files added/modified:**
- `src/tools/enter-plan-mode.ts` (NEW) — schema `{reason?}`; returns `{status:"entered", mode:"plan"}`
- `src/tools/exit-plan-mode.ts` (NEW) — schema (title ≤80, plan ≥1, summary?, analysis?, assumptions[]?, risks[]?, verification[]?, references[]?); `readPlanSteps()` ≤1 in_progress validation; SHA-1 prefix(12) payloadHash; idempotency guard (match + pending + valid approvalId → reuse); sync write
- `src/tools/register.ts` (NEW) — gated on `config.agents?.defaults?.planMode?.enabled === true`
- `src/index.ts` (MODIFIED)

**Test gate:**
- `test/tools/enter-plan-mode.test.ts` (8) — entered return, fresh-entry cycleId, re-entry preserves cycleId
- `test/tools/exit-plan-mode.test.ts` (18, ported) — title required throw, ≤80 enforcement, ≥1 step, payloadHash determinism, idempotency reuse, archetype field parsing
- `test/tools/exit-plan-mode-race.test.ts` (4, **NEW**) — single-write assertion: instrumented store records exactly one `lockedUpdate` call per `exit_plan_mode`, carrying all of {approval, approvalId, lastPlanSteps, title, lastPlanPayloadHash}. Encodes L.1+L.2.

**Eva-runnable smoke:**
- Agent calls `enter_plan_mode` then `exit_plan_mode`. `openclaw doctor state-integrity` shows `approval === "pending"` with non-empty `lastPlanSteps`.

**Risk (MED):** schema drift silently weakens parity. Copy schema literal from `exit-plan-mode-tool.ts:46-146`.
**Revertability:** Risky — sessions in plan mode leave a state slice. Cleanup callback from PR-2 covers `disable` → wipe.
**Maps to:** F1, F3 (L.1+L.2), F6 (title), partial F11.

---

## PR-5: Eva live-smoke #1 + foundation-stability gate

**Scope:** NOT a code PR — a **process gate**. Per guardrail #5: live integration by PR-5, not PR-47. Eva runs PR-4 build end-to-end against a real gateway. Establishes the `integration-roundtrip` CI job.
**Depends on:** PR-4.
**LOC estimate:** ~180 (harness only; bulk imports existing in-host fixtures)
**Files added/modified:**
- `tests/integration/harness.ts` (NEW) — wraps host `loadSessionStore` test seam
- `tests/integration/plan-enter-exit-roundtrip.test.ts` (NEW) — live store assertion of L.1
- `qa/eva-smoke-1.md` (NEW) — 6-step manual script
- `.github/workflows/integration.yml` (NEW) — `integration-roundtrip` job
- `package.json` (MODIFIED) — `test:integration` script

**Test gate:** integration test above passes. Eva pastes the script: enter → exit → reads `lastPlanSteps` from disk → must show populated steps.

**Eva-runnable smoke:** `qa/eva-smoke-1.md` IS the smoke. Eva comments "Eva-1 green" on PR.

**Risk (HIGH if it fails):** if Eva-1 fails, the abstraction is wrong — return to PR-2. If it passes, the prior failure mode is dead.
**Revertability:** Yes — harness alone is removable.
**Maps to:** F1+F3 (race-fix verified live).

---

## PR-6: Mutation gate (before_tool_call)

**Scope:** port `checkMutationGate` byte-identically. Register `priority: 9999` `before_tool_call` hook returning `{block: true, reason}` for mutation-class tools when `mode === "plan"`. Reads live mode via `store.readState().mode`. Surfaces block to user (per guardrail #8 — no silent block).
**Depends on:** PR-2, PR-3, PR-4.
**LOC estimate:** ~340
**Files added/modified:**
- `src/gates/mutation-gate.ts` (NEW) — `checkMutationGate(toolName, mode, execCommand)`; all constants from host `mutation-gate.ts:27-262` (MUTATION_TOOL_BLOCKLIST, PLAN_MODE_ALLOWED_TOOLS, READ_ONLY_EXEC_PREFIXES, suffix patterns, shell-compound regex, dangerous-flags regex)
- `src/gates/register.ts` (NEW) — `before_tool_call` at `priority: 9999, timeoutMs: 200`
- `src/gates/surface-block-to-user.ts` (NEW) — synthetic tool-result text on block (defeats issue #75)
- `src/index.ts` (MODIFIED)

**Test gate:**
- `test/gates/mutation-gate.test.ts` (34, verbatim port) — blocklist, allowlist, exec prefix allowlist, newline/`;`/`|`/`&`/backtick/`$()`/`<(`/`>(` rejection, dangerous-flag rejection including `-fprint*`, case-insensitive, suffix bypass `.read`/`.search`/etc.
- `test/gates/integration.test.ts` (4) — gate fires BEFORE other plugins (priority); gate-reason surfaces in tool-result.

**Eva-runnable smoke:** Eva enters plan mode, asks agent to `Edit` a file. Gate blocks, Eva sees the reason in chat ("Edit is blocked while planning — exit plan mode first"). No silent retry.

**Risk (MED):** allowlist drift breaks planning for sessions_spawn/yield catch-22.
**Revertability:** Risky during live plan-mode session (agent regains mutation tools).
**Maps to:** F2, partial F10.

---

## PR-7: sessions.patch + snapshot-persister (the F3 gateway wire)

**Scope:** gateway-side mirror. Register `api.registerSessionAction` for approve/edit/reject/answer/auto routing through the store. Subagent gate combining `parentCtx` + `persistedOpenIds`. Emits `[PLAN_DECISION]: ...` via `api.enqueueNextTurnInjection`. Plan-snapshot-persister subscribes to `agent_event` stream for plan events.
**Depends on:** PR-4.
**LOC estimate:** ~590 (tight; will split to 7a/7b if it pushes past 580)
**Files added/modified:**
- `src/actions/approve.ts` (NEW) — subagent gate; resolvePlanApproval; appends to injection queue
- `src/actions/edit.ts` (NEW) — grants `postApprovalPermissions` scoped by approvalId
- `src/actions/reject.ts` (NEW) — feedback required; rejectionCount++; emits `[PLAN_DECISION]: rejected` (sanitized)
- `src/actions/answer.ts` (NEW) — validates approvalId against `pendingQuestionApprovalId`
- `src/actions/auto.ts` (NEW)
- `src/actions/register.ts` (NEW)
- `src/lifecycle/plan-snapshot-persister.ts` (NEW) — subscribes via `api.on("agent_event", ...)`; persists through `store.lockedUpdate`; pre-flight + locked re-evaluation; PLAN_COMPLETE injection via `enqueueNextTurnInjection`
- `src/lifecycle/register.ts` (NEW)
- `src/index.ts` (MODIFIED)

**Test gate:**
- `test/actions/approve.test.ts` (12) — subagent-gate combos, PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS, PLAN_APPROVAL_GATE_STATE_UNAVAILABLE, byte-identical injection text
- `test/actions/edit.test.ts` (8) — postApprovalPermissions scoped + cleared on new cycle
- `test/actions/reject.test.ts` (10) — sanitizer applied, rejectionCount, ≥3 cycles suggestion appended
- `test/lifecycle/plan-snapshot-persister.test.ts` (5, ports + C4 guard) — empty `approvalRunId` THROWS; pre-flight/locked re-eval flips correctly

**Eva-runnable smoke:** Eva runs `/plan accept` after agent emits plan. Agent receives `[PLAN_DECISION]: approved`, resumes against planned steps. **Full race-fix loop verified end-to-end.**

**Risk (HIGH):** largest, tightest PR. Live revert risks sessions stuck in pending. Mitigation: 7a/7b split if LOC >580.
**Revertability:** Risky — pending-state sessions can't be approved by absent handlers.
**Maps to:** F3 (L.3 completion), partial F8, partial F11.

---

## PR-8: Eva live-smoke #2 — full plan→approve→execute→complete

**Scope:** integration harness extension. Eva runs the happy path: agent emits plan → `/plan accept` → agent receives injection → executes → closes.
**Depends on:** PR-7.
**LOC estimate:** ~140
**Files added/modified:**
- `tests/integration/plan-full-cycle.test.ts` (NEW) — drives live gateway through full cycle; asserts `[PLAN_COMPLETE]` injection lands and `planMode` cleared
- `tests/integration/harness.ts` (MODIFIED) — adds `/plan accept` slash-command path
- `qa/eva-smoke-2.md` (NEW) — 8-step manual script

**Test gate:** integration test passes against fresh gateway. Eva-2 result attached.
**Eva-runnable smoke:** the script.
**Risk (MED):** regression bisects to PR-6 (gate) or PR-7 (wiring).
**Revertability:** Yes — integration tests are removable.
**Maps to:** F1+F2+F3+F11 verified live.

---

## PR-9: Plan archetype injection (before_prompt_build)

**Scope:** `before_prompt_build` hook injects `PLAN_ARCHETYPE_PROMPT` + `PLAN_MODE_REFERENCE_CARD` when `mode === "plan"`; "PLAN MODE AVAILABLE" variant when enabled but inactive. Ports `plan-archetype-prompt.ts` verbatim; ports `plan-hydration.ts` for post-compaction.
**Depends on:** PR-2, PR-6.
**LOC estimate:** ~460
**Files added/modified:**
- `src/prompt/archetype-prompt.ts` (NEW) — `PLAN_ARCHETYPE_PROMPT`, `PLAN_MODE_REFERENCE_CARD`, `buildPlanFilenameSlug`, `buildPlanFilename`
- `src/prompt/hydration.ts` (NEW) — `formatPlanForHydration(steps)` post-compaction injection
- `src/prompt/register.ts` (NEW) — appends archetype on `mode === "plan"`; "available" variant otherwise
- `src/index.ts` (MODIFIED)

**Test gate:**
- `test/prompt/archetype.test.ts` (12) — appended on plan mode, not otherwise, respects `systemPromptOverride`
- `test/prompt/hydration.test.ts` (8, ported) — filter ACTIVE_PLAN_STATUSES, `[ ]`/`[>]` markers, hydration header

**Eva-runnable smoke:** archetype visible in `openclaw transcript --debug`. Plan quality jumps measurably.
**Risk (LOW):** additive prompt injection.
**Revertability:** Yes.
**Maps to:** F4, partial F5 (archetype only).

---

## PR-10: ask_user_question tool + auto mode

**Scope:** `ask_user_question` tool with schema `{question, options (2-6), allowFreetext?}`; `questionId = q-${toolCallId}`; duplicate-option rejection. `plan_mode_status` read-only tool. Auto-mode via `session_start` hook reading `agents.defaults.planMode.autoEnableFor[]`. `autoApproveIfEnabled` poll-until-pending (50ms × 40).
**Depends on:** PR-4, PR-7.
**LOC estimate:** ~380
**Files added/modified:**
- `src/tools/ask-user-question.ts` (NEW)
- `src/tools/plan-mode-status.ts` (NEW) — `{inPlanMode, approval, title, approvalRunId, openSubagentCount, ...}`
- `src/lifecycle/auto-enable.ts` (NEW) — `evaluateAutoEnableForMatch(modelId, patterns)` + compiled-regex cache; `session_start` hook
- `src/lifecycle/auto-approve.ts` (NEW) — poll loop, bail-if-flipped-off, error-log on failure
- `src/tools/register.ts` (MODIFIED)

**Test gate:**
- `test/tools/ask-user-question.test.ts` (10) — schema, duplicate-option rejection, questionId determinism
- `test/lifecycle/auto-enable.test.ts` (12) — pattern matching, regex cache, malformed → null
- `test/lifecycle/auto-approve.test.ts` (6) — poll-until-pending, bail, error-log

**Eva-runnable smoke:** with `autoEnableFor: ["gpt-5*"]`, GPT-5 session auto-flips to plan mode. Agent calls `ask_user_question`, Eva sees inline options.
**Risk (MED):** auto-enable misfire on unrelated models.
**Revertability:** Yes — config-gated.
**Maps to:** F5 (full minus archetype-bridge → PR-14).

---

## PR-11: Plan title + turn-limit overrides + closure-gate fields

**Scope:** title validation already in PR-4; this PR adds `maxIterations` (floor 500, replaces auth-count-scaled default), `compaction.reserveTokensFloor`, `PLAN_STEP_STATUSES` constant export, `update_plan` closure-gate fields (`acceptanceCriteria`, `verifiedCriteria`) per step.
**Depends on:** PR-4.
**LOC estimate:** ~280
**Files added/modified:**
- `src/config/zod-schema.ts` (NEW) — Zod for `planMode.{enabled, autoEnableFor, approvalTimeoutSeconds, debug}` + `embeddedPi.{autoContinue.{enabled,maxCycles,stopOnMutation}, maxIterations}` + `compaction.reserveTokensFloor`
- `src/tools/update-plan-extension.ts` (NEW) — additive hook adding closure-gate parsing
- `src/types.ts` (MODIFIED) — export `PLAN_STEP_STATUSES`, `PlanStepStatus`
- `openclaw.plugin.json` (MODIFIED) — declare configSchema knobs
- `tests/config/schema-coverage.test.ts` (NEW) — **guardrail #3** AST scan: every knob referenced in code, no schema-only no-ops

**Test gate:**
- `test/config/zod-schema.test.ts` (15) — every field validates, out-of-range rejected
- `tests/config/schema-coverage.test.ts` (1, guardrail) — every knob has code reference
- `test/tools/update-plan-parity.test.ts` (12, port) — closure-gate fields

**Eva-runnable smoke:** Eva sets `compaction.reserveTokensFloor: 50000`; long session reflects floor in transcript stats.
**Risk (LOW):** additive config.
**Revertability:** Yes — defaults to host behavior when absent.
**Maps to:** F6.

---

## PR-12: Auto-continue + escalating retry + plan nudges + heartbeat

**Scope:** F7 cluster. Retry instructions (PLAN_MODE_ACK_ONLY_RETRY + FIRM, PLAN_APPROVED_YIELD_RETRY + FIRM, PLANNING_ONLY_RETRY + FIRM + FINAL, fast-paths). `agent_end` hook implementing auto-continue (autoContinue.enabled, maxCycles default 3, stopOnMutation default true). Per-session one-shot crons at [10, 30, 60] min (NOT global interval — lesson A6). Heartbeat suppress when approval pending or recent.
**Depends on:** PR-7, PR-9, PR-11.
**LOC estimate:** ~560
**Files added/modified:**
- `src/lifecycle/escalating-retry.ts` (NEW) — `resolvePlanModeAckOnlyRetryInstruction`, `resolveYieldDuringApprovedPlanInstruction`, `resolvePlanningOnlyRetryInstruction`; constants from `incomplete-turn.ts`
- `src/lifecycle/auto-continue.ts` (NEW) — `agent_end` hook implementing cycle loop
- `src/lifecycle/plan-nudge-crons.ts` (NEW) — `schedulePlanNudges`, `cleanupPlanNudges`, `assertSafeCronSessionTargetId`; per-session one-shots; `plan-nudge:Nmin:<sessionKey>` job-name prefix
- `src/lifecycle/heartbeat-suppress.ts` (NEW) — `buildActivePlanNudge` heartbeat-gate

**Test gate:**
- `test/lifecycle/escalating-retry.test.ts` (24) — escalation, recentlyApprovedAt-grace, FIRM/FINAL variants
- `test/lifecycle/auto-continue.test.ts` (16) — stopOnMutation blocks edit, maxCycles default 3, disabled returns immediately
- `test/lifecycle/plan-nudge-crons.test.ts` (12, ported) — per-session one-shots NOT global; cleanup on exit
- `test/lifecycle/heartbeat-suppress.test.ts` (4) — pending approval suppresses, recent updatedAt suppresses

**Eva-runnable smoke:** Eva enters plan mode, idles 10 min → ONE `[PLAN_NUDGE]` (not flood). Approves; agent auto-continues up to maxCycles before yielding.
**Risk (MED):** per-session cron SDK seam may not exist. **Pre-PR audit:** verify `api.schedulePerSessionCron` before PR opens.
**Revertability:** Yes — un-scheduling crons is idempotent.
**Maps to:** F7.

---

## PR-13: Eva-3 + rejection UX + cycle tracking + slash commands

**Scope:** F8 cluster + Eva-3 gate. `/plan {accept|revise|answer|on|off|status|view|auto on|off|restate}` (10 subcommands). `readLatestSessionEntryFresh` disk-read for accept/revise precondition. Rejection injection appends "Multiple revisions have been rejected" at ≥3 cycles. UI revise textarea ships in PR-14; this PR is protocol layer only.
**Depends on:** PR-7, PR-9.
**LOC estimate:** ~480
**Files added/modified:**
- `src/actions/slash-commands.ts` (NEW) — `/plan` surface (10 subcommands); operator-auth gate; foreign-bot disambiguation
- `src/actions/fresh-session-entry.ts` (NEW) — `readLatestSessionEntryFresh`
- `src/actions/cycle-tracker.ts` (NEW) — rejectionCount++; emits suggestion at ≥3
- `tests/integration/plan-rejection-cycle.test.ts` (NEW) — Eva-3 live test
- `qa/eva-smoke-3.md` (NEW) — 8-step rejection script

**Test gate:**
- `test/actions/slash-commands.test.ts` (32, port of `commands-plan.test.ts`) — every subcommand, operator-auth, friendly error mappings
- `test/actions/cycle-tracker.test.ts` (8) — increment on reject, reset on approve, suggestion text at ≥3
- `tests/integration/plan-rejection-cycle.test.ts` — live three-reject flow

**Eva-runnable smoke (Eva-3):** Eva runs `/plan revise "..."` three times → on third, agent receives "Multiple revisions" hint.
**Risk (MED):** large slash-command surface; per-subcommand parity fragile.
**Revertability:** Yes — slash commands unregisterable.
**Maps to:** F8.

---

## PR-14: UI + archetype bridge + manifest finalization + Eva-4

**Scope:** F9 cluster + F5 remainder (`dispatchPlanArchetypeAttachment` Telegram bridge, `persistPlanArchetypeMarkdown` to `~/.openclaw/agents/<agentId>/plans/`). ONE `registerControlUiDescriptor` with `id: "plan-mode"`, `placement: "session-sidebar"` — mode-switcher + plan-card composed in one descriptor (per ARCH §6). Manifest version bump to `1.0.0`, ClawHub-ready metadata. **Eva-4 adversarial smoke gate.**
**Depends on:** PR-12, PR-13.
**LOC estimate:** ~520
**Files added/modified:**
- `src/ui/descriptors.ts` (NEW) — one descriptor consuming projected state; mode-switcher chip + inline approval card + plan-card details/summary
- `src/ui/render-helpers.ts` (NEW) — `renderPlanCard`, `renderInlinePlanApproval` (ports `plan-approval-inline.ts`)
- `src/ui/register.ts` (NEW)
- `src/lifecycle/plan-archetype-bridge.ts` (NEW) — `dispatchPlanArchetypeAttachment` (Telegram); `persistPlanArchetypeMarkdown` with O_CREAT|O_EXCL "wx" + collision suffix 99 + symlink rejection
- `openclaw.plugin.json` (MODIFIED) — version `1.0.0`, full configSchema, `hooks.allowConversationAccess`, ClawHub metadata
- `README.md` (MODIFIED) — full feature list + parity-verified statement
- `tests/integration/plan-adversarial-input.test.ts` (NEW, Eva-4) — 30 adversarial commands; all blocked, no false positives on legitimate read-only
- `tests/integration/plan-full-parity.test.ts` (NEW) — runs all 12 must-have checkboxes from parity-catalog Appendix M as live assertions
- `qa/eva-smoke-4.md` (NEW)

**Test gate:**
- `test/ui/render-helpers.test.ts` (24, ports `plan-cards.test.ts` + `plan-approval-inline.test.ts`)
- `test/lifecycle/plan-archetype-bridge.test.ts` (10, ported) — atomic write, collision suffix, symlink rejection, ENOSPC/EACCES/EIO error class
- `tests/integration/plan-adversarial-input.test.ts` (Eva-4)
- `tests/integration/plan-full-parity.test.ts` — all 12 must-haves verified live

**Eva-runnable smoke (Eva-4):** Eva runs 10 adversarial prompts from `qa/scenarios/gpt54-injection-scan.md`; every one blocked, gate-reason surfaces. Closes plan via UI mode-switcher chip. All 12 features verified visually.
**Risk (HIGH):** final ClawHub-ready PR. v1.0.0 tag gated on Eva-4 + 24h zero-issue canary (guardrail #10).
**Revertability:** No — public release point.
**Maps to:** F9, F5 remainder, F10+F12 verified, F11 ledger complete.

---

## PR Ladder Summary Table

| PR# | Title | Code LOC | Parity features | Cum. % parity | Risk |
|----:|---|----:|---|----:|:---:|
| 1 | Plugin skeleton + manifest | 120 | (infra) | 0% | LOW |
| 2 | PlanModeStore + projector | 210 | F3-foundation | 4% | LOW-MED |
| 3 | Public types + helpers | 280 | F1/F3/F8/F11/F12 bits | 9% | LOW |
| 4 | enter/exit_plan_mode tools | 520 | F1, F3.L.1+L.2, F6.title | 25% | MED |
| 5 | Eva-1 gate (integration harness) | 180 | (validation) | 25% | HIGH-fail |
| 6 | Mutation gate | 340 | F2, partial F10 | 38% | MED |
| 7 | sessions.patch + snapshot-persister | 590 | F3.L.3, F8.partial, F11.partial | 56% | HIGH |
| 8 | Eva-2 gate (full cycle) | 140 | (validation) | 56% | MED |
| 9 | Archetype prompt + hydration | 460 | F4, F5.archetype | 67% | LOW |
| 10 | ask_user_question + auto mode | 380 | F5.tools+auto | 76% | MED |
| 11 | Title + turn limit + closure | 280 | F6 | 82% | LOW |
| 12 | Auto-continue + retry + nudges | 560 | F7 | 90% | MED |
| 13 | Eva-3 + rejection UX + slash | 480 | F8 | 95% | MED |
| 14 | UI + archetype bridge + manifest + Eva-4 | 520 | F5.bridge, F9, F10.full, F12 verified | 100% | HIGH |

**Totals:** ~5,060 code LOC across 14 PRs. Average ~360 LOC/PR. Max 590 (PR-7).

---

## Critical-path PR ladder

**Strict serial critical path (must land in order; each blocks the next):**

PR-1 → PR-2 → PR-3 → PR-4 → **Eva-1 (PR-5)** → PR-6 → PR-7 → **Eva-2 (PR-8)** → PR-9 → ... → PR-14

The race-fix wire (`store.lockedUpdate` from PR-2 + tool-side write from PR-4 + gateway-side persistence from PR-7) is one chain. None of those four can ship out of order without breaking L.1/L.2/L.3. The two Eva gates (PR-5, PR-8) are non-negotiable per guardrail #5.

**Parallel-shippable (after PR-9 lands):**
- **PR-10** (ask_user_question + auto mode) — needs only PR-4 (tools) and PR-7 (routing).
- **PR-11** (title + turn limit + closure) — needs only PR-4 + config schema.
- **PR-12** (auto-continue + retry + nudges) — needs PR-7 + PR-9. Independent of PR-10, PR-11.

PR-10, PR-11, PR-12 form a parallel fan after Eva-2. Three contributors can land concurrently if test isolation holds.

**Serial again from PR-13:** needs PR-12's slash-command primitives. PR-14 needs PR-12 + PR-13.

**Eva-gate ordering (the 4 live smokes):**
1. **Eva-1** (PR-5) — install plugin, enter→exit plan, verify state slice + L.1+L.2 in live disk
2. **Eva-2** (PR-8) — full plan→approve→execute→complete via `/plan accept`; L.3 verified end-to-end
3. **Eva-3** (PR-13) — rejection cycle (3 rejects → suggestion text); F8 verified
4. **Eva-4** (PR-14) — 30 adversarial prompts + full UI verification; F9+F10+F12 verified

**Longest revert window:** PR-1 through PR-3 reverts as a single block (3 PRs, ~610 LOC) returning the repo to bare scaffolding. After PR-4, tools register hooks against the real host SDK; reverts touch live session state and need the projector cleanup callback (PR-2) to wipe orphan slices. PR-1..3 is the only window where a clean "drop the project, change architecture" reversal is mechanical. From PR-4 onward, every revert risks orphan state on a live operator's machine.

---

## Risk audit — top 5 watch items

1. **PR-7 size pressure** — 590 vs 600 cap is fragile. If pre-commit pushes past 580, split into 7a (approve/edit/reject) + 7b (answer/auto + snapshot-persister).
2. **Per-session cron SDK seam (PR-12)** — confirm `api.schedulePerSessionCron` exists before PR-12 opens. If absent, either block on an upstream SDK PR or ship plugin-managed scheduler (+150 LOC, future-deprecation note).
3. **Eva-1 failure mode** — if PR-5 fails, the abstraction is wrong. Stop, don't bridge with more code. The whole point of Eva-1 at PR-5 (not PR-47) is catching architecture flaws cheap (guardrail #5).
4. **Hook timeout discipline** — every hook registers `timeoutMs ≤ 200`. Mutation gate especially must not exceed 50ms; disk-read for `getLatestPlanMode` must be cached with TTL.
5. **PR-14 manifest finalization** — v1.0.0 tag gated on Eva-4 PLUS 24h zero-issue canary (guardrail #10). Plugin doesn't ship until both clear.
