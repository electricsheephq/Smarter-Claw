# Build-Spec S17 — Webchat Inline Plan-Mode UI

**Slice**: S17 (webchat inline UI) of the Smarter-Claw parity-refresh.
**Status**: BUILD-SPEC (not an audit). Validates + refreshes the prior `architecture-v2-planning` effort.
**Date**: 2026-05-19.

## 0. Premise

The Smarter-Claw plugin currently renders **zero inline webchat UI** — no mode-switcher
chip, no in-stream plan cards, no approval card above the input bar. Only a sidebar
descriptor (via `registerControlUiDescriptor`). Target: full webchat parity with the
in-host plan-mode UI (PR #70071 lineage).

This spec **reuses** the prior arch-v2 analysis rather than starting fresh. The
authoritative inputs are, on branch `architecture-v2-planning`:
- `architecture-v2/10-UI_GAP_ANALYSIS.md` — 25-element in-host UI catalog.
- `architecture-v2/12-PATH_A_DEEP_DIVE.md` — 6-sub-PR build ladder (U1–U6).
- `architecture-v2/07b-PR_LADDER_v2.md` — Track B (upstream UI) section.

**Key reframing vs arch-v2**: arch-v2's "Path A" lands the UI **in OpenClaw upstream**
as 6 sub-PRs. S17 is the *plugin-delivered* variant — the same 4 UI files, but rendered
into Control-UI seam surfaces via a **bundle patcher**, not merged into core. The
component inventory and LOC estimates carry over; the delivery mechanism does not.

---

## 1. Validation of `10-UI_GAP_ANALYSIS.md`

**Verdict: the 25-element catalog is STILL VALID. Zero structural drift.**

The catalog was built against `openclaw-pr70071-rebase` @ `ea04ea52c7`
(branch `rebase/pr70071-onto-main-2026-04-25`). I re-verified the in-host UI tree at
that same tip on `/Volumes/LEXAR/repos/openclaw-pr70071-rebase`:

| Catalog claim | Re-verified | Result |
|---|---|---|
| `mode-switcher.ts` 424 LOC | `git show …:ui/src/ui/chat/mode-switcher.ts \| wc -l` → 424 | MATCH |
| `plan-cards.ts` 122 LOC | → 122 | MATCH |
| `plan-approval-inline.ts` 306 LOC | → 306 | MATCH |
| `plan-resume.ts` 21 LOC | → 21 | MATCH |
| `plan-cards.css` 134 LOC | → 134 | MATCH |
| `views/chat.ts` 1652 LOC, ~250 plan-mode | 1652 total; 57 lines match plan-mode tokens | MATCH (token-grep proxy) |
| `SessionEntry.planMode` at `types.ts:452-486` | lines 452 (`planMode?:`), 469 (`lastPlanSteps?:`), 487 (`pendingInteraction?:`) | MATCH |

**Drift assessment — two axes:**

1. **In-host tree drift (catalog tip → `2026.5.18`)**: NOT APPLICABLE in the way it
   first appears. The catalog's render-surface *classification* (NEEDS_CHAT_STREAM /
   FITS_SIDEBAR / EITHER_WAY) is an analysis of plan-mode UX semantics, not of a
   moving source tree. The 4 in-host UI files are frozen at `ea04ea52c7` — that is the
   port source-of-truth and does not chase upstream. So the catalog needs no refresh
   for the in-host side.

2. **Host-target drift (`2026.5.10-beta.5` → `2026.5.18`)**: THIS is the real drift,
   and it lands entirely on the **patcher** (§3), not the catalog. The installed host
   is now `2026.5.18` (verified: `/opt/homebrew/lib/node_modules/openclaw/package.json`).
   The catalog's element list is unaffected; only the delivery overlay must be rebuilt.

