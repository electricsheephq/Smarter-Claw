# Blocker — W1-S17 webchat inline plan-mode UI

**Status:** **deferred — upstream-blocked.** The W1-S17 build-spec
proposed shipping the in-host plan-mode webchat UI (mode-switcher
chip, in-stream plan cards, plan-approval-inline card, plan-resume)
into the plugin via a bundle patcher that cherry-picks upstream
OpenClaw PR **#80982** (the `registerChatStreamRenderer` SDK seam).
Two compounding facts make the work non-shippable this cycle:
(a) PR #80982 is still **OPEN** with no review decision, and its API
shape has drifted from the snapshot the existing patcher cherry-picks;
(b) the existing patcher manifest targets `openclaw@2026.5.10-beta.5`,
but Wave-0 upgraded the host to `2026.5.18` and the content-hashed
bundle filenames the manifest keys on have all rotated — the patcher
cannot apply to the currently-installed openclaw.

S17 inherits the same upstream-SDK-permission landscape documented in
`blocker-W1-F1.md` and `blocker-W1-F3.md`: the affordances a plugin
needs to render into the chat stream — `chat-message`,
`chat-input-bar`, `chat-input-toolbar-chip` surfaces; or the
`registerChatStreamRenderer` shape that replaced them in the live PR —
are simply not in the published SDK at `2026.5.18`.

