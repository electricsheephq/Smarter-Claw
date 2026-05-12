# AUDIT-C: GitHub State of `electricsheephq/Smarter-Claw` vs Plan Tracking Requirements

**Date:** 2026-05-12
**Auditor scope:** read-only — did not file anything
**Repo:** `electricsheephq/Smarter-Claw`
**Main tip:** `d17d4975f2` (2026-04-25) — `chore(installer): pin to openclaw v2026.4.23 stable (#76)`
**v1-port tip:** `e91493d82d` (2026-05-12) — `ci: add typebox as direct devDep + fix imports from @sinclair/typebox`
**Tagged release tip:** `v1.0.0-port.14` → commit `e91493d82d` (same as v1-port tip, since CI fixes landed on v1-port and were tagged)

---

## 1. Summary

| Required artifact | Exists? | Notes |
|---|---|---|
| Epic issue tracking v1-port effort (P-1 → P-final) | **NO** | No `epic` label exists in repo; no umbrella issue filed. |
| Per-PR issues (or milestone issues for P-5/P-8/P-11/P-13/P-14/P-final) | **NO** | Zero issues reference P-N work or the v1-port port. The 56 existing issues are all from the legacy ~Apr 23–24 attempt. |
| PRs from v1-port (or per-PR feature branches) → main | **NO** | Zero PRs target v1-port → main. Zero PRs sourced from v1-port. The 14 P-N commits sit on v1-port only, invisible to anyone watching main. |
| Architecture-v2 docs pushed to remote | **YES** | All 17 files `01-…` through `17-FINAL_ADVERSARIAL.md` are present on `architecture-v2-planning`. |
| Eva live-smoke gates tracked as CI | **YES** | Commit `adddadd3f8` "Eva live-smokes #1-#4 as CI-driven integration tests" is on v1-port; CI green on tip (`e91493d`). |
| Release `v1.0.0-port.14` visible | **YES** | Pre-release, published 2026-05-12T11:06:25Z, tag points to `e91493d82d`. No release assets (no tarball attached — installs as `file:` source). |
| Branch protection on main | **YES** | Requires PR review (1 approval, code-owner), required status checks `ci` + `installer-roundtrip`, linear history, conversation resolution, no force-push, no deletion. Admins NOT enforced. |

**Bottom line:** the v1-port port is **invisible on GitHub except as a branch and a tag**. The plan's tracking-discipline requirements (epic + per-PR issues + PRs to main) are entirely unmet. Anyone watching main since 2026-04-25 sees zero progress; anyone reading issues sees only the legacy attempt's bug list.

---

## 2. Branches

From `gh api repos/electricsheephq/Smarter-Claw/branches` and `git ls-remote --heads`:

| Branch | SHA | Protected | Purpose |
|---|---|---|---|
| `main` | `d17d4975f2` | **YES** | Stable tip of legacy plugin (pinned to openclaw v2026.4.23). 20 commits behind v1-port. |
| `v1-port` | `e91493d82d` | NO | The 14-step ladder + Eva live-smokes + 2 CI fixes (20 commits ahead of main). |
| `architecture-v2-planning` | `71d55db571` | NO | Holds the 17 architecture-v2 docs. |
| `takeover/parity-architecture-plan` | `9c410777ae` | NO | Source branch of the still-open PR #50 ("[takeover] Add parity plan and first contract gates"). |
| `docs/sprint-2-plan` | `966bc916a8` | NO | Source of still-open PR #70. |
| `docs/upstream-rfc-merge-policy` | `f2295ff6af` | NO | Source of still-open PR #71. |

**Branch protection on main** (from `gh api .../branches/main/protection`):

- `required_pull_request_reviews`: 1 approval, code-owner required, dismiss-stale-reviews enabled.
- `required_status_checks`: `ci`, `installer-roundtrip` (contexts must pass).
- `required_linear_history`: true.
- `required_conversation_resolution`: true.
- `allow_force_pushes`: false.
- `allow_deletions`: false.
- `enforce_admins`: **false** (admins can bypass — worth knowing).

The protection setup is solid for normal contributor workflow, but **v1-port → main cannot be merged without filing a PR**, and no such PR exists.

