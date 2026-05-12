# Current State — for Eva on return

**Generated**: autonomous loop iteration after Eva invoked `<<autonomous-loop-dynamic>>`.

**Confidence**: **~90%** (was 72% when you left; was 80% after Wave 3).

**Status**: 0 BLOCKERs, 2 HIGHs with concrete mitigation, 3 MEDIUMs documented. Path to 95% is ~1-2 days of test-harness scaffolding work, NOT a redesign.

---

## What's locked

1. **Source-of-truth**: `rebase/pr70071-onto-main-2026-04-25` tip `ea04ea52c7`, restored at `/Users/lume/repos/openclaw-pr70071-rebase`.
2. **Architecture**: Option C (Hybrid). Single namespace `"plan-mode"` owned by `PlanModeStore`. Decomposed feature surfaces.
3. **Amendment 1**: Typed-mutator API with discriminated-union return type encoding **10 invariants** (not the originally-believed 4). Critical change from Wave 2: includes lock semantics, fresh-read flag, 4-conjoined idempotency decomposition, IO-error fail-soft contract, audit-skip on reuse, and caller-side `{reused: boolean}` consumption.
4. **Amendment 2 Path B is OFF THE TABLE** — input-bar suppression is a correctness regression no SDK seam can replicate.
5. **Amendment 2 Path A** recommended at ~85%. 6 sub-PRs, ~2,560 LOC total, realistic 8 working days to land. Decoupling sub-option **A.3** (UI in-host, plugin mirrors existing `SessionEntry.planMode` shape — zero new SDK seam needed).

---

## What needs your call

**Decision 1 (required): confirm Path A as the UI strategy.** Path C remains a long-term option (cleaner abstraction, new SDK seam) but adds 6-12 weeks. Path A reuses existing in-host UI code, ships in ~8 working days.

**Decision 2 (suggested): Path A coordination plan.**
- File an upstream issue against `openclaw/openclaw` first to get sign-off on the direction BEFORE submitting code (~15% maintainer-reject risk mitigated)?
- Who at openclaw is the right reviewer for plan-mode UI? (Memory mentioned `jalehman` for the LCM/runtime work.)
- Or: just submit U1 and gauge reception?

**Decision 3 (suggested): Plugin distribution stance during Path A cycle.**
- For 8 working days (best case) to 4-5 weeks (worst), the plugin requires host version pin `>= X.Y.Z` where the upstream UI lives. Acceptable?
- ClawHub release gated on UI sub-PRs being merged?

---

## Wave 1-4 summary

| Wave | Agents | Output | Verdict |
|---|---|---|---|
| 1 | D (parity catalog), E (arch options), F (build baseline), I (lessons learned) | 4 docs + 2,500 LOC of artifact | Option C selected at 26/30 |
| 2 | adversarial-C, diagrams, PR-ladder | 3 docs | 2 BLOCKERs surfaced |
| 3 | N (verify A1), O (UI gap) | 2 docs + revisions | A1 expanded to 10 invariants; Path B dropped |
| 4 | P (Path A deep-dive), Q (pre-lock adversarial) | 2 docs | 0 BLOCKERs, 2 HIGHs, 3 MEDIUMs |
| 5 (this) | Parity-harness design | 1 design doc | Closes the 2 HIGHs |

All artifacts in `/Users/lume/repos/Smarter-Claw/architecture-v2/` and pushed to https://github.com/electricsheephq/Smarter-Claw/tree/architecture-v2-planning/architecture-v2

---

## The remaining gap to 95%

**2 HIGH severity** (both are TEST-HARNESS work, NOT redesign):
- **HIGH 1**: Plugin unit tests certify spec, not parity with in-host reference.
- **HIGH 2**: 875-test corpus could ship "passing" while silently diverging.

**Mitigation** (designed in `14-PARITY_HARNESS_DESIGN.md`):
- 3-layer parity-test harness: unit-level + integration-level + continuous-drift.
- Shared `inputs.json` table per target function. Both in-host reference AND plugin run the same inputs; outputs diffed. Any unexplained divergence fails CI.
- Effort: ~1,600 LOC distributed across 5 PRs in the ladder.

**3 MEDIUM severity** (documented as known limitations):
- Subagent plan-mode behavior in parity catalog has a doc gap (covered by reading subagent dispatch code; documented as a known item to address during PR-9).
- Rollback stop-conditions for the PR ladder (when does "revert" stop being safe? Answer: after PR-3 — foundation block. Document at PR-3 ship time.).
- Operator-install UX (`allowConversationAccess: true` config friction) — limited by absent `registerStartupCheck` SDK capability. Mitigation: startup-banner from plugin if conversation-access not granted; loud documentation.

