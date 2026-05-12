# 13 — Pre-Lock Adversarial Review (Wave 4)

**Status**: pre-emptive sweep on the architecture after Wave 3 (Option C +
10-invariant typed mutator + Path A UI). Eva's bar ≥95%. Wave 3 = 80%. This
pass probes 10 NEW vectors the Wave 2 adversarial agent missed.

**Inputs read**: docs 01, 02, 05, 08, 11 in `architecture-v2/`; in `openclaw-1/`:
`src/plugins/contracts/host-hooks.contract.test.ts`,
`src/plugins/host-hooks.ts`, `docs/plugins/hooks.md`,
`docs/plugins/sdk-setup.md`,
`src/plugins/contracts/scheduled-turns.contract.test.ts`; in `openclaw-pr70071-rebase/src/agents/`:
`plan-hydration.ts`, `subagent-announce.ts`,
`tools/sessions-spawn-tool.ts`, `tools/exit-plan-mode-tool.ts`.

---

## Vector NEW-1: Session-extension namespace ownership conflicts

**Severity**: **NONE**.

The host scopes session-extension state by **`(pluginId, namespace)` tuple**,
not by `namespace` alone. Evidence:

- `host-hooks.contract.test.ts:996-1006` registers two plugins
  (`throwing-projector-fixture` + `healthy-projector-fixture`) BOTH with
  `namespace: "workflow"`. They coexist with no diagnostic; each owns its
  own slice under `entry.pluginExtensions[pluginId]["workflow"]`.
- `host-hooks.contract.test.ts:2414-2466` exercises plugin-host cleanup with
  TWO plugins (`"cleanup-fixture"` + `"other-plugin"`) writing the same
  `namespace: "workflow"`. After `runPluginHostCleanup({pluginId:
  "cleanup-fixture", reason: "disable"})`, the test asserts
  `pluginExtensions["other-plugin"]` survives untouched
  (line 2453). Per-plugin isolation is the host contract.
- `session-entry-projection.contract.test.ts:39-41` reads state via
  `entry.pluginExtensions[pluginId][namespace]` — pluginId is the outer key.