---

## 3. Issues

56 issues exist in the repo, all created during the legacy attempt (2026-04-23 through 2026-04-24). **Zero issues created after 2026-04-25, when v1-port work began.**

### 3a. v1-port-related issues

**NONE.** No issue mentions:
- "v1-port" (search `gh issue list --search "v1-port in:title,body"` returns `[]`)
- "P-final", "P-N", or the ladder (only stray "[P0]"/"[P1]" tags from legacy bug-list — not the same scheme)
- The "epic" label (label doesn't exist in repo)
- The "area/plan-mode" label (label doesn't exist in repo — the existing area label is `area/runtime`)

### 3b. Legacy-attempt issues (all from 2026-04-23 → 2026-04-24)

Highlights from the 56 legacy issues:

| # | State | Title (excerpt) | Notes |
|---|---|---|---|
| 75 | OPEN | [UX-blocker] Mutation-gate blocks silently | priority/blocker, release-gate, area/runtime — **stale: this is a legacy-attempt observation; v1-port's P-5 mutation gate is the canonical implementation now** |
| 73 | OPEN | [SECURITY] Subagent gate bypass via sessions.patch | priority/blocker, release-gate, host-patch — **also legacy-attempt; v1-port re-implements the gate** |
| 51 | CLOSED | [BLOCKER] Surgical port — recover 32 missed plan-mode commits | This was the previous "fix the port" tracking issue; closed because superseded by the v1-port ladder strategy |
| 50 | OPEN PR | (PR, not issue) [takeover] Add parity plan and first contract gates | still open; predates v1-port |
| 48 | OPEN | [observability] Timing/debug parity for live plan-mode diagnosis | Conceptually now covered by v1-port's P-14 debug log, but issue still open |
| 47, 45, 44, 43 | OPEN | various runtime/release-gate items | All from legacy-attempt assessment; v1-port re-does these |
| 27, 26, 25, 24, 23, 21, 20, 19, 18, 17, 16, 15 | OPEN | P2 bugs/architecture | All in legacy installer/runtime code, not in v1-port surface |

**Observation:** 13 of the 56 issues are still OPEN. Several of them describe defects in code that v1-port replaces wholesale; they should probably be re-triaged (close-as-superseded, link to corresponding P-N commit, or migrate to v1-port-relative issues). This is out of scope for AUDIT-C but worth flagging to the orchestrator.

---

## 4. Pull Requests

### 4a. PRs targeting `main` from `v1-port` (or per-P-N branches)

**ZERO.** No PR has `v1-port` as `headRefName`. No PR title contains "P-1" through "P-14" or "v1-port".

```
$ gh pr list --search "head:v1-port OR base:v1-port"
[]
$ for L in P-1 ... P-14; do gh pr list --search "$L in:title"; done
all return []
```

### 4b. All PRs in the repo (37 in total)

| # | State | Head → Base | Title (short) |
|---|---|---|---|
| 76 | MERGED | chore/pin-host-v2026.4.23 → main | chore(installer): pin to openclaw v2026.4.23 stable |
| 74 | MERGED | fix/sprint2-tactical-bundle → main | fix(host-patch): tactical bundle |
| 71 | OPEN | docs/upstream-rfc-merge-policy → main | docs: upstream RFC draft — mergeSessionEntryWithPolicy |
| 70 | OPEN | docs/sprint-2-plan → main | docs: Sprint 2 design — structural plan-state migration |
| 69, 68, 67, 66, 65, 64, 63, 62, 61, 60, 59–52 | MERGED | various → main | Legacy-attempt Sprint 1/Sprint 2 fixes + plan-mode P2.3 through P2.12b (these are the legacy attempt's P2.x scheme, NOT the v1-port ladder) |
| 50 | OPEN | takeover/parity-architecture-plan → main | [takeover] Add parity plan and first contract gates |
| 42, 41, 40, 39 | MERGED | various → main | Initial CI setup, license relicense, atomic manifest write, tarball-shape gate |

All 37 PRs predate the v1-port ladder start; the latest PR (#76) merged 2026-04-25, the day v1-port was created. No PR from the new ladder.

### 4c. Still-open PRs that may need decisions

- **#50** "[takeover] Add parity plan and first contract gates" — from `takeover/parity-architecture-plan`. This is the historical proposal for the takeover; status unclear. Probably superseded by architecture-v2-planning + v1-port.
- **#70** "docs: Sprint 2 design — structural plan-state migration (Alternative I)" — from the legacy attempt; superseded by v1-port (which is Alternative C / Path A, not Alternative I).
- **#71** "docs: upstream RFC draft — mergeSessionEntryWithPolicy" — concrete upstream-OpenClaw RFC content; may or may not still be relevant under the v1-port plan (v1-port uses `updateSessionStoreEntry`, not a merge-policy proposal).

These three open PRs are likely **stale and should be closed-as-superseded**, but again, that's outside AUDIT-C's read-only scope. Flagging.

---

## 5. Releases + Tags

### Releases
Only one release exists:

```
v1.0.0-port.14 — backend-first ladder complete (v0.x internal-release baseline)
  Pre-release: true
  Published: 2026-05-12T11:06:25Z
  Tag: v1.0.0-port.14 → e91493d82d
  Assets: NONE (release body says "ships as a direct-install plugin")
```

Release notes are thorough — they enumerate every P-N feature, the deferred upstream-gated items, the operator-config required, the test footprint (551 tests across 26 files), and reference the in-host parity source at `openclaw-pr70071-rebase@ea04ea52c7`. Good content; nobody on GitHub will see it absent a PR or epic linking to it.

### Tags
```
dev-snapshot-2026-04-24  → 5527d7e2f0
v0.1.0                   → 70f7c63875
v1.0.0-port.14           → e91493d82d
```

`v0.1.0` is the legacy attempt's tag. `dev-snapshot-2026-04-24` is the surgical-port checkpoint. `v1.0.0-port.14` is the current state.

---

## 6. Architecture-v2 Branch Contents

Branch `architecture-v2-planning` at `71d55db571` has the 17 documents at `architecture-v2/`:

```
01-PARITY_CATALOG.md
02-ARCHITECTURE_OPTIONS.md
03-BUILD_BASELINE.md
04-LESSONS_LEARNED.md
05-ADVERSARIAL_AGAINST_C.md
06-DIAGRAMS.md
07-PR_LADDER.md
07b-PR_LADDER_v2.md
08-DECISION_DRAFT.md
09-AMENDMENT_1_VERIFICATION.md
10-UI_GAP_ANALYSIS.md
11-AMENDMENT_REVISIONS.md
12-PATH_A_DEEP_DIVE.md
13-PRE_LOCK_ADVERSARIAL.md
14-PARITY_HARNESS_DESIGN.md
15-CURRENT_STATE_FOR_EVA.md
16-MEDIUM_MITIGATIONS.md
17-FINAL_ADVERSARIAL.md
```

All 17 files mentioned in `/Users/lume/.claude/plans/glistening-swimming-rivest.md` are present. ✅

**Caveat:** these docs live on `architecture-v2-planning`, not on `main`. Anyone landing on the repo's default-branch README sees no reference to them unless they explicitly check out that branch or follow the deep-link in the release notes.

---

## 7. What's MISSING — the gap list

In priority order:

1. **No epic / umbrella issue** tracking the v1-port port. Reviewers, watchers, and any future contributor sees no narrative of where the project is or what's left.

2. **No PR from v1-port → main.** The protected-main policy means v1-port commits cannot land on main without one. Currently there's no path to "merge v1-port to main" short of force-push (which is blocked).

3. **No per-P-N issues or per-P-N PRs.** The plan called for at minimum issues for the milestone P-5 / P-8 / P-11 / P-13 / P-14 / P-final. None exist. The 14 P-N commits live only as commit messages on a feature branch — no discoverable index, no reviewable diff, no checklist to file follow-ups against.

4. **Legacy issues are stale.** 13 OPEN issues (e.g. #75, #73, #48, #47, #45, #44, #43) describe legacy-attempt behavior that v1-port supersedes. They should be re-triaged: close-as-superseded with link to the corresponding P-N commit, or migrate to v1-port-relative issues. Currently anyone reading issues thinks the plugin is broken.

5. **Three stale OPEN PRs** (#50, #70, #71) from the legacy attempt should be closed-as-superseded with comment pointing to v1-port / architecture-v2-planning.

6. **No `epic` and no `area/plan-mode` labels** exist in the repo. They need to be created before they can be applied. Note that `area/runtime` already exists and may be a near-synonym — pick one and use it consistently.

7. **Architecture-v2 docs not linked from main's README.** The README at main tip doesn't reference `architecture-v2-planning` or the 17 docs. The release-notes body links them via raw GitHub URL, but only the release page surfaces those links.

8. **No P-final tracking artifact.** The release notes say P-final is "alongside the inline UI work" but that work is upstream-gated (waiting on `registerChatStreamRenderer`). There's no GitHub issue tracking the upstream-OpenClaw dependency.

---

## 8. Recommended GitHub Artifacts to Create

The orchestrator can use these copy-paste-ready specs. Each is read-only; nothing was filed.

### 8a. Epic issue — top-level tracker

**Artifact type:** Issue
**Repo:** `electricsheephq/Smarter-Claw`
**Title:** `[EPIC] v1-port — backend-first ladder (P-1 → P-final) to first-public-release v1.0.0`
**Labels (create first if missing):** `epic`, `area/runtime`, `priority/blocker`, `release-gate`, `status/soaking`

**Body:**

```markdown
## Status

`v1.0.0-port.14` shipped 2026-05-12 as a **pre-release internal baseline** (tag
`v1.0.0-port.14`, commit `e91493d82d`). Backend-first ladder (P-1 through P-14)
**complete**. P-final is **upstream-blocked** on OpenClaw SDK seams
(`registerChatStreamRenderer`, session-enumeration).

All work lives on branch [`v1-port`](https://github.com/electricsheephq/Smarter-Claw/tree/v1-port);
20 commits ahead of `main`. Architecture docs (17 files) on
[`architecture-v2-planning`](https://github.com/electricsheephq/Smarter-Claw/tree/architecture-v2-planning/architecture-v2).

## Ladder

| Step | Commit | Status | What it lands |
|---|---|---|---|
| P-1 | [`8b61460`](https://github.com/electricsheephq/Smarter-Claw/commit/8b61460fc2) + [`9a37b01`](https://github.com/electricsheephq/Smarter-Claw/commit/9a37b01b25) | done | Plugin skeleton + manifest + pin to openclaw 2026.5.10-beta.5 |
| P-2 | [`2833a54`](https://github.com/electricsheephq/Smarter-Claw/commit/2833a54e95) | done | Public types + helpers (PlanMode union, approval-id, sanitize, payload-hash) |
| P-3 | [`aa2ba6e`](https://github.com/electricsheephq/Smarter-Claw/commit/aa2ba6e587) | done | PlanModeStore + persistApprovalRequest (10-invariant mutator) |
| P-3.5 | [`7521c8d`](https://github.com/electricsheephq/Smarter-Claw/commit/7521c8defe) | done | parity-harness Layer 1 (mechanical drift detection) |
| P-4 | [`7ffd7c3`](https://github.com/electricsheephq/Smarter-Claw/commit/7ffd7c3e49) | done | enter_plan_mode + exit_plan_mode tools |
| P-5 | [`f32b351`](https://github.com/electricsheephq/Smarter-Claw/commit/f32b351943) | done | Mutation gate (before_tool_call) + 116 adversarial cases |
| P-6 | [`97872a5`](https://github.com/electricsheephq/Smarter-Claw/commit/97872a5a82) | done | SessionStoreGateway (real persistence) |
| P-7 | [`5eede7f`](https://github.com/electricsheephq/Smarter-Claw/commit/5eede7f1e5) | done | planMode runtime context + archetype injection |
| P-8 | [`5d08bed`](https://github.com/electricsheephq/Smarter-Claw/commit/5d08bed2e1) | done | Reference card + pending-injections + ask_user_question |
| P-9 | [`037842d`](https://github.com/electricsheephq/Smarter-Claw/commit/037842da24) | done | Plan-tier model override |
| P-10 | [`2e3b776`](https://github.com/electricsheephq/Smarter-Claw/commit/2e3b776408) | done | Escalating retry (before_agent_finalize) + 3 detectors |
| P-11 | [`0326715`](https://github.com/electricsheephq/Smarter-Claw/commit/0326715228) | done | Rejection UX + cycle tracking |
| P-12 | [`b231e04`](https://github.com/electricsheephq/Smarter-Claw/commit/b231e04c8c) | done | Sidebar UI descriptor + session-actions + sweep CLI |
| P-13 | [`42c665c`](https://github.com/electricsheephq/Smarter-Claw/commit/42c665ccac) | done | Accept-edits gate + autoApprove mutator |
| P-14 | [`56ce477`](https://github.com/electricsheephq/Smarter-Claw/commit/56ce477aa8) | done | Grant ledger + debug log + Layer-3 drift cron |
| Live-smokes | [`adddadd`](https://github.com/electricsheephq/Smarter-Claw/commit/adddadd3f8) | done | Eva live-smokes #1-#4 as CI-driven integration tests |
| CI fix | [`e91493d`](https://github.com/electricsheephq/Smarter-Claw/commit/e91493d82d) | done | typebox import + LEXAR store-dir removal |
| **P-final** | — | **blocked** | Inline chat-stream UI + input-bar suppression + mass plan-clear — gated on upstream OpenClaw SDK seams |

## Deferred to v1.0.0 (upstream-gated)

- Inline chat-stream UI (mode-switcher chip, inline plan cards) — requires upstream `registerChatStreamRenderer`
- Input-bar suppression on pending approval — same seam
- Mass `plan-clear --all-sessions` sweep — requires upstream session-enumeration seam
- Hard-enforced startup operator-config validation — requires upstream `registerStartupCheck` seam (medium priority — current session-start advisory works)

See `architecture-v2/15-CURRENT_STATE_FOR_EVA.md` "Upstream SDK gaps" section.

## Test footprint at the v0.x baseline

`pnpm test`: **551 tests pass across 26 test files**. CI status on tip: ✅ green.

## Parity source

All implementations cite their in-host counterpart at
`openclaw-pr70071-rebase@ea04ea52c7` (PR #70071 + 8 fix commits including
the empty-plan-body race-fix at `1081067476`).

## Open follow-ups

- [ ] File per-PR PR from v1-port → main (or split into 14 per-P-N PRs)
- [ ] Triage legacy-attempt issues (close-as-superseded the ones v1-port replaces)
- [ ] Close stale legacy-attempt PRs #50, #70, #71 as superseded
- [ ] File upstream-OpenClaw dependency tracker for the 4 deferred SDK seams
- [ ] Decide v1.0.0 release strategy (single big PR vs 14 sequential PRs)
```

---

### 8b. Decision issue — single PR or ladder of PRs?

**Artifact type:** Issue
**Title:** `[decision] How to land v1-port → main: one tracking PR or 14 sequential PRs?`
**Labels:** `area/runtime`, `priority/blocker`, `release-gate`, `architecture`

**Body:**

```markdown
The v1-port branch is 20 commits ahead of main with a clean P-1 → P-14 ladder.
Main is protected (1 review + 2 status checks). We need a strategy to land it.

## Option A — one tracking PR (`v1-port` → `main`)

**Pro:** preserves the historical commit-by-commit narrative; minimal overhead;
matches how the release notes are structured.

**Con:** one giant ~20-commit PR is hard to review; CI status will reflect the
final tip only; per-step diffs are not separately approvable.

## Option B — 14 sequential PRs (P-1 → P-final)

**Pro:** matches the plan's "PR ladder" intent; each step is reviewable in
isolation; matches the in-host PR #70071 review pattern.

**Con:** the work is already done — replaying it as 14 PRs is mostly process
ceremony; main will churn through 14 merges in quick succession.

## Option C — bundle PRs by phase

E.g. 4 PRs: P-1..P-5 (foundation+gate), P-6..P-9 (runtime+model), P-10..P-12
(rejection+UI), P-13..P-14 (gate+release-prep) + a final integration PR.

**Pro:** middle ground; phase-level review is feasible; preserves some structure.

**Con:** still requires retroactive history split; cleanest if we cherry-pick
or interactive-rebase v1-port into phase branches.

## Recommendation

Defer to maintainer (Arn). My read: **Option A** is simplest given that
- v1-port is already a clean linear sequence (no merge commits)
- the release notes are the per-step changelog
- review-by-step can happen by walking the commit list inside the single PR
- the protected-main constraint is satisfied by one PR

But Option B aligns better with the original plan's discipline if we have time.
```

---

### 8c. Upstream-OpenClaw dependency tracker

**Artifact type:** Issue
**Title:** `[blocked] Upstream OpenClaw SDK seams required for v1.0.0 — chat-stream renderer + session enumeration + startup check`
**Labels:** `priority/blocker`, `release-gate`, `risk/host-patch`, `status/blocked`

**Body:**

```markdown
P-final and full v1.0.0 release are gated on 4 SDK seams that don't yet exist
in upstream OpenClaw. This issue tracks the dependency so we can re-test
v1-port + open the v1.0.0 release path once they land.

## Required seams

| Seam | Used for | Status upstream |
|---|---|---|
| `registerChatStreamRenderer` | Inline chat-stream UI: mode-switcher chip, inline plan cards | not filed |
| (chat-stream renderer extension) | Input-bar suppression on pending approval | same as above |
| Session-enumeration API | Mass `plan-clear --all-sessions` sweep | not filed |
| `registerStartupCheck` | Hard-enforced operator-config validation at host start | not filed |

## Workaround in v1.0.0-port.14

- Sidebar UI (registerControlUiDescriptor) is the only UX surface. Operators
  expecting in-chat plan cards must wait for v1.0.
- plan-clear is single-session. Operators must invoke per-session.
- Operator config validation runs at session-start (advisory). Plan-mode
  still works if mis-configured but warns on first turn.

## Next action

File an upstream RFC at `openclaw-pr70071-rebase` (or main openclaw repo)
covering all 4 seams. Coordinate with Anthropic upstream owners.
```

---

### 8d. Triage issue — legacy-attempt issue/PR cleanup

**Artifact type:** Issue
**Title:** `[cleanup] Re-triage 13 OPEN legacy-attempt issues + close 3 stale PRs as superseded by v1-port`
**Labels:** `area/runtime`, `priority/normal`

**Body:**

```markdown
13 issues created during the 2026-04-23/24 legacy-attempt phase are still OPEN
but describe defects that v1-port supersedes wholesale.

## Open issues to triage

| # | Title | Recommended action |
|---|---|---|
| 75 | [UX-blocker] Mutation-gate blocks silently | Close as superseded by P-5 ([`f32b351`](https://github.com/electricsheephq/Smarter-Claw/commit/f32b351943)) — or re-validate in v1-port if the silent-block UX is still an issue |
| 73 | [SECURITY] Subagent gate bypass via sessions.patch | Close as superseded by P-5 mutation gate + adversarial cases |
| 48 | [observability] Timing/debug parity | Close as superseded by P-14 debug log ([`56ce477`](https://github.com/electricsheephq/Smarter-Claw/commit/56ce477aa8)) |
| 47 | [runtime] Deliver pending injections at turn boundary | Close as superseded by P-8 pending-injections + P-11 writers |
| 45 | [runtime] Fix approval ID and pending approval vocabulary | Close as superseded by P-2 helpers ([`2833a54`](https://github.com/electricsheephq/Smarter-Claw/commit/2833a54e95)) |
| 44 | [runtime] Contract-lock PR #70071 compatibility adapter | Re-validate: v1-port targets `openclaw@2026.5.10-beta.5`, not PR #70071 directly. Probably close. |
| 43 | [release-gate] v0.2.0-beta.1 readiness + Eva canary tracker | Close as superseded by the v1.0.0-port.14 release |
| 27, 26, 25, 24, 23 | various installer/patch P2 bugs | Re-validate against v1-port installer (largely replaced) |
| 21, 20, 19, 18, 17, 16, 15 | various legacy plan-mode internals | Close as superseded — code rewritten in v1-port |

## Open PRs to close

| # | Title | Recommended action |
|---|---|---|
| 50 | [takeover] Add parity plan and first contract gates | Close as superseded; link to architecture-v2-planning + v1-port |
| 70 | docs: Sprint 2 design — structural plan-state migration (Alternative I) | Close as superseded; v1-port uses Path A / Alternative C, not Alternative I |
| 71 | docs: upstream RFC draft — mergeSessionEntryWithPolicy | Re-evaluate: v1-port uses `updateSessionStoreEntry`, not a merge-policy proposal. Probably close. |

This issue acts as the meta-tracker. Each sub-item should be a close-comment
on the relevant issue/PR linking back to the canonical v1-port commit.
```

---

### 8e. PR — v1-port → main (single tracking PR)

**Artifact type:** Pull Request
**Head:** `v1-port` → **Base:** `main`
**Title:** `feat(plan-mode): v1-port — backend-first ladder P-1 → P-14 + Eva live-smokes`
**Labels:** `area/runtime`, `priority/blocker`, `release-gate`, `status/ready`

**Body:**

```markdown
20 commits since main. Implements the full v1-port plan-mode ladder
(P-1 → P-14) plus Eva live-smokes integration tests. Tagged as
[`v1.0.0-port.14`](https://github.com/electricsheephq/Smarter-Claw/releases/tag/v1.0.0-port.14)
(pre-release).

## What's in this PR

See [#EPIC] for the full ladder. Brief:

- P-1 → P-4: plugin skeleton, types, store, enter/exit tools
- P-5: mutation gate (116 adversarial cases) **— security-critical**
- P-6 → P-8: real persistence, runtime context, reference card, pending-injections
- P-9 → P-11: model override, escalating retry, rejection UX
- P-12 → P-14: sidebar UI, accept-edits gate, autoApprove, grant ledger, debug log, drift cron

Plus:
- Eva live-smokes #1-#4 as CI integration tests ([`adddadd`](https://github.com/electricsheephq/Smarter-Claw/commit/adddadd3f8))
- 2 CI fixes (typebox imports, LEXAR store-dir removal)

## Review strategy

This PR is intentionally not squashed. **Review commit-by-commit** to match
the ladder structure. Each P-N commit is independently understandable and
cites its in-host parity source at `openclaw-pr70071-rebase@ea04ea52c7`.

## Test footprint

`pnpm test`: 551 tests pass across 26 test files. CI green on tip.

## What's NOT in this PR (upstream-gated, deferred to v1.0.0)

See #[blocked-upstream-seams] for the dependency tracker.

- Inline chat-stream UI
- Input-bar suppression
- Mass plan-clear --all-sessions
- Hard startup operator-config validation

## Parity source

`/Users/lume/repos/openclaw-pr70071-rebase` commit `ea04ea52c7` (PR #70071
+ 8 fix commits including race-fix at `1081067476`).
```

---

### 8f. Labels to create (one-time setup)

```bash
gh label create "epic"        --description "Multi-PR umbrella tracker"        --color "0E8A16" --repo electricsheephq/Smarter-Claw
gh label create "area/plan-mode" --description "Plan-mode behavior and state" --color "1D76DB" --repo electricsheephq/Smarter-Claw
```

(Note: `area/runtime` already exists with color `1D76DB` and almost-identical
description. Pick one — recommend keeping `area/runtime` and **not** creating
`area/plan-mode`, to avoid label sprawl. The epic above uses `area/runtime`.)

---

## End-state if all 8 artifacts are filed

- 1 epic issue (8a) — discoverable top-level narrative on the Issues tab
- 1 decision issue (8b) — orchestrator/maintainer picks merge strategy
- 1 upstream-blocked tracker issue (8c) — surfaces what's gating v1.0.0
- 1 cleanup tracker issue (8d) — drives the 13-issue / 3-PR triage
- 1 PR (8e) — actually lands v1-port on main (Option A from 8b)
- 1 new label (`epic`) — applied to 8a

After that: the v1-port port is **fully tracked on GitHub**, and the
"nothing has been filed" gap is closed.