**5 NONE** (architecture survives these attack vectors):
- Namespace ownership conflicts: host enforces per-pluginId isolation. Confirmed at `host-hooks.contract.test.ts:996-1006`.
- Plugin restart mid-approval: extension bag preserved across restart. Confirmed at `host-hooks.contract.test.ts:2537-2622`.
- Compaction interaction: compaction doesn't touch `pluginExtensions`. Verified.
- Cron durability: `schedulePluginSessionTurn` is the durable seam (better fit than the diagrams suggested).
- Host-version-pin: `minHostVersion` in `openclaw.plugin.json` is install-time enforced.

---

## Path A sub-PR plan (concrete)

From `12-PATH_A_DEEP_DIVE.md`:

| Sub-PR | Title | LOC | Difficulty | Files |
|---|---|---|---|---|
| U1 | Session shape + sidebar hydration | 320 | easy | 4 files (types.ts + sidebar + hydrator + tests) |
| U2 | Mode-switcher chip + dropdown | 580 | medium | 7 files (component + tests + i18n + integration) |
| U3 | Plan-approval inline card + revise textarea + input-bar suppression | 600 | medium-hard | 8 files (the security-sensitive piece) |
| U4 | Plan-cards + plan-resume + AskUserQuestion variant | 380 | easy-medium | 6 files |
| U5 | `/plan` slash commands + plan-view toggle | 280 | easy | 4 files |
| U6 | i18n locale sync | 400 | easy | 12 locale files |

**Submission sequence**: U1 → U2 → U3 sequential (dependency chain), then U4 + U5 parallel, then U6 final.

**Time**: best case 1 week (everything sails), realistic **8 working days**, worst case 4-5 weeks if U3's input-bar suppression review takes time.

**Risk**: 15% likelihood maintainers reject direction → file upstream issue first to de-risk.

---

## Path to 95% confidence

1. **Today/tomorrow (you choose)**: Eva confirms Path A + suggested coordination plan.
2. **Day 1**: Build parity-harness Layer 1 scaffolding (~600 LOC, ships as PR-3.5). Bumps confidence to ~93%.
3. **Day 2**: Build Layer 2 scenarios. Bumps to ~95%.
4. **(Already done by Wave 4)**: All MEDIUM mitigations documented; can proceed.
5. **At 95%**: lock the architecture-v2 branch tip with a tag, build the final approval plan, enter Claude plan-mode, submit.

---

## Files in this directory

```
architecture-v2/
├── 01-PARITY_CATALOG.md          # The contract (1,919 lines)
├── 02-ARCHITECTURE_OPTIONS.md    # 3 options, Option C selected
├── 03-BUILD_BASELINE.md          # 220/220 plan-mode tests pass; branch verified
├── 04-LESSONS_LEARNED.md         # Prior Smarter-Claw failures; 10 guardrails
├── 05-ADVERSARIAL_AGAINST_C.md   # Wave 2 attacks (2 BLOCKERs surfaced)
├── 06-DIAGRAMS.md                # 6 ASCII diagrams of Option C
├── 07-PR_LADDER.md               # Initial 14-PR ladder (needs revision after locks)
├── 08-DECISION_DRAFT.md          # SUPERSEDED in part by 11-
├── 09-AMENDMENT_1_VERIFICATION.md  # Wave 3: race-fix has 10 invariants, not 4
├── 10-UI_GAP_ANALYSIS.md         # Wave 3: 25 UI elements; Path B blocked
├── 11-AMENDMENT_REVISIONS.md     # Wave 3 consolidation (authoritative)
├── 12-PATH_A_DEEP_DIVE.md        # Wave 4: 6 sub-PRs, 8-day timeline
├── 13-PRE_LOCK_ADVERSARIAL.md    # Wave 4: 0 BLOCKERs, 2 HIGHs
├── 14-PARITY_HARNESS_DESIGN.md   # Wave 5 (autonomous): closes both HIGHs
└── 15-CURRENT_STATE_FOR_EVA.md   # THIS FILE
```

---

## One-line summary for Eva

**Architecture is at 90% confidence with 0 BLOCKERs. Path A confirmed in detail. Parity-test harness designed. 1-2 days of harness scaffolding gets us to 95% — but I'm not writing code until you confirm Path A.**

---

## When you return

- Skim `11-AMENDMENT_REVISIONS.md` first (the authoritative current state).
- Then read this file (`15-CURRENT_STATE_FOR_EVA.md`) for the asks.
- Then any of 12/13/14 for depth.
- Confirm Path A (or push back).
- I'll then revise `07-PR_LADDER.md` to incorporate Wave 4-5 findings + the parity-harness PRs, push the locked architecture-v2 tag, build the final approval plan, and enter Claude plan-mode for the first concrete PR.
