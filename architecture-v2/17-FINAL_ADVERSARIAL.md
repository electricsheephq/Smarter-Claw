# 17 — Final Adversarial Pass (≥95% Ship Gate)

**Status**: final pre-lock review against the consolidated architecture
(Option C + 10-invariant typed mutator + Path A UI + parity-harness +
MEDIUM mitigations). Eva's bar ≥95%. Wave 5 (post mitigation) = ~90%.

**Inputs read (in full)**: docs 11, 14, 15, 16, 07b. Skimmed: 01, 05, 12, 13.
Cross-references: in-host package.json (MIT licensed), Smarter-Claw
package.json (`"SEE LICENSE IN LICENSE"`, `0.2.0-dev`),
`openclaw.plugin.json` manifest, `.github/workflows/{ci,installer-roundtrip}.yml`
exist.

**Method**: take the architecture at face value. Probe FIVE new angles
the prior agents (05-, 13-) did not cover. Classify each. No
re-litigation of Option C vs A/B, Path A vs B/C.

---

## Probe 1: Cost/token economics of multi-turn plan-mode in a plugin

**Severity**: **MEDIUM**

**Finding**: The in-host plan-mode flow injects archetype text and
`[PLAN_MODE_INTRO]` once per mode transition, plus per-turn the agent
sees `planMode` in its runtime context. The plugin port re-implements
this via `before_prompt_build` hooks that compose the archetype + queue
of `pendingAgentInjections` (`01-PARITY_CATALOG.md:47`) into each turn's
system prompt. There are two potential regressions:

1. **Hook indirection cost**: `before_prompt_build` runs every turn, even
   when planMode is not active. Reading `pluginExtensions[smarter-claw][plan-mode]`
   to determine "no archetype needed" is cheap (<1 ms), but the hook
   call itself adds latency to every turn. For a 20-turn session this
   is ~20 extra plugin-hook invocations.
2. **Cache-busting risk**: prompt caching (Anthropic) requires
   stable prefixes. If the plugin injects archetype text in a slightly
   different order or with a different timestamp than the in-host
   version, cache hit-rate drops. The in-host pendingInjections queue
   uses `localeCompare` for deterministic tiebreaker (`01-:1639`); the
   plugin must replicate this byte-for-byte.

The token-count delta is bounded — the archetype + plan-mode-intro is
fixed-size (~800 tokens once, no per-turn growth). But cache misses
could cost 5-10× the steady-state token spend if the prefix isn't
byte-identical. This is a real production-cost regression vector.

**Existing coverage**: `01-PARITY_CATALOG.md:1639` references the
deterministic tiebreaker. `14-PARITY_HARNESS_DESIGN.md` Layer 1
exercises `composePromptWithPendingInjections` parity. **But** neither
artifact specifies a CACHE-BUST regression test: assert that the
plugin's composed prompt prefix is byte-identical to the in-host
reference's, not just structurally equivalent.

**Recommendation**: Add to PR-7 (`runtime context propagation`)
acceptance criteria: a byte-identical prefix-diff test against the
in-host reference using the parity-harness Layer 1 infrastructure. If
prefix differs by even a single whitespace character, the test fails.
Tracked as a parity-harness case, not a separate harness. No new code,
~30 LOC of test wiring.

---

## Probe 2: Operator install funnel — 3-step prerequisites are 3 chances to fail

**Severity**: **HIGH**

**Finding**: An operator wanting plan-mode via Smarter-Claw must
complete THREE prerequisites:

1. Install Smarter-Claw plugin (`openclaw plugin install smarter-claw`)
2. Upgrade host to `>=v<X.Y.Z>` (the version that includes Path A UI
   sub-PRs U1-U6 merged)
3. Add `plugins.entries.smarter-claw.hooks.allowConversationAccess: true`
   to operator config

Each step has a different failure mode:

- **Step 1 succeeds, Step 2 missing**: per `13-:230` and
  `sdk-setup.md:171-173`, `minHostVersion` is install-time enforced —
  install fails outright. **Loud failure.** Acceptable.
