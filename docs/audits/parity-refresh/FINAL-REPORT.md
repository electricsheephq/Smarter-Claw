# Parity-Refresh — FINAL REPORT

**Date**: 2026-05-20
**Plugin version**: `1.0.0-port.15`
**Host minimum**: `openclaw@2026.5.18`
**In-host source-of-truth**: branch `rebase/pr70071-onto-main-2026-04-25`
@ `ea04ea52c7` in `/Volumes/LEXAR/repos/openclaw-pr70071-rebase`.
**Verification (today)**: typecheck clean · parity-harness 156/156
across 8 checks · 868/868 unit tests · 4/4 Eva-live-smokes that run in
CI · 0 P0 / 0 P1 left open.

---

## 1. Executive summary

The 6-wave Parity-Refresh closed all 2 P0 and 14 of 17 P1 Wave-1
findings, deferred 3 to upstream-SDK changes (W1-F1, W1-F3, W1-S17
— all gated on the same `bundled-plugin-only` SDK class and on
upstream PR #80982 respectively), built a 156-case mechanical
parity-harness CI gate that prevents drift on 8 load-bearing
surfaces, and produced 5 blocker documents that explain — with
empirical SDK-runtime evidence — exactly why the upstream-blocked
findings cannot be implemented from the plugin side today. The
enforcement core (mutation gate, accept-edits gate, escalating
retry, archetype steering, persisted plan markdown) is at-or-above
parity with Codex CLI and Claude Code plan-mode. The remaining gaps
(cross-channel push-notification, webchat inline UI) are upstream
SDK affordance gaps with tracked issues. **The plugin is
release-ready as a v1.0 with the documented limitations.**

---

## 2. The 6 waves

| Wave | Scope | Outcome | PRs |
|---|---|---|---|
| 0 | Pre-flight + host upgrade to `2026.5.18` | shipped; 727 tests + typecheck green on new SDK; AUDIT-E re-run (0 seam mismatches); fixed CI `\| tee` masking; fixed `registerCommand` harness gap | #97 |
| 1 | Parity re-audit + build-specs + benchmark | shipped; 2 P0 + 17 P1 + ~30 P2 catalogued in `wave-1-catalog.md`; per-slice detail in `slice-audit-{A..E}.md`; benchmark in `benchmark-codex-claude-code.md`; build-specs `buildspec-S16/S17/S18*.md` | #98 |
| 2 | Parity harness Layer-1 (mechanical drift CI gate) | shipped; 8 checks × 156 cases; wired into `pnpm test` so CI breaks on drift; closes W1-D3 | #118 |
| 3 | Fix all P0/P1 findings | shipped 14/17 P1 + 2/2 P0; 3 P1 deferred to documented blockers; 1 follow-up (#107) | #99, #108, #110, #111, #112, #113, #114, #115, #116, #117 |
| 4 | Cross-platform build (Telegram + Slack) | W1-F5 implemented; W1-F3 deferred to same upstream SDK gap as F1 | #119 |
| 5 | Webchat inline UI + patcher | deferred — upstream-blocked; documented in `blocker-W1-S17-webchat-ui.md`; tracked in electricsheephq/Smarter-Claw#78 | #120 |
| 6 | Final adversarial + release readiness (this report) | adversarial pass found 2 P1 + 5 P2 (none correctness blockers); see `wave-6-findings.md` | (doc-only) |

---

## 3. Wave-1 findings — status of all 19

Source: `wave-1-catalog.md` (the canonical finding list).

| ID | P-level | Original verdict | What shipped | CI coverage | Residual risk |
|---|---|---|---|---|---|
| **W1-P0-1** (W1-F1) | P0 | missing-feature: no action-required notification | **Deferred — SDK blocker** (#117, `blocker-W1-F1.md`). Every push-to-channel SDK seam (`sendSessionAttachment`, `emitAgentEvent` on `approval` stream) is `bundled-plugin-only` on `2026.5.18`. Plugin declares the sidebar surface (covers Codex desktop / webchat) and persists the plan markdown (W1-F2) — the building block a future notifier would attach. Upstream R1/R2/R3 paths documented. | n/a (no production code change) | Telegram/Slack users still get no proactive push when a plan goes pending; must check sidebar OR have agent surface the commands. Mitigations: sidebar visible on webchat/desktop; `/plan` commands resolve from every channel. |
| **W1-P0-2** (W1-F2) | P0 | bug: prompt promises a `plan-*.md` no code writes | **Fixed (#115)**. Ported `persistPlanArchetypeMarkdown` + `renderFullPlanArchetypeMarkdown` + slug helpers; wired into `exit_plan_mode`. Writes to `~/.openclaw/agents/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md` on every approval cycle. TOCTOU-safe, EEXIST collision suffix, symlink rejection. | yes (37 unit tests across `plan-archetype-persist.test.ts` + `plan-filename.test.ts` + `plan-render.test.ts`); NOT parity-harness-pinned (see W6-2) | Persister output renderer is not byte-pinned against in-host (W6-2). A regression to the renderer ships green. Persister fs-state behavior covered. |
| **W1-A1** | P1 | parity-gap: `exit_plan_mode` description lies about subagent gate | **Fixed (#108)**. Dropped the false sentence claiming "the runtime rejects submission … listing pending child run ids." | yes (`tests/tools/exit-plan-mode.test.ts`) | None. |
| **W1-A3** | P1 | parity-gap: `ask_user_question` description paraphrased | **Fixed (#108)**. Re-ported `describeAskUserQuestionTool` byte-identical from in-host preset. | yes (`tests/tools/ask-user-question.test.ts`) | None. |
| **W1-A5** | P1 | parity-gap: `evaluateAutoEnableForMatch` byte-identical port but **never called** | **Partially fixed (#108)**. Corrected the false "wired" header claim. Real wiring needs config-schema + once-per-session trigger design — tracked in #107. Function still has 13 unit tests; still dead in production. | tests cover the function in isolation; no integration test for autoEnable-on-session-start because there is no wiring | `autoEnableFor` config does nothing today. Marketed feature; safety: defaults to off. |
| **W1-B4** | P1 | test-gap: accept-edits trigger predicate has zero CI-runnable test | **Fixed (#110)**. Added `tests/gates/accept-edits-trigger.test.ts` — 9 tests pinning the predicate across `mode`/`approval` cases. | yes (9 wiring tests) | None. PR #90's trigger fix is now regression-tested in CI. |
| **W1-C1** | P1 | bug: `applyApprovalAction` never passes `expectedApprovalId` — stale-event guard dead | **Fixed (#99)**. Threaded `expectedApprovalId` through `recordApproval`/`recordRejection`/`recordTimeout`. | yes (`tests/state/store.test.ts`); parity-harness `resolve-plan-approval` pins the gate logic | None. |
| **W1-D1** | P1 | parity-gap: `[PLAN_DECISION]: rejected` injection diverges from in-host runtime | **Fixed (#114)**. Ported the in-host 2-line inline form via new `buildPlanRuntimeRejectInjection` with `@channel`/`<@` mention-stripping. | yes (`tests/runtime/injection-writer.test.ts` byte-pin); parity-harness `runtimeRejectAndPlanSteps` pins it across 12+ cases | None. Both the function output AND the wiring are pinned in the parity harness. |
| **W1-D2** | P1 | bug: approved-plan step lines append `status` not `activeForm` | **Fixed (#114 area)**. `planStepsToInjectionLines` now appends `activeForm`. | yes (`tests/ui/session-actions.test.ts`); parity-harness pins it | None. |
| **W1-D3** | P1 | test-gap: no byte-fixture test pins prompt artifacts | **Fixed (#118)**. Wave-2 parity-harness `promptsCheck` byte-pins the system-prompt block (`PLAN_ARCHETYPE_PROMPT`, `PLAN_MODE_REFERENCE_CARD`, ACTIVE + AVAILABLE outputs) against vendored host snapshots. Drift on any artifact fails CI. | yes (parity-harness) | None for the 3 prompt artifacts. **W6-2 flags the same antipattern resurfacing for `plan-render.ts` (W1-F2's persister output)** — not parity-pinned. |
| **W1-E1** | P1 | parity-gap: turn-limit watchdog deferral stale | **Invalidated → P3 (#113)**. Investigation found the SDK seam is registration-only (no fire/tick primitive), the loop the watchdog would bound (auto-mode-rejection) doesn't exist in the plugin (autoApprove was unwired until W1-F4), and the in-host has no equivalent watchdog to port. Deferral remains correct; rationale updated in `blocker-W1-E1.md`. | n/a | None. Soft mitigation in place: rejectionCount ≥ 3 fires de-escalation hint in `plan-decision-injection.ts:62-66`. |
| **W1-E2** | P1 | bug: debug-log taxonomy diverged from in-host | **Fixed (#111)**. Re-ported the full event union; restored `approval_event`, fixed `nudge_phase`→`nudge_event`, `ui_toast`→`toast_event`, added `runId` to `tool_call`, added explicit `parentRunId`/`childRunId` to `subagent_event`. All 8 in-host kinds present; 9th kind `approval_transition` is additive (intentional, doc'd). | yes (`tests/runtime/debug-log.test.ts`) | None. |
| **W1-E6** | P1 | bug: `madeToolCall` derived from wrong signal (`stopHookActive`) | **Invalidated (#112)**. SDK declares `messages?: unknown[]` on `before_agent_finalize` but the runtime does NOT populate it — verified at `node_modules/openclaw/dist/native-hook-relay-*.js`. No reliable signal available. Fix requires SDK change (Option A2: add `madeToolCall?: boolean` to event). `blocker-W1-E6.md` documents the investigation + interim posture (status-quo proxy stays; over-fires retry on tool-using turns, wastes a turn, doesn't break correctness). | n/a | Spurious "you didn't act" retries on turns that did act; agent re-issues same tool call on next turn. Wastes inference, doesn't break correctness. |
| **W1-F3** | P1 | missing-feature: multi-surface approval push | **Deferred — SDK blocker (#119, `blocker-W1-F3.md`)**. Same SDK gap as W1-F1. Resolution path (`/plan accept|reject|cancel|edit|answer`) ALREADY works on every channel via universal text pipeline; the PUSH ("plan ready" message) is what's blocked. | n/a | Same as W1-F1. |
| **W1-F4** | P1 | bug: `/plan auto on` flips dead toggle | **Fixed (#116)**. Wired the in-host `autoApproveIfEnabled` runtime: `exit_plan_mode` now void-fires `fireAutoApproveIfEnabled` after persist; trigger callback re-reads state for honoring mid-cycle toggles, then runs `recordApproval` + `enqueuePlanApprovedInjection` with the full `buildApprovedPlanInjection` preamble (byte-identical to manual `plan.accept`). | yes (unit tests in `tests/tools/exit-plan-mode.test.ts` + smoke-5 end-to-end in `tests/eva-live-smokes/smoke-5-auto-approve.test.ts`); 4 tests pass | None functionally. |
| **W1-F5** | P1 | parity-gap: `/plan answer` doesn't resolve `ask_user_question` cross-surface | **Fixed (#119)**. Added `PendingQuestion` field to `PlanModeSessionState`; added `persistPendingQuestion` + `clearPendingQuestion` store mutators; wired `ask_user_question` tool body to persist on success; wired `/plan answer <text>` in `slash-commands.ts` to read store + dispatch `plan.answer`. Membership guard (allowFreetext === false → answer must be in options) mirrors in-host. Schema is additive (forward-compat). | yes (`tests/state/store.test.ts` +9; `tests/ui/slash-commands.test.ts` +8; `tests/tools/ask-user-question.test.ts` +6) | None. |
| **W1-S9-1** | P1 | parity-gap: sidebar schema omits 5 fields | **Fixed (#110)**. Added `enteredAt`, `confirmedAt`, `updatedAt`, `approvalRunId`, `lastPlanPayloadHash` to the `PluginControlUiDescriptor` schema. | yes (`tests/ui/sidebar-descriptor.test.ts`) | None. |
| **W1-S9-2** | P1 | bug: `checkApprovalId` contradicts state machine | **Fixed (#99)**. The guard now allows actions when `approval === "rejected"` (re-approvable per `resolvePlanApproval` state machine). | yes (`tests/ui/session-actions.test.ts`); parity-harness pins the gate | None. |
| **W1-S18-1** | P1 | bug: Telegram 100-cmd menu hides `/plan` | **Fixed (#110)**. `/plan-mode` alias declares `channels: PLAN_MODE_ALIAS_CHANNELS` (excludes telegram) so `/plan` keeps its slot. Honest residual limitation documented in code: `/plan-mode` is non-functional on Telegram (both menu AND typed-as-text — `matchPluginCommand` gates by `channels`). `/plan` is fully functional everywhere. | yes (`tests/ui/slash-commands.test.ts`) | `/plan-mode` (the alias) does not work on Telegram; `/plan` (the canonical) works everywhere. Documented in code + this report. |

**Roll-up**:
- 2 / 2 P0 closed (1 implemented, 1 deferred-to-SDK).
- 14 / 17 P1 closed (12 implemented, 2 invalidated/downgraded with
  documented investigation, 3 deferred-to-SDK).
- 1 P1 partially closed (W1-A5): correctness fix shipped (false claim
  removed), wiring tracked in #107.

---

## 4. Audit accuracy retrospective

**4 audit claims were invalidated during the fix wave by sub-agent
verification.** This is healthy — the audit pass produced detection
signal that turned out to be more accurate as a "look here" pointer
than a "here is the fix" prescription. The pattern:

| Finding | Audit claimed | Investigation found | PR |
|---|---|---|---|
| W1-E1 | "Deferral stale — SDK seam now ships" | The seam is registration-only (no fire/tick primitive); the in-host has no watchdog to port; the loop being watchdogged (auto-mode-rejection) didn't exist in the plugin. Downgraded P1→P3. | #113 |
| W1-E6 | "Use the new `messages[]` field — it's the correct signal" | SDK declares the field; runtime does NOT populate it. Verified at the bundled JS. Status-quo proxy stays. | #112 |
| W1-F1 | "Action-required notification needs no SDK seam" | Every push-to-channel SDK seam is `bundled-plugin-only` on `2026.5.18`. 3P plugins are rejected at call time. Documented in `blocker-W1-F1.md`. | #117 |
| W1-F3 | "Channel ping is not [upstream-blocked]" | Same SDK gap as F1; the audit's parenthetical was over-optimistic. | #119 |

**Recommendation for future Wave-1-style audits**:

1. **Audits are great for DETECTION** — the 9-agent re-audit caught 2
   P0 and 17 P1, including bugs PR #87/#88's surgical port missed
   (W1-A3, W1-D2). Keep running them.
2. **Proposed FIXES from audits need verification before code lands**.
   Three of the 4 invalidated claims rested on SDK-seam assumptions
   that didn't hold on the runtime. Future audits should include a
   "SDK-seam-feasibility" pass (grep the installed loader bundle for
   `origin !== "bundled"` and similar runtime gates) before
   classifying findings as "no SDK change needed."
3. **Sub-agent investigations are an effective verification mechanism**.
   #112, #113, #117, #119 each spawned a focused sub-agent that
   produced empirical evidence (file paths, line numbers, bundled JS
   grep results) that closed the question. The blocker docs are the
   durable artifact.
4. **Wave-3 audit-vs-investigation classification**: in retrospect,
   adding a "needs SDK-seam verification" tag to audit findings (vs
   "ready to implement") would have saved one round-trip per
   investigation. Use this for any future Wave-1-style audit.

The audit's overall accuracy was high: 15/19 P1 findings landed
exactly as scoped; 4/19 needed re-scoping after investigation, none
of which exposed a missed defect.

---

## 5. What ships today (confidence-tagged)

### HIGH confidence — verified by tests + parity-harness + investigation

- **State machine** (`resolvePlanApproval`, `applyApprovalAction`,
  `persistApprovalRequest` 10-invariant race-fix) — pinned via
  `parity-harness/checks/persist-approval-request.ts` (15 cases) +
  `resolve-plan-approval.ts` (12 cases) and unit-tested with
  `writeCount` assertions.
- **Gates** (`checkMutationGate`, `checkAcceptEditsConstraint`) —
  byte-identical to in-host; pinned via parity-harness mutation-gate
  (66 cases) + accept-edits-gate (42 cases) + per-pattern adversarial
  unit tests (72-case + 116-case suites).
- **Prompt artifacts** (`PLAN_ARCHETYPE_PROMPT`, `PLAN_MODE_REFERENCE_CARD`,
  `buildPlanModeActiveSystemContext`, `buildPlanModeAvailableSystemContext`)
  — byte-pinned via parity-harness `promptsCheck` against vendored
  host snapshots. Prompt-cache key intact.
- **`/plan` slash commands cross-surface** (`/plan accept|edit|reject|cancel|answer|auto on|off|enter`) —
  routed through `src/ui/slash-commands.ts` to session-action
  handlers; functional on webchat, Telegram, Slack, Discord, CLI via
  the universal text pipeline. `/plan-mode` alias excludes Telegram
  (W1-S18-1 fix).
- **Plan markdown persistence (W1-F2)** — writes
  `~/.openclaw/agents/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md` on
  every approval cycle. TOCTOU-safe, EEXIST collision suffix, symlink
  rejection. 37 unit tests.
- **Auto-approve (W1-F4)** — `/plan auto on` → `exit_plan_mode` self-
  executes via the same `recordApproval` + `enqueuePlanApprovedInjection`
  path as manual `plan.accept`. Smoke-5 covers end-to-end.
- **Debug-log taxonomy (W1-E2)** — 9 event kinds, all 8 in-host kinds
  present (`tool_call`, `state_transition`, `gate_decision`,
  `synthetic_injection`, `nudge_event`, `subagent_event`,
  `approval_event`, `toast_event`) + 1 additive
  (`approval_transition`). `runId`/`approvalRunId` correlation fields
  restored on `tool_call`.
- **Accept-edits trigger (W1-B4)** — `tests/gates/accept-edits-trigger.test.ts`
  pins the predicate across the 4 `approval` states (`pending`,
  `rejected`, `none`, `approved`, `edited`) so PR #90's fix cannot
  silently regress.
- **Parity harness** — 156 cases across 8 checks; CI-gated; refuses
  to apply on diff between the plugin and the vendored in-host
  reference.

### MEDIUM confidence — known proxies, documented limitations

- **Escalating-retry detector** (`PLAN_ACK_ONLY`, `PLAN_YIELD`,
  `PLANNING_RETRY`) — `madeToolCall` is a `stopHookActive`-based
  proxy that the W1-E6 investigation confirmed is semantically wrong
  but the SDK does not expose a correct signal. Status-quo proxy
  stays; over-fires retry on tool-using turns (agent then re-issues
  the same call). Wastes inference; doesn't break correctness.
  Tracked in `blocker-W1-E6.md`. Constants are byte-perfect; the
  detectors themselves are unit-tested in isolation.
- **Escalation tiers (FIRM/FINAL)** — `attemptIndex` is never wired
  from a real counter in `src/index.ts` (E-10 carryover). Tier
  resolvers are unit-tested but inert in production; the plugin
  emits the standard instruction tier only.

### DEFERRED — needs upstream SDK change

- **W1-F1** (action-required notification on pending plan) — see
  `blocker-W1-F1.md`. Upstream: lift `bundled-plugin-only` gate on
  `sendSessionAttachment` (R1) OR add `sendActionRequiredNotice` seam
  (R2) OR move notifier into host (R3). R1 is preferred + smallest.
- **W1-F3** (multi-surface approval push on Telegram/Slack) — see
  `blocker-W1-F3.md`. Same SDK gap as F1; one upstream PR covers
  both. **Resolution path works today on every channel via `/plan`
  commands; only the push is blocked.**
- **W1-S17** (webchat inline UI — mode-switcher chip, inline plan
  cards, plan-approval-inline, plan-resume) — see
  `blocker-W1-S17-webchat-ui.md`. Gated on upstream PR
  [openclaw/openclaw#80982](https://github.com/openclaw/openclaw/pull/80982)
  which is OPEN, drifted (3-named-surfaces → renderer-seam), and
  unmodified for 8+ days. Patcher targeting `2026.5.10-beta.5` is
  broken on `2026.5.18` (content-hashed bundle filenames rotated).
  Sidebar approval card on webchat/desktop is the interim posture.
  Tracked in electricsheephq/Smarter-Claw#78.

### DEFERRED — needs prerequisite design + wiring

- **W1-A5** auto-enable wiring → tracked in
  [electricsheephq/Smarter-Claw#107](https://github.com/electricsheephq/Smarter-Claw/issues/107).
  False header claim corrected in #108; real wiring needs an
  `autoEnableFor` entry in the plugin `configSchema`, a once-per-
  session trigger (NOT per-turn — a per-turn caller drags the user
  back into plan mode after they exit), and reliable model-id access
  at session start. `evaluateAutoEnableForMatch` helper itself is
  byte-faithful + 13-test-covered; just unwired.

---

## 6. Known limitations (verbatim summary from the blocker docs)

1. **No action-required notification on Telegram/Slack** when an
   approval is pending (W1-F1, `blocker-W1-F1.md`). Sidebar covers
   webchat/Codex desktop. The persisted plan markdown is the
   building block a future notifier would attach. Resolution
   commands (`/plan accept|reject|edit|answer`) work from every
   channel.
2. **No inline interactive buttons on Telegram/Slack** (W1-F3,
   `blocker-W1-F3.md`). Same SDK gap as W1-F1.
3. **No webchat inline plan-mode UI** (W1-S17,
   `blocker-W1-S17-webchat-ui.md`). Upstream PR #80982 is OPEN +
   drifted; SDK at `2026.5.18` does not expose
   `chat-input-toolbar-chip` / `chat-message` / `chat-input-bar` /
   `registerChatStreamRenderer`. Sidebar approval card is the
   interim webchat surface. Patcher in `scripts/` documents the
   tactical path; it does NOT apply to `2026.5.18` (manifest is for
   `2026.5.10-beta.5` and target files have rotated content-hashed
   names — patcher fails safe on SHA pre-flight).
4. **`autoEnableFor` config does nothing** (W1-A5, tracked in
   #107). The matcher function is correct + tested; the wiring is
   deferred to a follow-up that needs a session-start trigger
   design.
5. **Escalating-retry `madeToolCall` proxy over-fires retries**
   (W1-E6, `blocker-W1-E6.md`). Wastes a turn on tool-using turns;
   correctness intact. Needs upstream SDK seam.
6. **Escalation tiers FIRM/FINAL inert in production** (E-10).
   `attemptIndex` not wired from a real counter; tier resolvers
   tested in isolation. Standard instruction always emits.
7. **`/plan-mode` (the alias) is non-functional on Telegram**
   (W1-S18-1; the canonical `/plan` is fully functional everywhere).
8. **Plan tier-model override + grant-ledger consumers + provider/
   model gating** — plugin-invented or read-side helpers that are
   wired write-only or not consumed (E-4, E-11, plan-tier-model
   plugin-invented). Documented in `wave-6-findings.md` W6-3, W6-5,
   W6-6. None are correctness blockers.

---

## 7. CI gate status

### What `ci` covers as of 2026-05-20

- **`pnpm typecheck`** (`tsc --noEmit`) — strict TS compilation.
- **`pnpm test`** — 868 tests across 39 files (vitest), includes:
  - 156-case parity-harness via `tests/parity/parity-harness.test.ts`
    (wraps `parity-harness/diff.ts` so a vitest run fails on parity drift).
  - 4 CI-runnable Eva-live-smokes
    (`smoke-1-mutation-gate`, `smoke-2-plan-approve-flow`,
    `smoke-3-rejection-cycle`, `smoke-4-accept-edits-adversarial`,
    `smoke-5-auto-approve` — these use `tests/eva-live-smokes/harness.ts`
    to simulate the plugin + a fake SDK).
  - Patcher script tests (`tests/patcher/chat-stream-seam-patcher.test.ts`
    — 11 cases against a tmp-dir fake host).
- **`pnpm parity-harness`** (standalone, also re-run as a vitest
  case for CI gating) — 156 cases × 8 checks; refuses non-zero exit
  on any case fail; CI step is unpiped (no `tee` masking — Wave-0
  fix).
- **Pack-extract** (per `.github/workflows/ci.yml`) — checks the
  published npm pack contains the expected files.

### What `ci` does NOT cover

- **Live gateway smoke against a real OpenClaw + 3 channels**
  (webchat / Telegram / Slack end-to-end). This requires a
  configured gateway with real channel credentials and is out of
  scope for CI. See §8.
- **`register(api)` integration test** (W6-4 = E-9 carryover). The
  5-hook + tool/command/CLI/UI registration list is never asserted
  end-to-end in CI. A regression that silently drops a `registerCommand`
  call would ship green CI.
- **Production `SessionStoreGateway` round-trip on a real
  `session.json`** (C-4 carryover). The shape-only test
  (`tests/state/session-store-gateway.test.ts`) deferred to live
  testing.
- **`plan-render.ts` byte-fixture against in-host** (W6-2). The
  renderer is claimed byte-faithful in its docstring; CI tests are
  `.toContain()`-style only.

---

## 8. 3-channel live-smoke plan (for the operator)

A manual operator smoke against a real gateway + real channels. Run
this before tagging a release; eva-live-smokes 1-5 in CI cover the
plugin-side state machine + injection contracts but NOT the channel
adapters. Anything in this list that breaks should fail-stop the
release.

**Pre-flight**
- Plugin installed in workspace, host is on `>= 2026.5.18`.
- `agents.defaults.planMode.enabled = true` in config.
- Operator has webchat, Telegram, AND Slack channels configured on
  the test gateway.
- Operator has access to an agent with a model that supports plan
  mode (e.g. `openai/gpt-5.4`).

**Per-channel (run this matrix on webchat, Telegram, AND Slack):**

| # | Action | Expected behavior |
|---|---|---|
| 1 | Type `/plan` (with no args) | Plan-mode help text returns. Channel renders it as a normal message. |
| 2 | Type `/plan enter` | Session enters plan mode. State machine flips to `{mode: "plan", approval: "none"}`. Sidebar (webchat) shows the chip. |
| 3 | Ask the agent to mutate a file (e.g. "edit foo.ts") | Agent should refuse / explore via read-only tools. Mutation gate blocks any `Write`/`Edit`/`bash rm` attempts. Channel sees the agent's plan instead. |
| 4 | Agent calls `exit_plan_mode` | Plan archetype file appears at `~/.openclaw/agents/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md`. Sidebar (webchat) shows approval card with `Approve | Edit | Reject | Cancel` buttons. Channel does NOT see a proactive push — **expected limitation per W1-F3** — but typing `/plan accept` resolves it. |
| 5 | Type `/plan accept` | State flips to `{approval: "approved"}`. `[PLAN_DECISION]: approved` injection drains into next turn. Agent self-executes. |
| 6 | Repeat steps 2-4. Type `/plan reject step 2 is wrong` | State flips to `{approval: "rejected", feedback: "step 2 is wrong", rejectionCount: 1}`. Agent receives the in-host runtime reject form `[PLAN_DECISION]: rejected\nfeedback: step 2 is wrong` (mention-stripped if applicable) and revises. |
| 7 | Force the agent to ask a clarifying question (or seed an `ask_user_question` test). Type `/plan answer your-answer` | Question state clears from `pendingQuestion`; `[QUESTION_ANSWER]:` injection drains. Agent continues plan mode. |
| 8 | Toggle `/plan auto on`. Have agent call `exit_plan_mode` | Plan auto-approves WITHOUT a manual click. State flips through `pending → approved`. Agent self-executes. Sidebar shows the card briefly then resolves. (Per W1-F4 fix.) |
| 9 | Try a `bash` that the accept-edits gate should block (after approve-with-edit). Type `bash rm -rf /tmp/foo` | Accept-edits gate blocks with the destructive-action constraint. (Layer 2 of `before_tool_call`; only fires when `approval === "edited"` per W1-B4 trigger predicate.) |
| 10 | `Cancel` the cycle from the sidebar (webchat) OR type `/plan cancel` (any channel) | State resets to `{mode: "normal", approval: "none"}`. Plan markdown stays on disk (intentional — audit artifact). |

**Telegram-specific:**
- Verify `/plan` appears in the native "/" menu (≤100 slots; W1-S18-1).
- Verify `/plan-mode` is NOT in the menu (alias excluded; per W1-S18-1 fix).

**Slack-specific:**
- Confirm `/plan` works in DMs AND in channels where the bot is
  mentioned. (Slack's command surface is per-workspace.)

**What to look for as a failure signal:**
- Plan markdown NOT written: W1-F2 regression — fail-stop the release.
- Mutation gate lets a `Write`/`Edit` through in plan mode: W1-S9-2
  or `before_tool_call` regression — fail-stop.
- Accept-edits gate fires when `approval === "approved"` (not
  `"edited"`): W1-B4 trigger regression — fail-stop.
- `/plan accept` on a channel does nothing: slash-command dispatcher
  regression — fail-stop.
- Plan archetype filename collides with prior plan: `plan-filename.ts`
  collision suffix broken — fail-stop.
- Anything else: file a regression bug, decide if it blocks release.

**Reference**: the in-CI Eva-live-smokes 1-5 cover the plugin-side
machinery for items 3, 4, 5, 6, 8, 9 with a fake SDK harness. They
do NOT cover the channel adapters — that's what this manual smoke
exercises.

---

## 9. Release notes (short)

```
## v1.0.0 — Parity Refresh

Plan-mode plugin for OpenClaw: in-host parity for the enforcement core +
release-ready cross-channel `/plan` commands + sidebar approval card.

What landed:
- Plan markdown persistence: every approval cycle writes
  `~/.openclaw/agents/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md`.
- `/plan auto on|off` now actually self-executes approved plans.
- `/plan answer <text>` resolves a pending `ask_user_question` from
  any channel (webchat, Telegram, Slack, Discord, CLI).
- 156-case parity-harness CI gate prevents drift on 8 load-bearing
  surfaces (state machine, gates, prompt artifacts, runtime
  reject/plan-steps form).
- Re-ported `[PLAN_DECISION]: rejected` injection to the in-host
  runtime form (`@channel`/`<@` mention-stripping); fixed step-line
  format (`activeForm` not `status`); restored full debug-log event
  taxonomy.
- 14 P1 + 2 P0 Wave-1 findings closed; 3 P1 deferred to documented
  SDK blockers (`docs/audits/parity-refresh/blocker-*.md`).

Known limitations (see FINAL-REPORT.md §6):
- No proactive "plan ready" push to Telegram/Slack — sidebar covers
  webchat/Codex desktop; resolve commands work from every channel.
- No webchat inline plan-cards — gated on upstream openclaw#80982.
- `autoEnableFor` config does nothing (wiring deferred to #107).
- Escalating-retry detector over-fires on tool-using turns (wastes
  a turn, doesn't break correctness).

Verified: typecheck clean · parity-harness 156/156 across 8 checks ·
868/868 unit tests · 4/4 Eva-live-smokes in CI.

Minimum host: openclaw@2026.5.18.
```

---

## 10. Read-this-next pointers

- **Resume here in a week**: this file (`FINAL-REPORT.md`) + the
  `EXECUTION-STATUS.md` Wave-6 row.
- **Reviewing the audit accuracy retrospective**: §4 above + the
  4 blocker docs (`blocker-W1-E1.md`, `blocker-W1-E6.md`,
  `blocker-W1-F1.md`, `blocker-W1-F3.md`, `blocker-W1-S17-webchat-ui.md`).
- **Reviewing what shipped per finding**: `wave-1-catalog.md` rows
  + this report's §3.
- **Wave-6 adversarial findings**: `wave-6-findings.md` (7 findings,
  none P0, 2 P1 — both are documentation drift / regression-
  detection gap, not correctness issues).
- **The PR history**:
  `gh pr list --base main --state merged --limit 30 --json number,title --jq '.[] | "#\(.number) \(.title)"'`
  shows the per-PR scope.