**One catalog item to re-confirm during build — element #17 (dead code).** The catalog
flags `renderPlanCard()` as exported-but-never-imported in the in-host build (plan
progress goes to the sidebar markdown only). For S17 this is an *opportunity*: the
plugin's `chat-message` surface is exactly the home `renderPlanCard()` was written for.
S17 should **wire it** (the in-host never did) — see component C2.

**Net**: the 25-element catalog stands. Use it verbatim as the S17 element checklist.
The NEEDS_CHAT_STREAM(10) / FITS_SIDEBAR(5) / EITHER_WAY(10) split is unchanged.

---

## 2. The 4 UI components

The plugin already ships the FITS_SIDEBAR(5) elements via the sidebar descriptor.
S17 adds the **NEEDS_CHAT_STREAM(10)** elements, which the in-host packs into 4 files.
Each maps to one Control-UI seam surface introduced by the chat-stream-seam patcher.

### C1 — Mode-switcher chip (`mode-switcher.ts`, ~424 LOC)

- **Renders**: the Default / Ask / Accept / Plan / Plan⚡ / Bypass pill + dropdown menu
  + `Ctrl+1..6` keyboard shortcut handler. Catalog elements **#1, #2, #3**.
- **Surface**: `chat-input-toolbar-chip` — the pill sits in the input toolbar row
  alongside file-attach + mic (per manifest `surfaceNames[2]`).
- **Plugin-state read**: session plan-mode shape — `planMode` (`plan`/`normal`),
  `autoApprove` (drives the ⚡ variant), plus `execSecurity`/`execAsk` for the
  non-plan modes. Exports verified: `MODE_DEFINITIONS`, `resolveCurrentMode()`,
  `renderModeSwitcher()`, `handleModeShortcut()`.
- **Write path**: `sessions.patch { planMode }`. Backend no-ops if plan infra absent.
- **Port note**: `handleModeShortcut` has a shadow-DOM focus guard (skips `Ctrl+digit`
  when a composer/contenteditable surface is focused) — preserve it verbatim.

### C2 — Plan-cards (`plan-cards.ts`, ~122 LOC)

- **Renders**: `renderPlanCard()` (in-stream step-checklist card for `update_plan`
  events) + `formatPlanAsMarkdown()`. Catalog elements **#13** (live checklist render),
  **#17** (the currently-dead `renderPlanCard`).
- **Surface**: `chat-message` — informational expandable card in the message stream,
  same affordance class as tool-call cards (per manifest `surfaceNames[0]`).
- **Plugin-state read**: `planMode.lastPlanSteps[]` (`{step,status,activeForm,
  acceptanceCriteria,verifiedCriteria}`) + `lastPlanUpdatedAt`.
- **Port note**: pure render functions, no state machine — lowest-risk component.
  Wire `renderPlanCard()` into the `chat-message` surface (the in-host left it dead).

### C3 — Plan-approval-inline card (`plan-approval-inline.ts`, ~306 LOC)

- **Renders**: the Accept / Accept-with-edits / Revise card; the title strip
  ("Agent proposed a plan — …"); the in-place revise textarea; the AskUserQuestion
  variant (question + option buttons + "Other…" textarea); the error banner.
  Catalog elements **#4, #5, #7, #8, #9, #10** — the bulk of NEEDS_CHAT_STREAM.
- **Surface**: `chat-input-bar` — card renders **above** the chat input bar
  (per manifest `surfaceNames[1]`).