- **Step 1+2 succeed, Step 3 missing**: per `13-:344-356`, plugin loads
  silently. Hooks register but no-op. **Silent failure.** The
  `16-MEDIUM_MITIGATIONS.md` 5-layer mitigation (in-plugin detection +
  entry banner + manifest description + README + upstream-issue) is
  designed to mitigate this. But each layer is best-effort:
  - In-plugin detection requires the hook to fire at all — but
    `before_tool_call` only fires when `allowConversationAccess`
    is true (the very flag we're checking). Catch-22.
  - Entry banner: `logger.warn` at `register(api)` time fires once
    in gateway boot logs; operators often don't read these.
  - README/manifest: depends on operators reading documentation
    (`LESSONS_LEARNED.B1` — documentation alone is insufficient).
- **All 3 succeed**: plugin works. Probably ~60-70% of ClawHub-savvy
  operators reach this state on first try.

The funnel is REAL. ClawHub-listed plugins that require
`allowConversationAccess` will hit a "looks installed but broken"
state for a substantial fraction of installs.

**Existing coverage**: `16-MEDIUM_MITIGATIONS.md` Section "MEDIUM 3"
documents this 5-layer strategy. `13-NEW-10` acknowledges it. But
both treat it as MEDIUM. I escalate to HIGH because:
- It's the first impression for every ClawHub user.
- The silent-failure mode is exactly `LESSONS_LEARNED.B1` —
  schema-accepted, no-op config knobs — which is the failure pattern
  this whole architecture-v2 effort exists to avoid.
- No layer of the 5-layer mitigation is *enforcing*. They are all
  observable-only.

**Recommendation**: Two additions before v1.0 ships:

1. **PR-1 acceptance criterion**: at `register(api)` time, IF
   `api.config.get('allowConversationAccess')` is falsy, register a
   `session_start` hook (which DOES fire without `allowConversationAccess`
   per `hooks.md`) that emits `api.systemMessage` to EVERY session:
   "⚠️ Smarter-Claw is installed but `allowConversationAccess: true`
   is not set. Plan-mode features are disabled. See <link>." This
   makes the broken state user-visible, not just operator-visible.
2. **PR-14 release gate**: open the upstream RFC for
   `api.registerStartupCheck` (per `16-` Layer 5) and link to it from
   the README. Make ClawHub listing description's FIRST sentence the
   warning. Not "Plan Mode and Auto-Plan Mode" — start with "Requires
   `allowConversationAccess: true`." Sacrifices marketing for clarity.

Mitigation downgrades this to MEDIUM. As-stated it's HIGH.

---

## Probe 3: Plugin-priority race vs security feature in a public plugin

**Severity**: **HIGH** (with named mitigations: degrades to MEDIUM)

**Finding**: Vector 6 in `05-` established that workspace plugins
register `before_tool_call` at operator-chosen priorities. A
higher-priority workspace plugin can intercept and rewrite tool
params BEFORE Smarter-Claw's mutation gate sees them. The attack:
malicious `evil-plugin` registers at priority 1000, rewrites
`exec rm -rf /` → `exec ls`, smarter-claw at priority 100 sees
`ls`, allows. Agent runs the rewritten command but believes it ran
`rm -rf /`.

This is acceptable for a single-operator personal install (operator
controls all plugins). It is **NOT obviously acceptable for a public
ClawHub plugin marketed as a security feature** ("mutation gate").
A user installing Smarter-Claw from ClawHub does not control which
other plugins they install; they trust the security label. The label
is misleading by default.

This is the philosophical question: plan-mode's mutation gate is a
SECURITY feature. Security features that depend on plugin-priority
ordering inherit the priority race. In-host implementation runs at
the runtime layer (`src/agents/pi-tools.before-tool-call.ts:280-323`
— `01-:108`), BEFORE any plugin hook fires; this property is lost
in the plugin port and cannot be restored from a workspace plugin.

**Existing coverage**: `05-ADVERSARIAL_AGAINST_C.md` Vector 6
(HIGH) documented the attack. `02-ARCHITECTURE_OPTIONS.md:18`
acknowledges Smarter-Claw cannot use `registerTrustedToolPolicy`
(bundled-only). No artifact addresses the philosophical question:
"is it correct to ship a security feature as a public plugin
that inherits this race?"

**Recommendation**: Two concrete actions:

1. **Documentation gate**: README MUST state plainly: "The
   Smarter-Claw mutation gate runs at default plugin priority. If
   you install additional `before_tool_call` plugins, the gate's
   guarantee weakens. For maximum protection, install Smarter-Claw
   as the only `before_tool_call` plugin, or ensure no other
   plugin registers higher priority." This is honesty about the
   guarantee, not a technical fix.
2. **Long-term path** (post-v1.0, separate work): pursue bundled
   status for `@electricsheephq/smarter-claw` via upstream RFC.
   Bundled plugins can use `registerTrustedToolPolicy`
   (`host-hooks.contract.test.ts:160-191`), which runs BEFORE any
   workspace plugin hook. This is the only path to restoring the
   in-host guarantee.

With both mitigations, this becomes a documented HIGH-trade-off that
operators understand at install time. Without them, it's a HIGH
finding that ships under-disclosed.

---

## Probe 4: Versioning + wire-contract evolution of PlanModeStore namespace

**Severity**: **MEDIUM**

**Finding**: The plugin's `pluginExtensions[smarter-claw][plan-mode]`
shape is a wire contract on two levels:
- **External**: Track B's upstream UI reads
  `SessionEntry.planMode` (Path A's `A.3` decoupling — plugin mirrors
  existing shape). If Smarter-Claw v2.0 changes the shape (renames
  `approval` → `approvalState`, adds a required field), the in-host
  UI that ships in v<X.Y> breaks for users running plugin v2.0 on
  host v<X.Y>.
- **Internal persistence**: sessions on disk have JSONL rows with
  the namespace shape from whatever plugin version was running at
  session creation. v2.0 plugin reading v1.0 session: ?

The architecture documents (`11-`, `14-`) specify the v1.0 shape but
no migration policy. The host preserves `pluginExtensions` across
plugin restart (`13-NEW-2` verified). What it does NOT do is migrate
shape across plugin version upgrades. The plugin's
`session_start` projector reads whatever shape exists; if v2.0 expects
a new required field, the projector returns garbage for v1.0-shape
sessions.

Compare: `01-PARITY_CATALOG.md:1639` mentions PR-15 in-host did a
"nuclear rewrite" of `pendingAgentInjection: string` →
`pendingAgentInjections[]` with "legacy auto-migration" — i.e. the
in-host code has a migration path baked in. The plugin port replicates
the migration for v1.0 (`01-:47` references
`migrateLegacyPendingInjection`), but no policy is documented for
v2.0+ migrations.

**Existing coverage**: None in architecture-v2. `04-LESSONS_LEARNED.md`
discusses port-time legacy migration but not forward versioning.
Track B's wire contract is mentioned in `12-PATH_A_DEEP_DIVE.md` but
versioning is silent.

**Recommendation**: Add a short "Versioning Policy" section to the
eventual README + bake into PR-3 acceptance criteria:

1. **Within v1.x**: namespace shape is additive-only. No required
   fields may be added without a migration helper. No fields may be
   renamed or removed. Stamp each row with `__schemaVersion: 1`.
2. **At v2.0**: bump `__schemaVersion: 2`. Ship a one-shot migration
   helper that runs at `session_start` for v1-stamped rows, rewrites
   to v2 shape, re-stamps. Test: write a v1-shape row, upgrade plugin,
   read row, assert v2 shape + correct migrated values.
3. **Track B contract**: upstream UI reads via `SessionEntry.planMode`
   (host-shape, not plugin-shape). The plugin's PROJECTOR maps from
   `pluginExtensions[smarter-claw][plan-mode]` to `SessionEntry.planMode`.
   The projector is the version-adapter; the plugin can freely evolve
   its internal namespace shape as long as the projector's output
   matches the host's expected `SessionEntry.planMode` schema (defined
   by the host version).