A different plugin claiming `namespace: "plan-mode"` would live at
`pluginExtensions["other-plugin"]["plan-mode"]`, structurally disjoint from
Smarter-Claw's `pluginExtensions["smarter-claw"]["plan-mode"]`. The host's
diagnostic at registration only rejects duplicate IDs **within one plugin**
(`host-hooks.contract.test.ts:847-916`: "runtime lifecycle already
registered", "session scheduler job cleanup must be a function").

**Existing doc coverage**: `02-` Section 6 should add one sentence:
*"Namespace key is the `(pluginId, namespace)` tuple — namespace strings do not collide across plugins."*

---

## Vector NEW-2: Plugin restart mid-approval

**Severity**: **NONE**.

The host contract explicitly preserves `pluginExtensions` + pending
`pluginNextTurnInjections` across `cleanup({reason: "restart"})`. Evidence:

- `hooks.md:340-346`: *"The host removes the owning plugin's persistent
  session extension state and pending next-turn injections for
  reset/delete/disable; **restart keeps durable session state** while cleanup
  callbacks let plugins release scheduler jobs, run context, and other
  out-of-band resources for the old runtime generation."*
- `host-hooks.contract.test.ts:2537-2622` — *"preserves durable plugin
  session state during plugin restart cleanup"*: writes
  `pluginExtensions["restart-state-fixture"]` + a pending injection, calls
  `runPluginHostCleanup({reason: "restart"})`, asserts both are preserved
  byte-for-byte (lines 2598-2611).
- `host-hooks.contract.test.ts:2137-2195` — schedulerJobs of the SAME id +
  sessionKey + kind survive a registry-replace (restart), no cleanup fires,
  the old handle is preserved as the new generation's. Plan-mode nudge
  jobs survive plugin restart by design.

A plan-approval-pending session that hits a plugin restart re-loads with
`approval: "pending"` + `approvalId` + `lastPlanSteps` intact. Projector
runs sync at registry-restore. Approval completes normally.

**Existing doc coverage**: add to `02-` typed-mutator section: *"restart
preserves the durable bag; `cleanup(reason)` is a no-op for `restart`."*

---

## Vector NEW-3: Concurrent plan-mode in subagents

**Severity**: **MEDIUM** (documentation gap — behavior is consistent, the
catalog needs an explicit subagent semantics line).

In-host behavior: subagents do **NOT** enter plan-mode independently. They
are tracked as **concurrent work the parent gates against**, via
`openSubagentRunIds`/`blockingSubagentRunIds` in the PARENT's `planMode`
state. Evidence:

- `subagent-announce.ts:527` reads the **requester** (parent) entry's
  `planMode?.mode`, not the subagent's. Plan-mode is a parent-session
  property; subagents are blocking children.
- `tools/exit-plan-mode-tool.ts:5` imports
  `SUBAGENT_SETTLE_GRACE_MS` from `plan-mode/index.ts` — the parent's
  exit-plan-mode tool gates on subagent settle, not subagent plan state.
- `tools/sessions-spawn-tool.ts:7` imports
  `MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE` — parent-side spawn rate-limit
  during plan mode.
- `01-PARITY_CATALOG.md:1086, 1094` (F3 + F11) — `blockingSubagentRunIds`
  + `recentlyApprovedAt` + `lastSubagentSettledAt` are PARENT state.
- `06-DIAGRAMS.md:380` (Bug 6) — the subagent gate is the host's
  `sessions.patch` checking parent state; the plugin port routes
  through `actions/handlers.ts` + `lifecycle/grant-ledger.ts`.

Vector NEW-3 dissolves: no per-subagent plan-mode to track. **However** —
the parity catalog F11 lacks a crisp negative-space sentence. A new
contributor could wrongly project the namespace onto child sessionKeys,
doubling state and breaking the gate.

**Mitigation**: add a one-line invariant to `01-PARITY_CATALOG.md` F11:
*"plan-mode state is owned by the PARENT sessionKey only. Subagents are
tracked as opaque blocking children via `openSubagentRunIds`; subagent
sessions do not have their own `planMode` row."* This prevents the trap
during port.

**Existing doc coverage**: `06-DIAGRAMS.md:380` covers the gate. Missing
the negative-space sentence.

---

## Vector NEW-4: Compaction interaction

**Severity**: **NONE**.

Compaction modifies the prompt/transcript pipeline, NOT the session row.
`pluginExtensions` is opaque to the compaction surface. Evidence:

- `hooks.md:135-138`: `session_start` reason includes `"compaction"` — a
  lifecycle marker, not a row mutation. `before_compaction`/`after_compaction`
  are observability hooks; no SDK API mutates `pluginExtensions` during
  compaction.
- `plan-hydration.ts:1-71` — the in-host hydration is a SEPARATE module
  that injects surviving plan steps into the next prompt. It reads
  `lastPlanSteps` (intact post-compaction) and produces an injection
  string. Plugin port replicates via `after_compaction` +
  `api.enqueueNextTurnInjection({content: formatPlanForHydration(...)})`.

State survives compaction in `pluginExtensions["smarter-claw"]["plan-mode"]`
because the compaction pipeline doesn't touch the row.

**Existing doc coverage**: `02-` should add: *"Compaction does not mutate
`pluginExtensions`. Post-compaction hydration uses `after_compaction` +
`enqueueNextTurnInjection`."*

---

## Vector NEW-5: Cron + plan-mode-nudge gap

**Severity**: **NONE** (cleaner than the diagrams suggested).

`06-DIAGRAMS.md:396` flagged "the SDK has no first-class cron seam" — this
is **incorrect**. Evidence:

- `scheduled-turns.contract.test.ts:113-149` — the SDK exposes
  `schedulePluginSessionTurn({pluginId, sessionKey, schedule, payload,
  delivery, ...})` which routes through host's Cron service. Schedule
  shapes include `{kind: "at", at: <iso-timestamp>}` (and presumably
  recurring shapes; the test uses `"at"`). The 10/30/60-min nudge cadence
  maps directly: enqueue three `kind: "at"` jobs with descending
  timestamps tagged `nudge:T+10`, `nudge:T+30`, `nudge:T+60`.
- `host-hooks.ts` — `PluginSessionSchedulerJobRegistration.kind: string`
  is a free-form label (no closed enum). The plugin can use
  `kind: "plan-mode-nudge"` freely; the host doesn't gate by kind.
- Restart-survival: scheduler jobs of matching `(pluginId, id,
  sessionKey, kind)` survive registry-replace
  (`host-hooks.contract.test.ts:2137-2195`).

`08-DECISION_DRAFT.md:110` (H5) already flags this as resolved-with-caveat;
Wave 4 confirms `schedulePluginSessionTurn` (not the lower-level
`registerSessionSchedulerJob`) is the correct seam for cron-style nudge
delivery. The plugin should NOT use `setInterval` — it should use
`schedulePluginSessionTurn` so nudges survive gateway restart, which is
in-host's behavior.

**Mitigation**: revise `06-DIAGRAMS.md:396` to read *"SDK seam is
`schedulePluginSessionTurn` (cron-backed, durable); update `lifecycle/`
to use this rather than `setInterval`."* Wire this into PR-2 acceptance
criteria. No new blocker.

---

## Vector NEW-6: Typed mutator parity at CI

**Severity**: **HIGH** (this is the strongest finding in this pass).

`11-AMENDMENT_REVISIONS.md:62-74` correctly identifies that
`persistPlanApprovalRequest` has ZERO direct unit tests in the in-host
tree. The plugin's PR-3 will add `PlanModeStore.persistApprovalRequest`
unit tests covering the 10 invariants. **But the plugin's tests assert
plugin BEHAVIOR — they do not certify the behavior matches in-host 1:1.**
The risk:

- Wave 3 Agent N enumerated 10 invariants by reading code carefully. If
  Agent N missed an 11th invariant (or a subtle precondition inside one
  of the 10), the plugin's tests pass with the same blind spot.
- Eva's live-smoke gate (PR-5) is the only place this fails — and live
  smoke catches *symptoms*, not invariant gaps. A subtle bug like
  "off-by-one cycle count when reject-then-approve-with-different-hash"
  passes smoke and lands.

The right gate is a **contract test that runs against the in-host
`persistPlanApprovalRequest` reference AS WELL AS the plugin's
`PlanModeStore.persistApprovalRequest`**, asserting identical results
across a shared input table (25-50 tuples covering all 10 invariants +
4 result kinds + idempotency edges). This requires `openclaw-pr70071-rebase`
as a peer dep / git submodule / frozen `tests/parity/snapshots/` copy.
It's the only mechanical way to certify spec-parity.

**Mitigation**: amend `11-` to require a parity-test acceptance criterion
in PR-3: parity table covers 4 result kinds + 10 invariants +
cross-checked against `openclaw-pr70071-rebase` as a dev dependency or
frozen snapshot. `11-` Section "Critical test-coverage gap" says
"add direct unit tests" — needs to become "add parity tests" with the
reference impl as a peer.

---

## Vector NEW-7: Path A host-version-pin

**Severity**: **NONE** (Path A's promise is supported by SDK contracts).

The plugin manifest supports `openclaw.install.minHostVersion` (per
`sdk-setup.md:81, 163`). Behavior:

- **Install-time enforcement** (`sdk-setup.md:171-173`): *"If
  `minHostVersion` is set, install and non-bundled manifest-registry
  loading both enforce it. Older hosts skip external plugins; invalid
  version strings are rejected."* An operator on an older host gets a
  rejected install — no silent "installed but UI missing" state.
- **Manifest-registry enforcement**: even if the plugin tarball is
  hand-copied past the install check, the runtime manifest-registry
  loader re-enforces `minHostVersion` and skips the plugin at gateway
  start.
- **Semver floor format** (`manifest.md:1171`): `>=2026.X.Y` or
  `>=2026.X.Y-prerelease`.

`02-ARCHITECTURE_OPTIONS.md` and `08-DECISION_DRAFT.md` don't currently
specify the pin string. **Action**: when Path A's first UI sub-PR lands
upstream, capture the published host version and pin `minHostVersion:
">=<that-version>"` in `openclaw.plugin.json`. This is a PR-1 acceptance
item.

**No runtime API needed**: `api.requireHostVersion()` does NOT exist
(checked); manifest-declarative + install-time enforcement is sufficient.
Add to `08-` Risks Accepted: *"Plugin pins `minHostVersion` once Path A
UI sub-PRs land; older-host install fails with host's standard
rejection."*

---

## Vector NEW-8: Test parity vs spec parity

**Severity**: **HIGH** — closely related to NEW-6, but distinct.

The parity catalog has 875 tests. ~70% port verbatim (per Agent O), ~30%
are host-internal. The plugin's test suite tests the SPEC, not the
in-host behavior. Bug class this introduces:

- The in-host code has 2 years of accreted defensive checks the catalog
  doesn't enumerate (e.g., a precondition in `sessions-patch.ts:1135-1189`
  about `lastPlanSteps` materialization status-enum normalization that
  the catalog mentions but does not enumerate exhaustively).
- The plugin port re-encodes what the catalog SAYS, not what the code
  DOES. A behavior described in 2024 that drifted in 2025 — and the
  catalog wasn't updated — ships as a divergence.

This is `LESSONS_LEARNED.A1` re-emerging in new form: the catalog is a
secondary source. The primary source is the code.

**Mitigation** (gates spec drift):

1. **Snapshot the in-host code at the rebase tip** as part of PR-1
   (`scripts/freeze-in-host-snapshot.ts` copies relevant in-host files
   to `tests/parity/snapshots/`). The plugin's parity tests
   (NEW-6) run against this frozen snapshot. CI flags any drift.
2. **Add a `pnpm parity:audit` script** that walks each parity-catalog
   line item and runs grep against the in-host snapshot, asserting the
   referenced behavior signatures match the catalog's claim
   (e.g., catalog says "F3 at sessions-patch.ts:813-952", audit
   runs `grep "function applySessionsPatchToStore"` and reports if
   missing).
3. **Quarterly audit refresh**: re-snapshot from upstream and re-run
   parity tests. Any drift becomes a tracked issue.

**Combined with NEW-6**: vectors 6 + 8 are the strongest finding in
Wave 4. Both demand parity-test infrastructure not yet in the design.
`04-LESSONS_LEARNED.md` and `08-` H2 acknowledge drift but propose no
guardrail.

---

## Vector NEW-9: Failure rollback strategy

**Severity**: **MEDIUM**.

`08-DECISION_DRAFT.md:155-157` says: *"PR-1..3 (foundation): reverts
cleanly. Returns repo to bare scaffolding. PR-4 onward: each PR is
reverts-clean individually."* Good — but this is the *git revert* story.

The PR-5 Eva-live-smoke gate is the first place architecture-level
failures surface. If at PR-5 we discover (say) the typed-mutator pattern
is structurally insufficient (e.g., `withSessionStoreLock` semantics
don't translate to the plugin's `sessions.pluginPatch` route), the cost
to roll back is:

- 5 PRs of code (≥2500 LOC by ladder estimate).
- 5 PRs of accumulated reviewer trust.
- All downstream PRs (6-14) are blocked behind the same failure.

The decision draft doesn't enumerate **what specifically would trigger a
rollback**. A clear stop-conditions list:

1. **Race-fix invariant fails Eva smoke**: typed mutator produces
   different result than in-host on a parity-table input. Rollback ⇒
   revisit Option D (in-host runtime + workspace plugin split).
2. **Compaction interaction fails**: plan-mode state corrupts after a
   compaction cycle in live use. Rollback ⇒ defer the plugin port
   pending an SDK-level compaction-state seam.
3. **Subagent gate fails-open**: a workspace plugin can re-flip
   `planMode` via `sessions.pluginPatch` without going through the
   gate. Rollback ⇒ require a `before_session_action` hook (file
   upstream issue).

Without explicit stop-conditions, rollback is judgment-call territory.
That's where prior failures escalated past the right inflection point.

**Mitigation**: add §"Stop-conditions for rollback" to `07-PR_LADDER.md`
enumerating 3-5 concrete failure signatures. Each Eva-live-smoke PR's
checklist includes `[ ] no stop-condition triggered`.

---

## Vector NEW-10: Operator install UX for `allowConversationAccess`

**Severity**: **MEDIUM** (already flagged as adversarial Vec 4
MEDIUM in `05-`; this pass re-evaluates whether Wave 3 mitigations
land).

`05-ADVERSARIAL_AGAINST_C.md` Vec 4 already covered this; the resolved
mitigation in `08-DECISION_DRAFT.md` H3 says "operator config requirement;
startup banner warning if a competing policy is detected; long-term
consider getting 'trusted' exemption."

Wave 4 finding: the SDK has **no `registerStartupCheck` /
`registerDiagnostic`** capability (grep confirms). The "loud startup
banner" the H3 mitigation promises is limited to:

- `logger.warn` from `register(api)` — fires once at gateway start, easy
  to miss in noisy logs.
- README + ClawHub listing banner.
- `openclaw plugins inspect smarter-claw` will show the policy field
  (per `plugins/status.ts:519`) — operator-driven check.

ClawHub install flow does NOT auto-flip `allowConversationAccess: true`
(install metadata per `sdk-setup.md:166-191` has no config-flag side
effect). So operator UX is: install → hooks silently no-op → file bug.
This is `LESSONS_LEARNED.B1` (schema-accepted no-op knobs).

**Mitigation**:

1. README + ClawHub listing prominent first paragraph documenting the
   config requirement.
2. `register(api)` reads its policy via `api.config.get` (if exists) and
   `logger.error` at init time when `allowConversationAccess !== true`.
3. Document `openclaw plugins inspect smarter-claw` as the
   verification step.

Not a blocker — matches the H3 trade-off already accepted in `08-`.

---

## Summary

| Severity | Count | Vectors |
|----------|-------|---------|
| BLOCKER  | 0     | — |
| HIGH     | 2     | NEW-6 (parity tests), NEW-8 (spec-drift gates) |
| MEDIUM   | 3     | NEW-3 (subagent doc gap), NEW-9 (rollback stop-conditions), NEW-10 (operator install UX) |
| NONE     | 5     | NEW-1, NEW-2, NEW-4, NEW-5, NEW-7 |

## Verdict

**If all HIGHs and MEDIUMs are addressed: ~95% confidence.**

The architecture is structurally sound. Path A is feasible (NEW-7),
plugin restart preserves state (NEW-2), namespace ownership is per-plugin
(NEW-1), compaction does not touch state (NEW-4), cron-backed scheduling
exists (NEW-5). The remaining work is **discipline**, not redesign:

- The 10-invariant typed mutator needs a **parity-test harness** against
  the in-host reference implementation, not just unit tests on the
  plugin behavior. (NEW-6).
- The 875-test corpus needs a **spec-vs-code drift guardrail** so the
  plugin doesn't ship a stale read of the catalog. (NEW-8).
- Three documentation gaps (subagent invariant, rollback stop-conditions,
  operator install UX) should be closed before PR-1 lands.

The 80% → 95% jump is reachable in 1-2 days of doc + scaffolding work,
not a new architecture pass.

## Top 3 actions to reach 95%

1. **Add a parity-test harness to PR-3** (resolves NEW-6 + NEW-8). Pin
   `openclaw-pr70071-rebase` as a dev dependency or vendor a frozen
   snapshot under `tests/parity/snapshots/`. The harness runs both the
   in-host `persistPlanApprovalRequest` and the plugin
   `PlanModeStore.persistApprovalRequest` over a 25-50 entry parity
   table covering all 4 result kinds + 10 invariants + idempotency
   edges. CI fails on any divergence.
2. **Add a §"Stop-conditions for rollback" to `07-PR_LADDER.md`**
   (resolves NEW-9). Enumerate 3-5 concrete failure signatures that
   trigger architectural escalation at each Eva-live-smoke gate.
3. **Tighten 3 doc gaps** (resolves NEW-1, NEW-3, NEW-4, NEW-10): one-line
   additions to `01-PARITY_CATALOG.md` (subagent-plan-mode negative
   space), `02-ARCHITECTURE_OPTIONS.md` (per-pluginId namespace
   scoping + compaction non-interaction), `08-DECISION_DRAFT.md`
   (operator install UX explicit acceptance + `minHostVersion` pin
   commitment). Each addition <2 sentences.

---

## Files / lines referenced

- `host-hooks.contract.test.ts:996-1006, 2137-2195, 2414-2466, 2537-2622` —
  namespace + restart + cleanup semantics.
- `scheduled-turns.contract.test.ts:113, 147, 223-249` —
  `schedulePluginSessionTurn` cron seam.
- `host-hooks.ts` — `PluginSessionSchedulerJobRegistration.kind: string`.
- `hooks.md:135-138, 304-321, 340-346` — compaction marker,
  `allowConversationAccess`, cleanup semantics.
- `sdk-setup.md:81, 163, 171-173`, `manifest.md:1171, 1181` —
  `minHostVersion` field + enforcement + semver-floor.
- `plan-hydration.ts:1-71` — after-compaction plan injection.
- `subagent-announce.ts:527` — parent's planMode read.
- `tools/exit-plan-mode-tool.ts:5` — parent-side subagent gate.
- Architecture-v2 artifacts: `01, 02, 05, 06, 08, 11`.