- **Plugin-state read**: `planApprovalRequest`, `planApprovalBusy`, `planApprovalError`,
  `planApprovalReviseOpen`/`reviseDraft`, `planApprovalQuestionOtherOpen`/`otherDraft`,
  `planApprovalDismissedApprovalIds` (#25, anti-blink set); plus
  `SessionEntry.pendingInteraction` for the question variant. Exports verified:
  `InlinePlanApprovalProps`, `renderInlinePlanApproval()`.
- **Write path**: `sessions.patch { planApproval: … }`.
- **HARD RISK — element #22 (input-bar suppression)**: in-host *replaces* the composer
  with the card. A plugin overlaying `chat-input-bar` renders *above* the input but
  **cannot suppress the host composer**. With a pending approval, the user can still
  type + Enter → out-of-band chat message. arch-v2 `10-UI_GAP_ANALYSIS.md` calls this
  a **correctness gap, not cosmetic**. S17 mitigation: render a disabled-state overlay
  + an explicit "approval pending — submit anyway?" confirm on composer-submit. This
  does not reach in-host fidelity; flag for Eva. (arch-v2 Path C — a real
  `registerChatStreamRenderer` SDK seam with `suppressInputWhileVisible` — is the only
  true fix, and #80982 is that seam in flight.)

### C4 — Plan-resume (`plan-resume.ts`, ~21 LOC)

- **Renders**: nothing — network-only. Catalog element **#21**.
- **Surface**: none. Ships inside the C3 bundle as a helper.
- **Behavior**: `resumePendingPlanInteraction()` fires a hidden
  `client.request("chat.send", { deliver: false, … })` to nudge the agent to resume
  after approval. Verified at `plan-resume.ts:11-18`.
- **Port note**: trivial; the only watch-item is `chat.send` idempotency (don't
  double-fire on re-render).

**Not in S17**: the FITS_SIDEBAR(5) elements (#12 plan-view widget, #14 title,
#15 archetype sections, #23 auto-open) — already shipped via the sidebar descriptor.
S17 keeps them; it only *adds* the chat-stream surfaces.

---

## 3. Patcher plan

The plugin delivers webchat UI by **overlaying OpenClaw's compiled control-UI bundle**.
The existing patcher (`scripts/install-chat-stream-seam.mjs` +
`patches/openclaw-2026.5.10-beta.5/manifest.json`) cherry-picks upstream PR
**openclaw/openclaw#80982** to add 3 Control-UI surfaces (`chat-message`,
`chat-input-bar`, `chat-input-toolbar-chip`) onto `2026.5.10-beta.5`.

**S17 must regenerate the patcher for `2026.5.18`. Three concrete deltas:**

1. **Content-hashed bundle filenames changed.** Verified on the installed host:
   - manifest expects `dist/loader-DdN5GTsW.js` + `dist/protocol-BBwaRnfZ.js`.
   - `2026.5.18` ships `dist/loader-CxUWY2_6.js` / `loader-jaFoEHc6.js` and
     `dist/protocol-B17omF7t.js` / `protocol-CdYy0xVK.js` (multiple — the seam-bearing
     pair must be identified during regen).
   The patcher keys on `relativePath` + SHA, so a new
   `patches/openclaw-2026.5.18/manifest.json` directory is mandatory. The patcher
   *script* itself needs one change: `MANIFEST_RELDIR` is hard-coded to
   `patches/openclaw-2026.5.10-beta.5` (line 65) — parameterize it or bump it.

2. **Re-cherry-pick #80982 onto the `2026.5.18` tag**, rebuild the loader + protocol
   bundles, recompute `baselineSha256` (stock `2026.5.18`) + `patchedSha256`
   (post-overlay), and write the new manifest. The 4 seam commits are listed in the
   current manifest's `seamSource.commits`.

3. **`2026.5.18` does NOT already ship the seam.** Verified: no `chat-input-toolbar-chip`
   / `chat-input-bar` surface strings in `/opt/homebrew/lib/node_modules/openclaw/dist/`.
   So the patcher is still required — it cannot be dropped yet.

### The #80982 cherry-pick risk — ELEVATED

- **#80982 is still OPEN** (verified `gh pr view 80982 -R openclaw/openclaw`:
  `state: OPEN`, `mergedAt: null`, `mergeCommit: null`). Last updated 2026-05-12,
  13 files / +684, **no review decision** recorded.
- The PR **title has drifted**: the manifest cites it as *"add chat-stream Control UI
  surfaces"* (a descriptor-surface approach), but the live PR is now
  *"feat(plugin-sdk): registerChatStreamRenderer for plugin-owned inline UI"* — a
  **different, larger API shape** (a renderer-registration seam, matching arch-v2's
  Path C). This means the upstream design moved away from the 3-surface approach the
  current patcher cherry-picks.
- **Implication**: the 4 seam commits in the manifest are a *now-stale snapshot* of
  #80982. When #80982 eventually merges it will likely land the `registerChatStreamRenderer`
  shape, NOT the 3 named surfaces. S17's patcher will then be overlaying an API that
  upstream never shipped — a permanent fork the plugin must carry until it re-ports
  the 4 UI files onto whatever #80982 actually merges.
- **Recommendation**: treat the cherry-pick snapshot as load-bearing and *pin it*
  (the manifest already records the 4 commit SHAs — good). Add a tracking note that
  when #80982 merges, S17's UI files need a re-port onto the merged seam shape, and
  the patcher gets dropped (per the script's own header comment, lines 19-21).

---

## 4. Implementation sub-PR ladder

S17 is the **plugin-delivered** variant of arch-v2's Track B. arch-v2's U1–U6 land in
OpenClaw upstream; S17's S17.1–S17.6 land in the **Smarter-Claw repo** and ship the
*same* 4 UI files into the patched seam surfaces. LOC per component carries over from
`12-PATH_A_DEEP_DIVE.md` §2.

| Sub-PR | Title | Components | Prod LOC | Test LOC | Depends on |
|---|---|---|---|---|---|
| **S17.1** | Patcher regen for `2026.5.18` + manifest | patcher script + new `patches/openclaw-2026.5.18/` | ~120 (manifest + script param) | ~80 (verify-seam) | — |
| **S17.2** | Mode-switcher chip → `chat-input-toolbar-chip` | C1 | ~424 | ~388 | S17.1 |
| **S17.3** | Plan-approval-inline card → `chat-input-bar` | C3 | ~306 | ~295 | S17.1, S17.2 |
| **S17.4** | Plan-cards → `chat-message` + plan-resume | C2, C4 | ~143 (122+21) | ~185 (159+26) | S17.3 |
| **S17.5** | CSS + input-bar-suppression mitigation | `plan-cards.css` + composer-guard | ~134 + ~80 | ~60 | S17.3 |
| **S17.6** | Plugin-state wiring + parity smoke | mirror to seam props + harness | ~180 | ~200 | S17.2–S17.5 |

**Totals**: ~1,387 prod LOC + ~1,208 test LOC = **~2,595 LOC across 6 sub-PRs**.
Aligned with arch-v2's "~2,560 LOC" Track B figure (`07b-PR_LADDER_v2.md` line 24).
Every sub-PR < 600 LOC — satisfies the AGENTS.md per-PR ceiling and avoids the
`openclaw-barnacle` / Greptile-100-file bot-closure failure mode that killed PR #71676.

**Ordering rationale**: S17.1 first (the seam must exist before anything renders into
it). S17.2 (chip) is self-contained. S17.3 (approval card) is the biggest behavioral
piece + carries the #22 risk. S17.4 is pure-render on top of S17.3's shell. S17.5
(CSS + mitigation) and S17.6 (wiring + smoke) close it out. S17.4 + S17.5 can land in
parallel (both depend only on S17.3).

**i18n note**: arch-v2's U6 was a standalone full-locale-sync PR because the in-host
`ui/CLAUDE.md` forbids hand-editing non-English bundles. For the **plugin-delivered**
path the plugin owns its own strings — S17 folds i18n into each component sub-PR
rather than a separate locale-regen PR (no host-locale-pipeline coupling). This is the
one structural divergence from the arch-v2 ladder.

---

## 5. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | **#80982 still OPEN + API shape drifted** to `registerChatStreamRenderer`. The 3-surface cherry-pick is now a stale snapshot of a moving PR. | **HIGH** | Pin the 4 commit SHAs (manifest already does). Accept the patcher as a carried fork. Plan a re-port of the 4 UI files when #80982 merges; drop the patcher then. |
| **R2** | **Content-hashed bundle names rotate every host release.** `2026.5.10-beta.5` → `2026.5.18` already changed `loader-*` / `protocol-*` hashes. Every host bump re-breaks the patcher. | **HIGH** | New `patches/openclaw-<version>/` manifest per host release. The SHA pre-flight in `install-chat-stream-seam.mjs` (lines 186-218) *correctly refuses to apply on drift* — so this fails safe, but needs a manifest-regen each bump. |
| **R3** | **Rebuild requirement.** Patcher overlays compiled bundles; the host must be re-patched after any `npm i -g openclaw` upgrade or the seam silently reverts. | **MEDIUM** | Document in install flow; `verify-chat-stream-seam.mjs` checks the sentinel. Consider a postinstall hook. |
| **R4** | **Input-bar suppression (element #22) is unreachable via patched surfaces** — overlaying `chat-input-bar` cannot disable the host composer. arch-v2 calls this a correctness gap. | **MEDIUM** | S17.5 ships a disabled overlay + submit-confirm. Not full fidelity. True fix = #80982's `suppressInputWhileVisible` (Path C) — gated on R1. |
| **R5** | **Patcher script hard-codes `MANIFEST_RELDIR`** (line 65) to the beta.5 path — regen alone is insufficient without a script edit. | **LOW** | S17.1 parameterizes the manifest dir (auto-detect installed version → matching manifest). |

### The single biggest risk

**R1 — upstream PR #80982 is OPEN and its API has drifted.** The plugin's entire
webchat-UI delivery rests on a cherry-pick of #80982's *3-named-surface* design, but
the live PR is now a `registerChatStreamRenderer` renderer-seam — a different shape.
S17 can ship today against the pinned snapshot, but the moment #80982 merges (or is
closed in favor of yet another design) the patcher overlays an API upstream never
released, forcing a re-port of all 4 UI components. Everything else (hash rotation,
rebuilds) is mechanical toil; R1 is a moving-target architectural dependency on code
the Smarter-Claw team does not own.

---

## 6. Files referenced

- `/Users/lume/repos/Smarter-Claw/scripts/install-chat-stream-seam.mjs` — patcher (`MANIFEST_RELDIR` line 65; SHA pre-flight 186-218)
- `/Users/lume/repos/Smarter-Claw/patches/openclaw-2026.5.10-beta.5/manifest.json` — stale-target manifest (#80982 cherry-pick: `seamSource.commits`)
- `architecture-v2-planning:architecture-v2/10-UI_GAP_ANALYSIS.md` — 25-element catalog (validated §1)
- `architecture-v2-planning:architecture-v2/12-PATH_A_DEEP_DIVE.md` — U1–U6 ladder + LOC source
- `architecture-v2-planning:architecture-v2/07b-PR_LADDER_v2.md` — Track B section
- `rebase/pr70071-onto-main-2026-04-25:ui/src/ui/chat/mode-switcher.ts` — C1 (424 LOC)
- `rebase/pr70071-onto-main-2026-04-25:ui/src/ui/chat/plan-cards.ts` — C2 (122 LOC)
- `rebase/pr70071-onto-main-2026-04-25:ui/src/ui/views/plan-approval-inline.ts` — C3 (306 LOC)
- `rebase/pr70071-onto-main-2026-04-25:ui/src/ui/chat/plan-resume.ts` — C4 (21 LOC)
- `rebase/pr70071-onto-main-2026-04-25:ui/src/ui/types.ts:452-486` — `SessionEntry.planMode` shape
- (in-host source: `/Volumes/LEXAR/repos/openclaw-pr70071-rebase`, branch `rebase/pr70071-onto-main-2026-04-25`, tip `ea04ea52c7`)
- `/opt/homebrew/lib/node_modules/openclaw` — installed host `2026.5.18` (patch target)