This is a known-limitation-with-policy. Document and proceed.

---

## Probe 5: CI cost + per-PR build environment for parity-harness

**Severity**: **MEDIUM**

**Finding**: The parity-harness Layer 1 (PR-3.5) requires that the
plugin's CI is able to run the IN-HOST reference implementation against
shared inputs. Per `14-PARITY_HARNESS_DESIGN.md` Section "Runners",
`parity-harness/runners/host-reference.ts` imports from
`/Users/lume/repos/openclaw-pr70071-rebase`. In a CI environment that
path doesn't exist; the host must be:

- (a) checked in as a git submodule, OR
- (b) installed as a npm dep with a frozen commit pin (`ea04ea52c7`),
  OR
- (c) checked in as a vendored snapshot under
  `tests/parity/snapshots/`.

Each approach has cost:
- Submodule: ~150MB clone overhead per CI run (the openclaw repo is
  large). Times ~10 PRs/week × 14 PRs in the ladder × 5 runs each =
  ~700 clones. Probably <$20/month at GitHub Actions rates. Tolerable.
- NPM dep: requires publishing the rebase tip as an npm package —
  but it's a fork, not the upstream `openclaw/openclaw` package. You'd
  need to publish `@electricsheephq/openclaw-reference@ea04ea52c7`,
  which is a fork-publishing chore + license-attribution rigor.
