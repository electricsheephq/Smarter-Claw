# PR Ladder v2 — Integrated (post Wave 4+5)

**Supersedes**: `07-PR_LADDER.md` (which was based on Option C as originally written, before Wave 3-5 amendments).

**Integrates**:
- Amendment 1 (10-invariant typed mutator with discriminated-union return)
- Amendment 2 = Path A (6 upstream UI sub-PRs U1-U6 from `12-PATH_A_DEEP_DIVE.md`)
- Parity-harness PRs (from `14-PARITY_HARNESS_DESIGN.md`)

**Status**: ready for Eva's review. **Will not move to PR-1 until Eva confirms Path A.**

---

## Two parallel ladders

The work splits into two tracks running mostly in parallel:

**Track A — Smarter-Claw plugin** (the new plugin repo, this work)
- ~5,200 LOC of new plugin code + ~1,600 LOC parity-harness + ~6,800 LOC ported test cases
- 14 PRs (P-1 through P-14)
- Repo: `electricsheephq/Smarter-Claw`, branch off `architecture-v2-planning` (locked once Eva approves)

**Track B — OpenClaw upstream UI** (host-side UI ships in upstream/main)
- ~2,560 LOC across 6 sub-PRs
- Repo: `openclaw/openclaw`, separate branch per sub-PR
- Coordination: file tracking issue first; submit U1 to gauge reception

---

## Track B — OpenClaw upstream sub-PRs (Path A)

| Sub-PR | Title | LOC | Files | Depends | Eva-runnable |
|---|---|---|---|---|---|
| U1 | Session-shape additive type + sidebar hydration | 320 | 4 | none | Sidebar widget renders (empty state) |
| U2 | Mode-switcher chip + dropdown | 580 | 7 | U1 | Toggle mode via UI; chip appears |
| U3 | Plan-approval inline card + revise textarea + **input-bar suppression** | 600 | 8 | U2 | Plan card renders; input bar hides during pending |
| U4 | Plan-cards stream + plan-resume + AskUserQuestion variant | 380 | 6 | U2 | Cards animate in stream; AskUserQuestion "Other..." works |
| U5 | `/plan` slash commands + plan-view toggle button | 280 | 4 | U2 | Slash commands accept; toggle works |
| U6 | i18n locale sync | 400 | 12 | U2-U5 | Locale strings present |

**Submission order**: U1 (immediate). Wait for U1 merge or strong signal. Submit U2. Wait for U2. Then U3 sequentially. Then U4 + U5 in parallel. Then U6.

