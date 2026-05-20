# Parity-Refresh — Execution Status (durable checkpoint)

**Last updated**: 2026-05-20
**Purpose**: canonical resume-from-here state for the Smarter-Claw
plan-mode parity-refresh + release-readiness effort. The `~/.claude`
plan file is NOT reliable (it gets recycled by other projects) — **this
in-repo, git-committed doc is the source of truth.** A compacted or
fresh session reads this first.

---

## The effort — 7 waves

A reboot/refresh to get the plan-mode plugin truly release-ready:
cross-platform approval + plan mode + commands all working, UI
complete, quality at-or-above Codex / Claude Code plan mode.

| Wave | Scope | Status |
|---|---|---|
| 0 | Pre-flight + host upgrade to OpenClaw `2026.5.18` | ✅ **merged (PR #97)** |
| 1 | Parity re-audit + build-specs + Codex/CC benchmark | ✅ **merged (PR #98)** |
| 2 | Parity harness Layer 1 (mechanical drift CI gate) | ✅ **merged** (closed #106) |
| 3 | Fix all P0/P1 findings | ✅ **merged** — F1 deferred (SDK blocker, `blocker-W1-F1.md`); see "Done" below for cluster status |
| 4 | Cross-platform build (Telegram + Slack) | ✅ **merged** — F5 implemented; F3 deferred (SDK blocker, same as F1 — see `blocker-W1-F3.md`) |
| 5 | Webchat inline UI + patcher | ⛔ **deferred — upstream-blocked** (see `blocker-W1-S17-webchat-ui.md`; gated on openclaw/openclaw#80982) |
| 6 | Final adversarial + 3-channel smoke + release | ✅ **completed** — see `FINAL-REPORT.md` (release-readiness consolidation) + `wave-6-findings.md` (7 adversarial findings, 0 P0, 2 P1, 5 P2 — none correctness blockers). 3-channel live smoke OUT OF SCOPE this wave (no live gateway w/ all 3 channels); documented manual smoke plan in FINAL-REPORT.md §8 for the operator. |

---

## Done

- **Wave 0 (PR #97, merged)** — `openclaw` dev-dep + `minHostVersion`
  → `2026.5.18`; 727 tests + typecheck green on the new SDK; AUDIT-E
  re-run (0 seam mismatches). Found + fixed 2 bugs: CI `| tee` was
  masking test failures; smoke harness lacked `registerCommand`.
- **Wave 1 (PR #98, merged)** — 9-agent parity re-audit. Catalog:
  `docs/audits/parity-refresh/wave-1-catalog.md` — **2 P0, 17 P1,
  ~30 P2; 0 correctness/security regressions.** Per-slice detail in
  `slice-audit-{A..E}.md`, build-specs `buildspec-S16/S17/S18*.md`,
  benchmark `benchmark-codex-claude-code.md`.
- **Wave 3 — in progress** — 6 findings fixed so far:
  - W1-C1 (#99) — stale-event guard was dead code; threaded `expectedApprovalId`.
  - W1-S9-2 (#99) — `checkApprovalId` contradicted the state machine; `rejected` is non-terminal.
  - W1-D2 (#99) — plan-step injection appended `status`; in-host appends `activeForm`. Byte-matched.
  - W1-A1 (#108) — exit_plan_mode description claimed a runtime subagent gate the plugin lacks. False sentence dropped.
  - W1-A3 (#108) — ask_user_question description re-ported verbatim from in-host.
  - W1-A5 (#108) — auto-enable matcher: false "wired" header claim corrected; wiring tracked in #107 (needs real design — not faked).

### Remaining Wave-3 findings — triaged by effort

The honest split. "Quick" = mechanical port/wire, well-specified.
"Investigation" = real design questions; doing these at speed
reproduces the "port not done correctly" disease — they get proper
time, not a rushed pass.

| Finding | Effort | Note |
|---|---|---|
| W1-S9-1 sidebar schema | quick | add 5 omitted fields to the descriptor schema |
| W1-B4 accept-edits trigger test | quick | add the missing CI-runnable test |
| W1-E2 debug-log taxonomy | moderate | re-port the 8-kind event union + emit sites |
| W1-D1 reject-injection form | moderate | match the in-host runtime reject path |
| W1-S18-1 Telegram menu | moderate | `channels` filter so `/plan` survives the 100-cmd cap |
| W1-F4 `/plan auto` dead toggle | moderate | wire the auto-approve runtime, or hide the toggle |
| W1-F2 plan-persistence honesty | moderate | write the `plan-*.md` file, or de-claim it in the prompt |
| W1-F1 action-required notification | **deferred — SDK blocker** | see `blocker-W1-F1.md`; every push-to-channel SDK seam is bundled-only |
| W1-E6 retry tool-call signal | **investigation** | needs the `messages[]` shape reverse-engineered |
| W1-E1 turn-limit watchdog | **investigation** | needs `registerSessionSchedulerJob` wiring + once-only semantics |

---

## Wave 3 — remaining findings (17)

Fix sequentially, one focused PR per cluster. IDs reference
`wave-1-catalog.md`.

| Cluster | Findings | Files |
|---|---|---|
| tools | W1-A1 (subagent-gate description lies), W1-A3 (`ask_user_question` desc paraphrased), W1-A5 (auto-enable matcher dead code) | `src/tools/*`, `src/plan-mode/tool-descriptions.ts`, `auto-enable.ts`, `index.ts` |
| prompt | W1-D1 (reject-injection emitter ≠ in-host form); ~~W1-D2~~ ✅ done; W1-D3 (no byte-fixture test — **overlaps Wave 2 harness; let Wave 2 own it**) | `src/prompt/*`, `injection-writer.ts`, `session-actions.ts` |
| runtime | W1-E1 (turn-limit watchdog deferral stale — seam now exists), W1-E2 (debug-log taxonomy diverged), W1-E6 (`madeToolCall` derived from wrong signal) | `src/runtime/*`, `index.ts` |
| ui | W1-S9-1 (sidebar schema omits 5 fields), W1-S18-1 (Telegram 100-cmd menu hides `/plan`), W1-B4 (accept-edits trigger has no CI test) | `src/ui/*`, `index.ts` |
| benchmark gaps | W1-F1 (no action-required notification — P0), W1-F2 (prompt promises a `plan-*.md` no code writes — P0), W1-F4 (`/plan auto` dead toggle) | `src/ui/session-actions.ts`, `src/prompt/*`, `index.ts` |

**Wave 4 (cross-platform — Telegram + Slack)** status as of 2026-05-20:
- W1-F3 (multi-surface approval push) — **deferred — SDK blocker (same
  as W1-F1)**. See `blocker-W1-F3.md`. Every push-to-channel SDK seam
  is `bundled-plugin-only` on `2026.5.18`. Resolution path (`/plan
  accept|reject|cancel|edit|answer`) ALREADY works on every channel
  via the universal text pipeline; the gap is the PROACTIVE PUSH (the
  "your plan is ready" message), which needs the same upstream SDK
  change as F1 (R1/R2/R3). Files updated upstream issue: one PR
  covers both findings.
- W1-F5 (`/plan answer` cross-surface) — **IMPLEMENTED**. Added
  `PendingQuestion` field to `PlanModeSessionState`; added
  `PlanModeStore.persistPendingQuestion` + `clearPendingQuestion`
  mutators; wired `ask_user_question` tool body to persist on
  success; wired `/plan answer <text>` in `slash-commands.ts` to
  read persisted state + dispatch `plan.answer`. Idempotency: store
  clears slot on dispatch success; injection-writer dedups on
  `questionId`. Membership guard (`allowFreetext === false` →
  answer must be in `options`) mirrors in-host
  `sessions-patch.ts:721-732`. New tests: store +9, slash-commands
  +8 (replacing 1 known-gap test), ask-user-question +6. 868 total
  tests green.

**~30 P2s**: triage during/after Wave 3 — fix-now vs defer-with-issue.

---

## Execution discipline (the guardrails)

1. **Worktree isolation for git agents.** Any background/parallel
   `Agent` that runs `git` MUST use `isolation: "worktree"`. Branches
   share ONE working tree — a naive parallel agent's `git checkout`
   clobbers the other's uncommitted edits (this happened once during
   Wave 2's first attempt; recovered, no loss).
2. **Wave 3 is sequential.** `index.ts` + `session-actions.ts` are
   shared across clusters → parallel fix agents merge-conflict, and
   each fix needs careful in-host matching + tests. One cluster, one
   PR, CI-gated, then the next.
3. **Wave 2 — do it directly, not via a background agent.** It is
   logically isolated (`parity-harness/` + `ci.yml`), BUT the Agent
   `isolation: "worktree"` option fails in this environment ("not in
   a git repository" — the tool resolves from a non-repo cwd). Without
   real worktree isolation, a background agent that runs `git` WILL
   collide. So Wave 2 is done sequentially, by hand, like Wave 3.
4. **CI is trustworthy as of PR #97** — the `| tee` exit-code masking
   is fixed. A red `ci` check is now a real signal.
5. Every fix cites the in-host `host_ref:` and ships a test.

---

## Branch / PR state

- `main` — Wave 0 + Wave 1 merged.
- `wave-3/fixes` — Wave 3 batch 1 (PR #99, open). Active fix branch.
- Wave 2 — first attempt's partial harness work backed up at
  `/tmp/wave2-partial-*`; re-dispatch fresh + isolated.
- Source-of-truth for parity diffs: in-host branch
  `rebase/pr70071-onto-main-2026-04-25` @ `ea04ea52c7` in
  `/Volumes/LEXAR/repos/openclaw-pr70071-rebase`.

---

## Resume instructions

1. Read `wave-1-catalog.md` (the finding specs) + this doc.
2. If Wave 2 not yet merged: dispatch ONE worktree-isolated agent to
   build the Layer-1 parity harness (see catalog + `parity-harness/`).
3. Wave 3: pick the next un-fixed cluster from the table above, fix
   it sequentially against the in-host source-of-truth, add tests,
   open a CI-gated PR, merge, update this doc's "Done" section.
4. After Wave 3 + Wave 2 land: Waves 4 → 5 → 6.