- Vendored snapshot: ~50MB of hand-picked files committed under
  `tests/parity/snapshots/`. Easy to drift; CI runs are fast but
  the snapshot itself becomes a maintenance liability.

Layer 2 (gateway-driven integration tests, ~800 LOC at PR-5) is
worse: it spins up a real gateway in CI. Gateway startup is ~10
seconds and the gateway needs config, persistent storage, etc. The
existing `installer-roundtrip.yml` workflow does similar work but is
expected to be slow. Plan-mode parity scenarios at Layer 2 will add
~30 seconds per scenario × 20 scenarios = 10 minutes per CI run.

Cumulative CI cost: roughly 5× the current Smarter-Claw CI runtime
once parity-harness is fully wired. Not blocking, but worth budgeting.

**Existing coverage**: `14-PARITY_HARNESS_DESIGN.md` Section "Open
design questions" raises pin-vs-snapshot as Q1 and Q2 but doesn't
decide. CI cost is not addressed at all. `07b-PR_LADDER_v2.md` doesn't
specify the dependency strategy.

**Recommendation**: Decide BEFORE PR-3.5 ships:

1. **Default to (c) vendored snapshot** under
   `tests/parity/snapshots/openclaw-ea04ea52c7/`. Commit the ~50 files
   the harness actually imports (`store.ts`,
   `pi-embedded-subscribe.handlers.tools.ts`, `plan-snapshot-persister.ts`,
   the test-relevant helpers). Commit a `REFRESH_SNAPSHOT.md` script
   that regenerates the snapshot from a clean rebase checkout.
2. **Layer 2 strategy**: don't spin up a full gateway in CI. Use the
   in-process gateway driver (per `14-:120`) — "Both runners use the
   same in-process gateway harness (no separate processes) so they're
   fast (< 1 sec per scenario)." This is asserted as the design but
   not yet validated. Verify in PR-5 that the in-process driver is
   <1 sec per scenario; if not, downgrade Layer 2 to an opt-in nightly
   run rather than per-PR.
3. **License attribution** for the snapshot: openclaw is MIT.
   Copying ~50 files under `tests/parity/snapshots/openclaw-ea04ea52c7/`
   requires retaining the MIT license header on each file + a top-level
   `NOTICE` file citing upstream. The Smarter-Claw repo's existing
   `LICENSE` file should be checked to ensure compatibility (it
   currently reads "SEE LICENSE IN LICENSE" in `package.json`). If
   Smarter-Claw is also MIT or Apache-2, no issue. If something else
   (e.g., AGPL), MIT-licensed snapshot files must remain under MIT
   (file headers state the original license).

CI cost is manageable, license is manageable, design is clear. Net:
MEDIUM, document and proceed.

---

## Summary

| Severity | Count | Probes |
|---|---|---|
| BLOCKER  | 0 | — |
| HIGH     | 2 | Probe 2 (operator install funnel), Probe 3 (plugin-priority security regression) |
| MEDIUM   | 3 | Probe 1 (cache-bust risk), Probe 4 (versioning policy), Probe 5 (CI/snapshot cost) |
| NONE     | 0 | — |

Both HIGHs have **named mitigations**: Probe 2 → systemMessage on
broken-config + upstream RFC for `registerStartupCheck`; Probe 3 →
README disclosure + long-term bundled-status path. With these
mitigations applied at PR-1 (Probe 2 part 1) and PR-14 (both HIGH
README sections), each HIGH downgrades to MEDIUM at ship time.

The architecture survives all five probes. None reveal a structural
flaw. All are documentation, mitigation, or process additions —
NOT redesigns.

---

## Verdict

**SHIP-READY** at **~95% confidence**.

Eva can lock the architecture-v2 branch tip and begin the plan-mode
submission cycle.

The 2 HIGHs are disclosure/mitigation work, not design flaws. The 3
MEDIUMs are known-limitations-with-policy. The 0 BLOCKERs is the
critical number.

---

## What Eva must do to land (5 steps)

1. **Confirm Path A** (the one explicit unanswered ask from
   `15-CURRENT_STATE_FOR_EVA.md`).