**Issue:** existing tracking issue
[electricsheephq/Smarter-Claw#78](https://github.com/electricsheephq/Smarter-Claw/issues/78)
("[blocked] Upstream OpenClaw SDK seams required for v1.0.0 —
chat-stream renderer + session enumeration + startup check") already
covers this dependency. Issue body explicitly cites
"`api.session.controls.registerChatStreamRenderer` — Inline
chat-stream UI: mode-switcher chip, inline plan cards" as the seam
needed for v1.0.0; "filed as DRAFT PR" matches PR #80982. No new
issue needed — append a comment linking this doc.

**Decision date:** 2026-05-20.

**Investigator:** parity-refresh Wave-5 worker (read-only against
in-host `/Users/lume/repos/openclaw-pr70071-rebase` tip `ea04ea52c7`;
plugin against the working tree on the same date; installed openclaw
host at `/opt/homebrew/lib/node_modules/openclaw@2026.5.18`; plugin
`node_modules/openclaw@2026.5.18`).

## Audit's claim, restated

`buildspec-S17-webchat-ui.md` (Wave-1 build-spec, 2026-05-19) proposed
a 6-sub-PR ladder shipping ~1,387 prod LOC + ~1,208 test LOC
(~2,595 LOC total) across 4 UI components:

| Component | File (in-host) | LOC | Seam surface |
|---|---|---|---|
| C1 — Mode-switcher chip | `ui/src/ui/chat/mode-switcher.ts` | 424 | `chat-input-toolbar-chip` |
| C2 — Plan-cards (in-stream) | `ui/src/ui/chat/plan-cards.ts` | 122 | `chat-message` |
| C3 — Plan-approval-inline | `ui/src/ui/views/plan-approval-inline.ts` | 306 | `chat-input-bar` |
| C4 — Plan-resume (network) | `ui/src/ui/chat/plan-resume.ts` | 21 | (helper in C3 bundle) |

Delivery vehicle: the plugin would **overlay OpenClaw's compiled
control-UI bundle** via `scripts/install-chat-stream-seam.mjs` +
`patches/openclaw-2026.5.10-beta.5/manifest.json`, which cherry-picks
4 commits from upstream PR #80982 (`feat/plugin-sdk-chat-stream-renderer`)
to add the 3 named surfaces. The build-spec itself flagged the
biggest risk: PR #80982 had drifted (API renamed to
`registerChatStreamRenderer`) and the host had bumped past the
patcher's target version.

## Investigation findings

### 1. Patcher staleness — verified, blocking

The existing patcher targets `openclaw@2026.5.10-beta.5`. The
installed openclaw is `2026.5.18` (both the global install at
`/opt/homebrew/lib/node_modules/openclaw/package.json` and the
plugin's `node_modules/openclaw/package.json`).

**The patcher's `MANIFEST_RELDIR` is hard-coded** at
`/Users/lume/repos/Smarter-Claw/scripts/install-chat-stream-seam.mjs:65`:

```js
const MANIFEST_RELDIR = "patches/openclaw-2026.5.10-beta.5";
```

The patcher reads `manifest.json` from that directory and would
demand `openclawVersion === "2026.5.10-beta.5"`. On the installed
`2026.5.18` it would fail at the version check
(`install-chat-stream-seam.mjs:172-178` — process exit 3).

**Even if version-bypassed, the manifest's target files do not exist
in `2026.5.18`:**

| Manifest expects (`patches/openclaw-2026.5.10-beta.5/manifest.json`) | Present in `2026.5.18`? |
|---|---|
| `dist/loader-DdN5GTsW.js` (baseline SHA `6261d5bfb398…`) | **NO** — `ls /opt/homebrew/lib/node_modules/openclaw/dist/loader-DdN5GTsW.js` → does not exist |
| `dist/protocol-BBwaRnfZ.js` (baseline SHA `2d22a827ff37…`) | **NO** — `ls /opt/homebrew/lib/node_modules/openclaw/dist/protocol-BBwaRnfZ.js` → does not exist |

The bundle filenames are **content-hashed** by Rollup/Vite and rotate
on every host release. `2026.5.18` ships:
- `dist/loader-CxUWY2_6.js` (234,718 bytes; SHA256 `cca865e6868c…`)
- `dist/loader-jaFoEHc6.js` (8,833 bytes)
- `dist/protocol-CdYy0xVK.js` (147,154 bytes; SHA256 `9172a8dc960a…`)
- `dist/protocol-B17omF7t.js` (315 bytes; SHA256 `a135edcd0ec7…`)

The patcher's pre-flight (`install-chat-stream-seam.mjs:186-218`)
**correctly fails safe** here: missing files → `MISSING: <relpath>` →
process exit 4 ("Refusing to apply"). The fail-safe is working as
designed; the patcher itself cannot be applied to the current
openclaw without a complete regeneration (new manifest dir,
re-cherry-picked seam, recomputed SHAs, identified seam-bearing
chunks among the renamed bundles).

### 2. Upstream PR #80982 status — verified open + drifted

`gh pr view 80982 --repo openclaw/openclaw --json
state,mergedAt,mergeCommit,title,updatedAt,additions,deletions,reviewDecision`
returned:

```json
{
  "additions": 684,
  "deletions": 6,
  "mergeCommit": null,
  "mergedAt": null,
  "reviewDecision": "",
  "state": "OPEN",
  "title": "feat(plugin-sdk): registerChatStreamRenderer for plugin-owned inline UI",
  "updatedAt": "2026-05-12T22:42:30Z"
}
```

- **State**: OPEN. Not merged. No review decision recorded. Last
  updated 2026-05-12 — unchanged in the 8 days since the catalog tip.
- **API drift confirmed**: live PR title is now
  `registerChatStreamRenderer for plugin-owned inline UI` — a
  **renderer-registration seam**, whereas the manifest's cherry-pick
  cites the older 3-named-surface design
  (`patches/openclaw-2026.5.10-beta.5/manifest.json` `seamSource`):

  ```
  03eff456641 feat(plugin-sdk): add chat-stream Control UI surfaces for plugin-owned inline UI
  c8c76662b77 fix: drop unused import + regenerate Swift protocol bindings
  72e74e20d53 fix(contracts-test): drop unused oxlint-disable directive
  1ceb88cea65 rename: chat-header-chip → chat-input-toolbar-chip (matches actual UI placement)
  ```

  When (if) #80982 merges with its current
  `registerChatStreamRenderer` shape, the patcher's snapshot will be
  overlaying an API the upstream maintainers explicitly moved away
  from — and the plugin's 4 UI components would need to be re-ported
  onto the merged seam shape regardless.

### 3. The seam is not in `2026.5.18` — verified

Confirmed against the installed openclaw at
`/Users/lume/repos/Smarter-Claw/node_modules/openclaw/`:

- `grep -l "chat-input-toolbar-chip\|chat-input-bar\|chat-message"
  dist/loader-CxUWY2_6.js dist/protocol-CdYy0xVK.js
  dist/protocol-B17omF7t.js` → no matches.
- `grep -l "registerChatStreamRenderer\|chatStreamSurfaces\|chatStreamRenderer"
  dist/*.js` → no matches.
- `grep -rn "registerChatStreamRenderer\|chatStreamSurfaces"
  dist/plugin-sdk/` → no matches.
- `dist/plugin-sdk/src/plugins/host-hooks.d.ts:72-74` exposes only:

  ```ts
  export type PluginControlUiDescriptor = {
      …
      surface: "session" | "tool" | "run" | "settings";
  ```

  None of the chat-stream surface names. None of the renderer seam.
  The SDK at `2026.5.18` simply does not expose any plugin-callable
  affordance that renders into the chat stream.

### 4. In-host UI files — verified at the catalog tip

The 4 source-of-truth files exist at the catalog tip
`ea04ea52c7` (in `/Users/lume/repos/openclaw-pr70071-rebase`, branch
`rebase/pr70071-onto-main-2026-04-25`); sizes match buildspec-S17
exactly:

```
$ git show ea04ea52c7:ui/src/ui/chat/mode-switcher.ts | wc -l       →  424
$ git show ea04ea52c7:ui/src/ui/chat/plan-cards.ts | wc -l          →  122
$ git show ea04ea52c7:ui/src/ui/chat/plan-resume.ts | wc -l         →   21
$ git show ea04ea52c7:ui/src/ui/views/plan-approval-inline.ts |wc -l→  306
```

The port source is stable and frozen at `ea04ea52c7` — when the seam
lands upstream (in whatever final API shape #80982 merges with), the
4 files re-port onto the plugin's seam without further drift on the
in-host side. The blocker is purely on the seam-availability axis.

### 5. Knock-on effects

Even in the hypothetical where the SDK seam ships tomorrow, S17 is
**not** a 1-line patcher-regen task. The full scope from
buildspec-S17 §4 is:

| Sub-PR | Title | Prod LOC | Test LOC |
|---|---|---|---|
| S17.1 | Patcher regen for `<current-host>` + manifest | ~120 | ~80 |
| S17.2 | Mode-switcher chip → toolbar | ~424 | ~388 |
| S17.3 | Plan-approval-inline card → input-bar | ~306 | ~295 |
| S17.4 | Plan-cards → message + plan-resume | ~143 | ~185 |
| S17.5 | CSS + input-bar-suppression mitigation | ~214 | ~60 |
| S17.6 | Plugin-state wiring + parity smoke | ~180 | ~200 |
| | **TOTAL** | **~1,387** | **~1,208** |

The patcher is the smallest piece; the bulk is C1–C4 rendering code +
state wiring + the input-bar-suppression mitigation for the
correctness gap (catalog element #22) that the 3-surface design
**cannot** fix without the `suppressInputWhileVisible` option that
the `registerChatStreamRenderer` shape introduces. So even a
patcher-only regeneration would leave a known correctness gap unless
the renderer seam is what eventually merges.

## Smallest viable path forward

Three ordered steps, all gated on upstream:

**(a) Upstream**: PR #80982 (or its successor) merges into an
OpenClaw release. The renderer-seam shape currently in the live PR
is the right architecture (it carries `suppressInputWhileVisible`
which closes the catalog #22 correctness gap that the 3-surface
design cannot). Smarter-Claw has no leverage to accelerate this; it
is a moving-target upstream dependency the plugin team does not own.

**(b) Plugin — regenerate patcher (if patcher is still needed)**:
once upstream has stabilized on whatever final API shape merges, cut
a new `patches/openclaw-<version>/manifest.json` against the
then-current host bundles, parameterize `MANIFEST_RELDIR` in
`scripts/install-chat-stream-seam.mjs:65` (or auto-detect from
installed-host version), and recompute baseline + patched SHAs. If
the seam ships in a stable OpenClaw release the patcher can be
**dropped entirely** — per the script's own header comment (lines
19-21): "Once the upstream PR lands in an `openclaw@>=X` release,
bump `peerDependencies.openclaw` in our package.json + drop this
patcher." Regenerating while upstream is still drifting would just
require re-regenerating on merge.

**(c) Plugin — port the 4 UI components**: re-port
`mode-switcher.ts`, `plan-cards.ts`, `plan-approval-inline.ts`,
`plan-resume.ts` from in-host tip `ea04ea52c7` onto whatever final
seam shape #80982 lands with. The 6-sub-PR ladder from
buildspec-S17 §4 holds — each sub-PR < 600 LOC satisfies the
AGENTS.md per-PR ceiling and avoids the `openclaw-barnacle` /
Greptile-100-file bot-closure failure mode that killed PR #71676.

## Interim posture

**No production code change. Documentation-only this cycle.**

The plugin's user-facing webchat UX is **not absent today** — it is
just sidebar-only:

- **Sidebar approval card.** `src/ui/sidebar-descriptor.ts` registers
  a `PluginControlUiDescriptor` via the in-SDK
  `registerControlUiDescriptor` (wired in Wave 3 — see `wave-3` row
  in `EXECUTION-STATUS.md` cluster `ui-surfaces`). On webchat and
  Codex desktop, operators see the plan-approval card in the sidebar.
- **Cross-surface `/plan` commands.** `src/ui/slash-commands.ts`
  wires `/plan accept`, `/plan reject`, `/plan revise <feedback>`,
  `/plan answer <text>`, `/plan auto on|off`, etc. These resolve a
  pending approval on **every channel** (webchat, Telegram, Slack,
  CLI) via the universal text pipeline — so an operator can act on a
  pending plan from any surface, even without inline UI.
- **Plan markdown persistence (W1-F2, shipped).** Every approval
  cycle writes `~/.openclaw/agents/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md`
  via `src/tools/exit-plan-mode.ts` →
  `persistPlanArchetypeIfConfigured` → `persistPlanArchetypeMarkdown`
  in `src/plan-mode/plan-archetype-persist.ts`. The artifact is the
  building block a future channel-push notifier would attach (see
  `blocker-W1-F1.md` / `blocker-W1-F3.md`).

**The webchat-inline gap is a UX enhancement, not a correctness
blocker.** Plan-mode runs correctly today; users can see and resolve
plans; the gap is purely the inline chat-stream rendering that
matches the in-host PR #70071 polish (and would let users act on the
plan without leaving the message thread). Feature parity for inline
webchat UI lands when upstream stabilizes — not before.

## Cross-link

The underlying SDK-permission scope blocking S17 is the same shape
as the blockers documented in:

- `blocker-W1-F1.md` — `sendSessionAttachment` and `emitAgentEvent`
  on host-owned streams (`approval`, `lifecycle`, etc.) reject 3P
  plugins; channel notifications cannot be pushed proactively.
- `blocker-W1-F3.md` — same SDK seams; multi-surface approval push
  on Telegram/Slack.

S17 differs in mechanism (the chat-stream rendering surfaces are
absent entirely, vs F1/F3 where the seams exist but are
`bundled-only`-gated), but the conclusion is the same: the plugin
cannot fill the gap from outside the host's SDK boundary. The work
is gated on an upstream release.

## Tracking

- W1-S17 row in `wave-1-catalog.md`: build-spec section already cites
  the #80982 risk. Appended a "Wave 5 status: deferred → blocker-W1-S17"
  note in that same section to make the status visible without
  re-reading the build-spec.
- `EXECUTION-STATUS.md`: Wave 5 row updated to "deferred —
  upstream-blocked (see blocker-W1-S17-webchat-ui.md)".
- Upstream issue: **electricsheephq/Smarter-Claw#78** already exists
  and is open — no new issue needed. Append a comment linking this
  doc when convenient.
- No upstream issue should be filed against `openclaw/openclaw` —
  PR #80982 IS the upstream surface; it's already open.

## Lessons

- **Content-hashed bundle names rotate on every host release.** The
  `2026.5.10-beta.5` → `2026.5.18` bump alone changed `loader-*` and
  `protocol-*` hashes; any patcher that overlays compiled bundles
  needs a new manifest per host release. The patcher's SHA pre-flight
  correctly refuses to apply on drift, so this fails safe — but
  shipping a patcher in a moving-host environment is an ongoing toil
  cost the plugin should size for.
- **Cherry-picking an open upstream PR is fragile.** PR #80982's
  API has materially drifted (3-named-surfaces → renderer-seam)
  since the manifest snapshot was cut. The plugin code path that
  rests on a stale cherry-pick (the entire S17 work) is exposed to
  the upstream maintainers' design choices. Either accept the
  carried-fork cost and re-port on every upstream change, or wait
  for upstream to merge before designing against it.
- **"Upstream-blocked" is not a synonym for "blocked on us."** The
  Smarter-Claw team can ship S17 only when upstream merges — and the
  upstream PR has sat open + unmodified for 8+ days. This is the
  right blocker classification: not "we haven't done the work" but
  "the work cannot be done from our side of the boundary."
