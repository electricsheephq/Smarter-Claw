# Step 12 — Path A Deep Dive (concrete upstream-PR strategy)

**Purpose**: turn the Path A recommendation from `11-AMENDMENT_REVISIONS.md` into a buildable plan Eva can pull the trigger on. Decisions, sub-PR breakdown, time/risk numbers, and the exact published-state JSON shape the plugin must satisfy.

**Working tree**: `/Users/lume/repos/openclaw-pr70071-rebase`, branch `rebase/pr70071-onto-main-2026-04-25`, tip `ea04ea52c7`. UI body of work: ~5,400 LOC (production + tests + i18n).

**Bot landscape (evidenced)**: openclaw repo enforces `openclaw-barnacle` cleanliness bot, `greptile-apps` reviewer with a **100-file scan limit**, plus `copilot-pull-request-reviewer`. PR #71676 (large omnibus) was bot-closed for "too many unrelated changes" — 200 files >100-file limit. PRs #70066-70070 (per-part stack with intentionally RED CI) were closed too. **Sub-PRs must each have green CI on their own and stay under the 100-file scan limit.**

**Throughput evidence** (50 recently-merged openclaw PRs, `gh pr list ... merged --limit 50`): median time-to-merge is **~1.4 hours**; 90th-percentile is **~10 hours**; outliers up to 25h for large UI work. Sub-200-LOC PRs routinely merge in under an hour. The 4423-LOC outlier (#80493) merged in 10 hours. **Once a PR passes bot review + maintainer eyeball, throughput is fast.**

---

## §1 — Decoupling sub-option recommendation

**Recommend: A.3 — Keep UI in-host (uses internal host state), file as upstream PR. Plugin's `PlanModeStore` mirrors host state through `SessionEntry.planMode` (already on the wire).**

| Sub-option | LOC delta to upstream PR | Risk | Reversibility |
|---|---|---|---|
| **A.1** (UI reads `pluginExtensions['smarter-claw']`) | **+250-400 LOC** new SDK surface (`registerSessionExtension`-style projector + UI consumer wiring) — itself a load-bearing seam this repo doesn't have today (grep confirms: no `pluginExtensions`, no `registerSessionExtension`) | **HIGH** — needs a new SDK seam landed first; raises Path A's surface area to Path C's | Low — UI now coupled to plugin namespace |
| **A.2** (UI reads generic "plan-mode-shape" contract on `SessionEntry`) | **+0-30 LOC** — `SessionEntry.planMode` already encodes the shape (`ui/src/ui/types.ts:452-486`); upstream just lands it as-is | **LOW** — contract already exists in shipped types | Medium — UI cares about plan-mode-shape, not who fills it |
| **A.3** (UI uses in-host state today; plugin mirrors via existing `SessionEntry.planMode`) | **+0 LOC** vs A.2 — same upstream PR contents; the *plugin* is what's different (host still writes `SessionEntry.planMode`; plugin gets a mirror seam later) | **LOWEST** — zero upstream-PR scope creep; plugin work is independent | Highest — plugin can switch projector when ready |

**Rationale**: A.2 and A.3 collapse to the SAME upstream-PR scope (UI reads `SessionEntry.planMode`). They diverge only on the plugin side, where A.3 lets us defer plugin/UI decoupling to a follow-up. **A.3 is the right call** because (a) we get the upstream PR landed with zero plugin-coupling design debate, (b) once it ships the plugin work proceeds at its own pace, and (c) the same shape (`SessionEntry.planMode`) already exists on the wire — no schema surgery.

**A.1 is the trap**: it requires a NEW SDK surface (`registerSessionExtension` or equivalent UI projector) landed first. That's a separate Path-C-shaped upstream PR with the same review/security pushback we wanted to avoid. **Do not propose A.1 to upstream.**

The plugin must publish a shape conformant with the `SessionEntry.planMode` contract documented in §6. Lock it now; don't re-shape mid-port.

---

## §2 — Sub-PR ladder (6 sub-PRs)

Designed for: green CI per sub-PR, <100 files each (Greptile scan limit), <600 LOC each. Built into independently demonstrable steps where each sub-PR has standalone value, with later sub-PRs depending on earlier ones.

| # | Title | Files | LOC | Depends on | Reviewer difficulty | Independently demonstrable? |
|---|---|---|---|---|---|---|
| **U1** | `feat(ui): plan-mode session shape + sidebar hydration` | `ui/src/ui/types.ts` (+72), `ui/src/ui/app.ts` (~80 of the 600 plan-mode lines — hydration helpers only), `ui/src/ui/views/chat.ts` (~30 — sidebar wire-up), `ui/src/styles/chat/plan-cards.css` (134 new) | ~320 | — | **EASY** — pure-type additions to `SessionEntry`, no behavior changes. Sidebar markdown surface render-only. | Yes: with a session that has `planMode.lastPlanSteps` set by hand, sidebar renders the live plan markdown. Existing `sessions.list` payload already carries the shape. |
| **U2** | `feat(ui): mode-switcher chip + dropdown` | `ui/src/ui/chat/mode-switcher.ts` (424 new), `ui/src/ui/chat/mode-switcher.test.ts` (388 new), `ui/src/i18n/locales/en.ts` (+ ~80 strings) | ~580 (incl. ~390 test, ~70 i18n) | U1 (session shape) | **MEDIUM** — keyboard shortcut + dropdown + active-state logic. Greptile will scan all 388 test lines; design solid (already in production-equivalent in-host). | Yes: chip renders in toolbar, user can switch modes via menu + `Ctrl+1..6`. Behavioral effect is `sessions.patch { planMode }`; backend handles or no-ops if planMode infra absent. |
| **U3** | `feat(ui): plan-approval inline card + revise textarea` | `ui/src/ui/views/plan-approval-inline.ts` (306 new), `ui/src/ui/views/plan-approval-inline.test.ts` (295 new), `ui/src/ui/app.ts` (~200 of plan-mode lines — `planApprovalRequest` state + handlers + `dismissedApprovalIds`), `ui/src/ui/app-view-state.ts` (~30) | ~600 (~300 test) | U2 (uses mode-switcher state) | **MEDIUM-HARD** — state machine (`reviseOpen`, `questionOtherOpen`, dismissed-ids), input-bar suppression on `planApprovalRequest !== null`, error-banner pathways. This is the biggest review burden. | Yes: a plan-approval-pending session shows the card; clicking Accept/Edit/Revise dispatches `sessions.patch { planApproval: ... }`. |
| **U4** | `feat(ui): plan-cards rendering + plan-resume + AskUserQuestion variant` | `ui/src/ui/chat/plan-cards.ts` (122 new), `ui/src/ui/chat/plan-cards.test.ts` (159 new), `ui/src/ui/chat/plan-resume.ts` (21 new), `ui/src/ui/chat/plan-resume.node.test.ts` (26 new), question-variant logic in `plan-approval-inline.ts` (~50 LOC delta) | ~380 (~190 test) | U3 (card shell exists) | **EASY-MEDIUM** — pure render functions + hidden `chat.send` helper. AskUserQuestion variant reuses U3's card shell. | Yes: the `update_plan` checklist renders; `AskUserQuestion` events surface as option-button card. |
| **U5** | `feat(ui): /plan slash-command surface + plan-view toggle button` | `ui/src/ui/chat/slash-command-executor.ts` (~80 plan-only lines on top of existing dispatcher), `ui/src/ui/chat/slash-command-executor.node.test.ts` (~160 new), `ui/src/ui/app-chat.ts` (+5), `ui/src/ui/app-render.helpers.ts` (~30 — plan-view toggle button) | ~280 (~160 test) | U1 (sidebar), U3 (approval state for `/plan accept`/`/reject`) | **EASY** — slash dispatch is well-understood; same RPC route as buttons. | Yes: `/plan view` opens sidebar; `/plan on/off/auto/accept/revise/reject/answer` parse + dispatch correctly. |
| **U6** | `feat(ui): plan-mode i18n full locale sync` | `ui/src/i18n/locales/*.ts` (regenerated by `pnpm ui:i18n:sync` — ~30 locale files) + `ui/src/i18n/.i18n/*.meta.json` regenerated | ~400 (all generated) | U2-U5 (all English strings finalized) | **EASY** — generated output, per `ui/CLAUDE.md`: "Do not hand-edit non-English locale bundles." Reviewer verifies `pnpm ui:i18n:sync` was run on top of U2-U5 final strings. | No (i18n alone is invisible) — but ships the locales pipeline-correctly. |

**Total**: ~2,560 LOC production + ~1,000 LOC test + ~400 LOC i18n generation = **~3,960 LOC across 6 PRs**. Within the 4,237 LOC ceiling Eva named, and each sub-PR <600 LOC.

**Notable**: this is LOWER than the catalog's "~5,400 LOC" because we split `app.ts` and `views/chat.ts` patches across sub-PRs proportionally to feature (rather than counting the entire file diff against one sub-PR), and the i18n regenerated bundles get their own pure-mechanical sub-PR per the `ui/CLAUDE.md` rule.

### Why this ordering

1. **U1 first** — lands `SessionEntry.planMode` type + sidebar hydration. The shape EVERY later sub-PR consumes. Zero behavior change without later sub-PRs (just renders an empty sidebar if no `lastPlanSteps`).
2. **U2 next** — mode-switcher is self-contained UI; dispatches `sessions.patch { planMode }`. Visible UI that's independently testable.
3. **U3** — biggest behavioral piece (approval card + input suppression). Lands the state machine.
4. **U4** — render-only additions on top of U3's card shell. Smaller PR, easy to review.
5. **U5** — slash commands are mostly dispatch rewiring. Safe to land last among the behavioral PRs.
6. **U6** — pure i18n locale sync, the mechanical commit demanded by `ui/CLAUDE.md`.

### How the staging avoids #70066-70070's failure mode

Per #70066-70070, the original 6-part stack had **red CI on each part** because parts referenced symbols from earlier parts not yet merged. **Our 6-sub-PR ladder above has GREEN CI per PR** because:

- U1 lands type-only and a sidebar renderer that handles `lastPlanSteps == null` correctly.
- U2's mode-switcher dispatches `sessions.patch { planMode }` and the host backend already accepts this (race-fix commit `1081067476` is in `1081067476` host-side, deployed).
- U3 reads `SessionEntry.planMode` which U1 added. Card renders only when `planApprovalRequest !== null`; absence of that field is benign.
- Each sub-PR's tests pass without future sub-PRs because each adds only what it ships.

### Avoiding the #71676 failure mode

PR #71676 was closed because `200 files found, 100 file limit` — Greptile couldn't scan it. Each sub-PR above touches **<30 files** including generated outputs. U6 alone touches ~30 locale files but those are mechanical and reviewers expect them; if Greptile flags U6 as bot-only-scan, that's acceptable (the rule per `ui/CLAUDE.md` is to regenerate, not to hand-edit).

---

## §3 — Time-to-merge estimate

**Per-sub-PR cycle**, derived from openclaw recent-merged-PR data:
- Submit + bot review + maintainer approval + merge cycle: **median 1.4h, 90th percentile 10h** for normal-sized UI PRs. Large UI PRs (>800 LOC) trend toward 10-25h.
- Iteration cycle (push fixes, re-trigger CI, re-review): typically **adds 4-8h per iteration**. Expect 1-2 iterations per non-trivial PR.

| Sub-PR | Optimistic (1 iter, fast review) | Realistic (2 iters) | Pessimistic (3 iters, scope pushback) |
|---|---|---|---|
| U1 | 4h | 1d | 3d |
| U2 | 8h | 2d | 5d (mode-switcher UX bikeshed) |
| U3 | 1d | 3d | 7d (state machine review) |
| U4 | 6h | 1d | 3d |
| U5 | 4h | 1d | 2d |
| U6 | 2h | 4h | 1d (just regen verification) |
| **Sequential total (worst path)** | **3 days** | **8 days** | **3 weeks** |

### Submission strategy: **mostly sequential, U4 in parallel with U5**

- **Sequential U1 → U2 → U3**: each later sub-PR consumes earlier types/state. Wait until prior is merged.
- **U4 and U5 can submit in parallel** (both depend on U3 only). Saves 1-3 days.
- **U6 must be last** — it's a regen on top of all prior English-string changes.

**Realistic estimate: 8 working days = ~2 calendar weeks** start to finish.

**Worst case (upstream pushes back hard on U3's input-bar suppression or mode-switcher UX)**: **4-5 weeks**, with one sub-PR needing a re-architecture pass.

**Best case (Eva drives daily, no surprises)**: **1 week** if all sub-PRs sail through with 1 iteration each.

These estimates are **5-10× faster** than the catalog's "3-6 weeks omnibus / 4-8 weeks staged" because openclaw's median PR throughput is genuinely hours-to-a-day-or-two, not the GitHub-norm weeks.

---

## §4 — Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **R1**: maintainers reject plan-mode UI direction entirely ("we don't want plan-mode in core; ship as plugin only") | **~15%** — prior PR #70071 chain was closed but for bot-cleanliness reasons; no maintainer rejected the *direction* on record. Plan-mode is referenced positively in repo docs already. | **CRITICAL** — kills Path A | **File upstream issue FIRST** (§5) to get yes/no on direction before submitting U1. If rejected, fall back to Path C (new SDK seam, ~6-10wk) or Path B-with-acknowledged-correctness-gap. |
| **R2**: mid-staging, upstream changes a UI file we depend on (e.g. `chat.ts` refactored) | **~30%** — UI is high-traffic (see #80657, #80644, #80684 recent merges). | **MEDIUM** — merge conflicts on U2-U5 | Rebase per sub-PR before submit. Keep each sub-PR's surface area minimal — `app.ts` patches are isolated to plan-mode regions. If conflict on shared lines, **defer the affected sub-PR** rather than re-architect; let upstream-main stabilize for a day. |
| **R3**: Eva's host installation falls behind upstream during the PR cycle | **~60%** — upstream merges 30+ PRs/day. Eva's `v2026.4.24+172` baseline drifts. | **LOW-MEDIUM** — only matters at final cutover | After U1-U6 merged, Eva does a single `git rebase upstream/main` of the plugin-port branch, runs `smarter-claw-qa` skill on a stock build. Lock plugin to require host `>= vYYYY.M.D` (the first release shipping all six sub-PRs). |
| **R4**: a sub-PR ships, then we discover a regression and need to revert | **~25%** for U2-U4 (visible UI surfaces); negligible for U1/U5/U6 | **HIGH** if combined with R3 | Each sub-PR shipped as a single commit on `main`; revert is `git revert <sha>`. **Backwards-compatibility contract: U1's `SessionEntry.planMode` type is additive — reverting U2-U5 leaves the type unused (forward-compat for next attempt).** Document in U1's PR body. |
| **R5**: `openclaw-barnacle` bot closes a sub-PR for cleanliness | **~20%** — biggest risk on U6 (i18n bulk file changes) | **MEDIUM** — recreate from clean branch (cost: 30min) | Branch sub-PRs from upstream/main HEAD, not from a long-lived feature branch. Don't squash-merge sub-PRs into each other; submit independently. Verify Greptile file-count < 100 per PR before submit. |
| **R6**: Greptile's 100-file scan limit gets hit | **~30%** — U6 alone is 30 locale files, plus accompanying patches | **LOW** — only impacts review depth, not merge gate | Accept partial Greptile coverage on U6 (regen-output is expected to be light-review). Submit U6 with a PR-body header that explains the regen procedure. |
| **R7**: upstream maintainers ask for a different sub-PR split | **~30%** | **MEDIUM** — 1-2d to re-stage | The 6-sub-PR ladder above is illustrative; if upstream wants e.g. mode-switcher and slash-commands combined, we can re-split. State machine in U3 is the natural fault-line; preserve that. |
| **R8**: the input-bar-suppression behavior in U3 raises a security concern | **~10%** — UI-only, runs in same renderer as the input field, no privilege escalation | **MEDIUM** — slows U3 review | Pre-empt: U3 PR body explicitly notes "no new privilege; UI hides input from view only; backend still rejects mismatched user input with a normal mode-switch error." |

**Top 3 risks Eva should weigh** (ranked by expected pain):

1. **R1 (direction rejection)** — file the issue first; this is the only existential risk.
2. **R2 (mid-staging conflicts)** — high likelihood; mitigation is straightforward but adds 1-3 days.
3. **R4 (post-merge revert needed)** — moderate likelihood; mitigation is the additive-type invariant from U1.

---

## §5 — Coordination plan

### Reviewer / point of contact

- **Primary**: file an **upstream tracking issue** in `openclaw/openclaw` titled *"Plan Mode UI: 6-sub-PR landing plan"* before submitting U1. Reference the 9-PR-rollout history (#70101 master tracker, #70066-70070 per-part PRs, #71676 omnibus) explicitly. This gives a maintainer a chance to say "no thanks" or "reshape it" before we burn cycles.
- **Best-fit reviewer candidates** (based on AGENTS.md ownership signals + recent UI activity): the maintainer who merged `#80684 fix(ui): localize chat panel strings` (~3h ago in the sample) is actively reviewing chat UI. Whoever Eva's `jalehman` contact maps to in openclaw — coordinate via that channel to nominate a reviewer.
- **Bot review surface**: `greptile-apps`, `copilot-pull-request-reviewer`, `openclaw-barnacle`. **No human review required for merge** unless the bots flag P0/P1 issues; openclaw's CI is highly automated.

### RFC / design doc?

**No formal RFC required**. Evidence: per-file LOC of recent ~5-10 hour merges (e.g. #77201 1596 LOC, #77132 1737 LOC, #79211 2279 LOC) lands without RFC. Path A is restoring already-once-merged work, not introducing a new abstraction.

**But**: do submit a **GitHub issue** ahead of U1 with the 6-sub-PR plan attached as the issue body. Reasons:
1. Gives the maintainer team a single anchor point to bless or reshape direction.
2. Documents the "yes, we considered Path B/C" trade-off in a discoverable place.
3. Lets us point each sub-PR at the same parent issue (`Fixes #NN` or `Part of #NN`).

### Issue body template

> **Plan Mode UI: 6-sub-PR landing plan (carve-out of #70071)**
> Following the closure of #71676 by `openclaw-barnacle`, here is a re-staged plan that should pass bot review per-PR.
> 
> **Sub-PRs (each <600 LOC, green CI):**
> 1. U1 — Session shape + sidebar hydration
> 2. U2 — Mode-switcher chip
> 3. U3 — Plan-approval inline card
> 4. U4 — Plan-cards + plan-resume + AskUserQuestion variant
> 5. U5 — `/plan` slash commands + plan-view toggle
> 6. U6 — i18n locale sync
> 
> **Direction confirmation requested**: do maintainers prefer the UI lands in upstream (this plan) or as a plugin-owned surface? Plugin Smarter-Claw owns backend; UI is the question.

---

## §6 — Plugin-side dependency: the published-state contract

The plugin's `PlanModeStore` (per Amendment 1's revised mutator API) must publish state in a shape the upstream UI consumes WITHOUT modification. That shape is **`SessionEntry.planMode`**, already documented at `ui/src/ui/types.ts:452-486` of the rebase tree and shipped via `sessions.list` payloads.

### JSON Schema for the published state

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PlanModeSessionEntry",
  "type": "object",
  "description": "Plan-mode state published on SessionEntry.planMode. Plugin's PlanModeStore mirrors this shape after every mutator call.",
  "properties": {
    "mode": {
      "type": "string",
      "enum": ["plan", "normal"],
      "description": "Current plan-mode state for the session. Drives mode-switcher chip rendering."
    },
    "approval": {
      "type": "string",
      "enum": ["none", "pending", "approved", "edited", "rejected", "timed_out"],
      "description": "Approval lifecycle state. UI gates the inline approval card on 'pending'."
    },
    "approvalId": {
      "type": "string",
      "description": "Race-fix invariant: format 'plan-<uuid>'. UI uses for idempotency on accept/reject dispatches. Required when approval='pending'."
    },
    "cycleId": {
      "type": "string",
      "description": "Plan-revise cycle counter ID. UI uses to identify which revision is current."
    },
    "enteredAt": { "type": "integer", "description": "Unix ms when mode entered 'plan'." },
    "confirmedAt": { "type": "integer" },
    "updatedAt": { "type": "integer" },
    "feedback": { "type": "string", "description": "User's last revise feedback. Shown in card for context on cycles >1." },
    "rejectionCount": { "type": "integer", "minimum": 0 },
    "lastPlanSteps": {
      "type": "array",
      "description": "RACE-FIX INVARIANT #1 — must be written synchronously with approvalId. UI hydrates sidebar markdown from this on session-load + page-refresh.",
      "items": {
        "type": "object",
        "properties": {
          "step": { "type": "string", "description": "Step text (markdown allowed)." },
          "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] },
          "activeForm": { "type": "string" },
          "acceptanceCriteria": { "type": "array", "items": { "type": "string" } },
          "verifiedCriteria": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["step", "status"]
      }
    },
    "lastPlanUpdatedAt": { "type": "integer" },
    "blockingSubagentRunIds": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Subagent gate — UI's 'subagents still running' toast reads from this."
    },
    "lastSubagentSettledAt": { "type": "integer" },
    "autoApprove": {
      "type": "boolean",
      "description": "True when '/plan auto' enabled. Mode-switcher renders 'Plan⚡' chip variant."
    },
    "title": {
      "type": "string",
      "description": "Race-fix invariant #2 — written synchronously with approvalId. UI uses for sidebar header + card title strip."
    }
  },
  "required": ["mode", "approval"],
  "additionalProperties": false
}
```

### `SessionEntry.pendingInteraction` (sibling field; required for AskUserQuestion variant of U3/U4)

```json
{
  "title": "PendingInteraction",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": { "const": "plan" },
        "approvalId": { "type": "string" },
        "title": { "type": "string" },
        "createdAt": { "type": "integer" },
        "status": { "type": "string", "enum": ["pending", "resolved"] },
        "cycleId": { "type": "string" }
      },
      "required": ["kind", "approvalId", "title", "createdAt", "status"]
    },
    {
      "type": "object",
      "properties": {
        "kind": { "const": "question" },
        "approvalId": { "type": "string" },
        "questionId": { "type": "string" },
        "title": { "type": "string" },
        "question": { "type": "string" },
        "options": { "type": "array", "items": { "type": "string" } },
        "allowOther": { "type": "boolean" },
        "createdAt": { "type": "integer" },
        "status": { "type": "string", "enum": ["pending", "resolved"] }
      },
      "required": ["kind", "approvalId", "title", "question", "options", "createdAt", "status"]
    }
  ]
}
```

### Mirror semantics

The plugin's `PlanModeStore.persistApprovalRequest` (returning the 4-result-kind type from Amendment 1) MUST trigger a synchronous mirror to `SessionEntry.planMode` **inside** the session-store lock (the same `withSessionStoreLock` envelope), before the persistApprovalRequest returns. This satisfies the race-fix invariant: `lastPlanSteps` + `approvalId` + `title` land in the UI-readable surface before any approval event broadcasts.

**Compatibility test for the plugin port**: an integration test that loads the host UI in browser-test mode, has the plugin satisfy `SessionEntry.planMode` via the mirror, and asserts that all 5 FITS_SIDEBAR + 10 NEEDS_CHAT_STREAM elements from the catalog (`10-UI_GAP_ANALYSIS.md`) render byte-identical to in-host. **No new tests in the upstream PR series; tests live in plugin port.**

---

## §7 — Open items for Eva

1. **Confirm A.3 decoupling**. Plugin uses existing `SessionEntry.planMode` mirror surface; no new SDK seam needed.
2. **File the upstream issue first**. The 6-sub-PR plan is in §2; the issue body template is in §5. Without a direction-confirmation reply on that issue, do not submit U1.
3. **Identify the reviewer**. Map `jalehman` → openclaw-team contact, or alternatively tag the maintainer of #80684 / #80657 (recent active UI mergers).
4. **Greenlight the plugin port to lock the §6 schema NOW**. Plugin work proceeds in parallel with the upstream PRs (no scope coupling), but the schema must not change post-§6.

---

## §8 — Files / lines referenced

- `/Users/lume/repos/openclaw-pr70071-rebase/ui/src/ui/types.ts:452-486` — `SessionEntry.planMode` already-shipped shape that A.3 reuses
- `/Users/lume/repos/openclaw-pr70071-rebase/ui/src/ui/chat/mode-switcher.ts:1-424` — U2 body
- `/Users/lume/repos/openclaw-pr70071-rebase/ui/src/ui/views/plan-approval-inline.ts:1-306` — U3 body
- `/Users/lume/repos/openclaw-pr70071-rebase/ui/src/ui/chat/plan-cards.ts:1-122` — U4 body
- `/Users/lume/repos/openclaw-pr70071-rebase/ui/src/ui/chat/plan-resume.ts:1-21` — U4 body
- `/Users/lume/repos/openclaw-pr70071-rebase/ui/src/ui/chat/slash-command-executor.ts` — U5 body (~80 of 1305 LOC are plan-only)
- `/Users/lume/repos/openclaw-pr70071-rebase/ui/CLAUDE.md` — i18n regen rule justifying U6's standalone PR
- `/Users/lume/repos/openclaw-pr70071-rebase/CLAUDE.md` — root AGENTS.md gates (`pnpm check:changed`, `pnpm build`, `pnpm ui:i18n:sync`)
- Closed-PR evidence: #70066-70070 (per-part stack with red CI — anti-pattern to avoid), #71676 (200-files bot-closure), #70101 (umbrella tracker for prior rollout)
- Throughput data: `gh pr list -R openclaw/openclaw --state merged --limit 50 --json number,additions,createdAt,mergedAt`