2. **Accept the 2 HIGH mitigations** as PR-1 + PR-14 acceptance
   criteria: systemMessage broken-config warning at PR-1; README
   plugin-priority disclosure at PR-14.
3. **Lock the architecture-v2 branch** with tag
   `architecture-v2-locked-v1` at the current tip (HEAD of this final
   pass). Push the tag. This is the hard revert anchor per `07b-:96`.
4. **Decide snapshot strategy** for the parity-harness: recommend (c)
   vendored snapshot per Probe 5. ~50 files under
   `tests/parity/snapshots/openclaw-ea04ea52c7/`. Document the refresh
   procedure. Add MIT attribution.
5. **Begin PR-1** (plugin skeleton + manifest) per `07b-:56`. PR-1's
   acceptance criteria now includes the Probe-2 systemMessage broken-
   config detection.

---

## Top 3 residual risks (the unknowns we accept by shipping)

1. **Path A upstream-rejection** (~15% per Agent P's estimate). If
   `openclaw` maintainers reject the UI direction on philosophical
   grounds ("UI belongs in the plugin, not in core"), the plugin
   ships with sidebar-only UI and a documented UX gap. Plan-mode
   functions; the inline plan card + revise-textarea require host
   UI. Mitigation: file the RFC issue BEFORE submitting U1, gauge
   reception, pivot to Path C (new SDK seam) if needed —
   `07b-PR_LADDER_v2.md:46-48` already lists this fallback.
2. **Parity-harness Layer 2 performance** is asserted as <1 sec/scenario
   but not validated. If actual performance is 5-10 sec/scenario, CI
   times balloon and developers will skip the harness locally. Risk
   mitigation: budget verification at PR-5; if Layer 2 is slow,
   downgrade to opt-in nightly run rather than per-PR. Acceptable
   degradation.
3. **In-host reference drifts** while plugin is being built. The
   rebase tip `ea04ea52c7` is frozen for our purposes, but upstream
   `openclaw/openclaw` may merge plan-mode-adjacent fixes that the
   plugin needs to absorb. Layer 3 continuous drift detection
   (`14-:128`, PR-14) is designed to catch this, but with a ~quarterly
   cadence. A high-priority drift between cadences could ship as a
   parity bug. Mitigation: subscribe to in-host `plan-mode/` directory
   in GitHub watch list; manual review on any commit touching those
   files.

---

## Confidence justification

I am at 95% — not higher — because:
- 5 probe vectors NEW to this pass, all addressed in the architecture
  or by clearly-named follow-ups.
- 2 prior adversarial passes (`05-` and `13-`) covered 18 distinct
  attack vectors. Including this pass, 23 vectors examined.
- 0 BLOCKERs remain. The 2 HIGHs have concrete mitigation that lands
  in PR-1 and PR-14 (the natural attention points: first PR and
  release PR).
- Eva's "≥95% gate" was set without the parity-harness; with it,
  mechanical parity replaces hopeful parity. The harness's existence
  is the difference between 90% and 95%.

The 5% gap is:
- ~2%: Path A maintainer reception (real unknown).
- ~2%: Layer 2 performance assumption (testable but not yet tested).
- ~1%: long-tail integration bugs that ~23 vectors don't cover.

Recommend Eva LOCKS and SHIPS to PR-1.

---

## Files / lines referenced

- `11-AMENDMENT_REVISIONS.md` (in full).
- `14-PARITY_HARNESS_DESIGN.md` (in full).
- `15-CURRENT_STATE_FOR_EVA.md` (in full).
- `16-MEDIUM_MITIGATIONS.md` (in full).
- `07b-PR_LADDER_v2.md` (in full).
- `01-PARITY_CATALOG.md:51, 47, 1639` (debug-log + injections + tiebreaker).
- `05-ADVERSARIAL_AGAINST_C.md` Vector 6 (priority race).
- `13-PRE_LOCK_ADVERSARIAL.md` NEW-2, NEW-10 (restart + install UX).
- `/Users/lume/repos/openclaw-pr70071-rebase/package.json` (MIT).
- `/Users/lume/repos/Smarter-Claw/package.json:license` ("SEE LICENSE IN LICENSE").
- `/Users/lume/repos/Smarter-Claw/openclaw.plugin.json` (existing
  manifest, `configSchema` does not yet declare `allowConversationAccess`
  warning).
- `/Users/lume/repos/Smarter-Claw/.github/workflows/{ci,installer-roundtrip}.yml`
  (existing CI scaffolding to extend).