**Pre-coordination**: file an upstream issue against `openclaw/openclaw` BEFORE U1 to get directional sign-off. Sample issue title: "RFC: plan-mode UI lands in upstream/main to support Smarter-Claw plugin (6 sub-PRs, ~2.5K LOC)." Tag @jalehman (per memory's LCM coordination precedent).

**If maintainers push back on direction** (~15% risk per Agent P):
- Fallback: pivot to Path C (new SDK seam for chat-stream rendering). Adds 6-12 weeks.
- Worst case: pivot to Path B with input-bar suppression worked around via an explicit "are you sure?" confirmation modal when user submits during pending-approval (degrades UX but resolves the correctness regression).

---

## Track A — Smarter-Claw plugin PRs

| PR | Title | LOC | Test gate | Eva-smoke | Maps to features |
|---|---|---|---|---|---|
| **P-1** | Plugin skeleton + manifest | ~250 | plugin loads without crash; passes manifest validator | install + restart, no errors in log | — (foundation) |
| **P-2** | Public types + helpers (`PlanMode`, `newPlanApprovalId`, `sanitizeFeedbackForInjection`) | ~180 + 240 tests | unit tests for each helper; ported from in-host | — | F-types |
| **P-3** | PlanModeStore foundation + `persistApprovalRequest` (10-invariant typed mutator) | ~420 + 320 tests | NEW direct unit tests for all 4 result kinds + 4 idempotency-guard conditions + lock semantics | — | F3 |
| **P-3.5** | **Parity-harness Layer 1 scaffolding** | ~600 | host-reference vs plugin diff'd for `persistApprovalRequest` against shared inputs.json | — | (mechanical parity gate) |
| **P-4** | `enter_plan_mode` + `exit_plan_mode` tools | ~280 + 180 tests | tool registration; state transitions through PlanModeStore | — | F1 |
| **P-5** | Mutation gate (`before_tool_call` hook) + **Eva live-smoke #1** | ~520 + 64 tests + 800 LOC harness Layer 2 | 64 mutation-gate cases (ported); Layer 2 scenarios for enter/mute/exit | **Eva runs**: install plugin, agent enters plan mode, attempts Edit — blocked. Exits — unblocked. | F2, F10 |
| **P-6** | Plan-approval persistence via session-extension (race-fix wiring) | ~340 + 95 tests | concurrent calls test (lock semantics); idempotency match/no-match cases; audit-skip on reuse | — | F3 (continued), F11 |
| **P-7** | planMode runtime context propagation | ~210 + 60 tests | `before_prompt_build` injects planMode flag; subagent propagation | — | F4 |
| **P-8** | Plan archetype + `ask_user_question` tool + auto mode + **Eva live-smoke #2** | ~480 + 110 tests + scenarios | full plan→approve→execute→complete via `/plan accept` | **Eva runs**: agent emits plan; user `/approve`; agent resumes, emits `[PLAN_COMPLETE]`. | F5 |
| **P-9** | Plan title + turn-limit overrides | ~150 + 30 tests | model-override resolution; turn-limit watchdog | — | F6 |
| **P-10** | Auto-continue + escalating retry | ~520 + 59 tests | 59 escalating-retry cases (ported verbatim); `before_agent_finalize` revise/retry contract | — | F7 |
| **P-11** | Rejection UX + cycle tracking | ~290 + 45 tests | cycle counter increment; max-cycles cap; deescalation injection at ≥3 | — | F8 |
| **P-12** | Mode-switcher UI + plan cards via `registerControlUiDescriptor` (sidebar projector + session actions for /approve, /reject) | ~370 + 80 tests | sidebar widget renders state; session-actions fire correctly | — | F9 (partial; full UX via Track B) |
| **P-13** | Exec allowlist + dangerous-flag blocking + shell-escape defense + **Eva live-smoke #3** | ~480 + 88 tests + scenarios | 88 accept-edits-gate adversarial cases (ported); shell-escape layered tests | **Eva runs**: rejection cycle (3 rejects → "Multiple revisions" suggestion); adversarial exec input blocked. | F10, F12 |
| **P-14** | Approval grant ledger + approvalRunId/approvalId correlation + **Parity-harness Layer 3** (continuous drift) + v1.0.0 release | ~310 + 60 tests + 200 LOC cron | grant-ledger tests; debug-log correlation; CI drift-detection job | **Eva runs**: 30 adversarial prompts + UI verification; release-gate. | F11 (continued), release |

**Track A totals**: 14 main PRs, ~5,200 LOC plugin code + ~1,600 LOC parity-harness + ~1,431 LOC ported tests. Average **~370 LOC/PR**. Max P-3.5 (parity-harness foundation, ~600 LOC) and P-5 (mutation gate + Layer 2 scaffolding, ~520 + 800 LOC).

---

## Timing — combined Track A + B

**Critical path**: Track A is independent of Track B for backend correctness. Track B blocks "full UX parity" but not "plugin ships." Track A can ship a v0.x plugin with sidebar-only UI (via P-12) while Track B sub-PRs land in parallel; the full inline-chat-stream UX comes online as each Track-B sub-PR merges into a host release.

**Best case**: Track A completes in ~4-5 weeks (parallelizable PRs + minimal review iteration). Track B completes in 1-2 weeks (per Agent P's estimate). Plugin v1.0 = both done. Total: **~5 weeks elapsed**.

**Realistic case**: Track A ~6-8 weeks. Track B 2-3 weeks. Plugin v1.0 = ~8 weeks elapsed.

**Worst case**: Track B rejected, pivot to Path C. Track A continues with sidebar-only UI for v1.0; plugin ships at ~6 weeks with degraded UX; Path C upstream PR follows over additional 6-12 weeks for v1.5.

---

## Revertability

| PR range | Revert window |
|---|---|
| P-1, P-2, P-3 (foundation) | Full revert returns repo to bare scaffolding. Safe at any time. |
| P-3.5 + P-4..P-7 (state model + tools) | Single-PR revert per change. Plugin's PlanModeStore namespace would be invalidated; live sessions in pending-approval enter undefined state. **Document**: rollback after P-5 requires draining sessions first. |
| P-8..P-14 (features) | Single-PR revert per change. Each is additive (adds a feature; no destructive schema change). |
| Track B sub-PRs | Single-PR revert per change. U1's additive `SessionEntry.planMode` type is forward-compatible if U2..U6 revert. |

**Hard revert anchor**: tag `architecture-v2-locked` at the architecture-v2-planning branch tip BEFORE any P-1 work. If mid-way we discover a structural issue, branch back to the tag.

---

## Critical-path PR ladder

```
                      ┌────────┐
                      │  P-1   │ (skeleton)
                      └───┬────┘
                          │
                      ┌───▼────┐
                      │  P-2   │ (types)
                      └───┬────┘
                          │
                      ┌───▼────┐
                      │  P-3   │ (PlanModeStore)
                      └───┬────┘
                          │
                      ┌───▼────┐
                      │ P-3.5  │ (parity-harness L1)
                      └───┬────┘
                          │
                      ┌───▼────┐
                      │  P-4   │ (enter/exit tools)
                      └───┬────┘
                          │
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
    ┌────────┐                       (Eva live-smoke #1
    │  P-5   │                        ⬅ HERE: integration
    └───┬────┘                        is verified)
        │
        ▼
    ┌────────┐
    │  P-6   │ (approval persist; full race-fix)
    └───┬────┘
        │
        ▼
    ┌────────┐
    │  P-7   │ (runtime context)
    └───┬────┘
        │
        ▼
    ┌────────┐
    │  P-8   │ (Eva live-smoke #2: full plan flow)
    └───┬────┘
        │
   ┌────┴────┐
   ▼         ▼
 ┌─────┐  ┌─────┐
 │ P-9 │  │P-10 │  (parallel; both depend on P-8)
 └─┬───┘  └─┬───┘
   │        │
   ▼        ▼
 ┌─────┐  ┌─────┐
 │P-11 │  │P-12 │  (cycle tracking; UI registration)
 └─┬───┘  └─┬───┘
   │        │
   └───┬────┘
       ▼
   ┌────────┐
   │  P-13  │ (exec hardening; Eva live-smoke #3)
   └───┬────┘
       │
       ▼
   ┌────────┐
   │  P-14  │ (release; Eva live-smoke #4)
   └────────┘
```

**Critical path**: P-1 → P-2 → P-3 → P-3.5 → P-4 → P-5 → P-6 → P-7 → P-8 → P-13 → P-14. Roughly 11 sequential PRs. P-9/P-10 and P-11/P-12 are parallelizable.

---

## Net change vs original 07-PR_LADDER.md

- **+1 PR**: P-3.5 added for parity-harness Layer 1 (was missing).
- **+1 scope item** at P-5: Layer 2 scenarios for parity-harness.
- **+1 scope item** at P-14: Layer 3 continuous-drift cron.
- **+6 PRs in Track B** (was 0 — original treated UI as a black box).
- **Total Track A PR count**: 14 → 14 (P-3.5 absorbed by renumbering decimal; could promote to P-4 with renumber if Eva prefers integer-only).
- **Total LOC** of work: ~5,200 plugin code (Track A) + ~2,560 UI code (Track B) + ~1,600 harness + ~1,431 ported tests = **~10,800 LOC**.
- **Timeline**: original "~6-8 weeks" elapsed. Revised: **same range** (~5-8 weeks realistic), because Track B parallelizes Track A.

---

## When this is locked

- Eva confirms Path A.
- I refresh `07-PR_LADDER.md` to be this file (or rename `07b-PR_LADDER_v2.md` → `07-PR_LADDER.md`).
- Re-run a final adversarial pass against the locked architecture (target ≥95% verdict from a fresh agent).
- Tag the architecture-v2-planning branch tip as `architecture-v2-locked-vN`.
- Build the final approval plan + enter Claude plan-mode + submit P-1.
