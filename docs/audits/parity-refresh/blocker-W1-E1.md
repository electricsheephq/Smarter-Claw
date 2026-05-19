# Blocker — W1-E1 (S6 turn-limit watchdog deferral)

**Status:** **defer remains correct.** The slice-audit's claim that the
deferral is "stale because the SDK seam now ships" rests on a misread
of `registerSessionSchedulerJob`. There is no SDK seam, no in-host
reference behavior to port, and no live loop in the current plugin
that needs bounding. The honest fix is to **re-state the deferral on a
current rationale** (this doc), not to invent a watchdog against a
non-existent contract.

**Issue:** W1-E1 (`wave-1-catalog.md` row + `slice-audit-E-runtime.md` § E-1).

**Decision date:** 2026-05-20.

**Investigator:** parity-refresh W1-E1 worker (read-only against in-host
`/Volumes/LEXAR/repos/openclaw-pr70071-rebase` tip `ea04ea52c7`;
plugin against `main` commit at investigation time; SDK
`openclaw@2026.5.18` per `package.json`).

## Audit's claim, restated

`slice-audit-E-runtime.md` § E-1 (and `wave-1-catalog.md` row W1-E1)
asserted three premises:

1. The S6 turn-limit watchdog was deferred specifically because
   `registerSessionSchedulerJob` did not exist; that condition has
   now expired on SDK `2026.5.18`.
2. The watchdog prevents an "unbounded auto-mode-rejection loop" that
   is "exactly the scenario Smarter-Claw markets" (`autoApprove: true`
   + repeated rejections).
3. The in-host plan-mode runtime enforces a per-session turn limit
   (per `S6-S13-S14-foundation.md:163`: *"lives in the runner —
   `pi-embedded-runner/run/attempt.ts` increments a turn counter on
   every model-output processing pass"*).

All three premises do not hold on close inspection. Detail below.

## (1) The SDK seam is not what the audit thought it was

`node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts:1974-1992`
defines `OpenClawPluginSessionWorkflowApi.registerSessionSchedulerJob`.
The JSDoc is unambiguous (lines 1977-1981):

> **"Register cleanup metadata for a plugin-owned session scheduler job.
> This does not schedule work or create task records; it only lets the
> host clean external scheduler state during reset/delete/disable."**

The corresponding type
(`host-hooks.d.ts:151-167`) is a registration record with `id`,
`sessionKey`, `kind`, `description?`, and a `cleanup?` callback. There
is **no fire / tick / trigger primitive**. Confirmed by the bundled JS
implementation
(`node_modules/openclaw/dist/loader-CxUWY2_6.js:3478-3525`): the
function pushes the record into `registry.sessionSchedulerJobs` and
returns a handle. It does not run timers or callbacks except on host
cleanup events.

The actual scheduling primitive in the SDK is
`OpenClawPluginSessionWorkflowApi.scheduleSessionTurn`
(`types.d.ts:1985-1989`) — but that schedules a *future agent turn*
("Schedule a future agent turn in a session through Cron. Cron owns
timing and creates the task ledger entry when the turn runs.") via
cron expressions, with a delivered message. It is appropriate for
time-driven flows (a daily check-in, a delayed nudge); it is not a
counter-based watchdog primitive either.

**The watchdog the audit describes is event-driven** (count consecutive
auto-rejections, fire on N). Neither of the two SDK seams supports
that. There is no plugin-owned event scheduler / debounce / counter
primitive in `2026.5.18`. Re-confirming:

- `OpenClawPluginSessionWorkflowApi` — surveyed lines 1974-1992.
  Surface: `enqueueNextTurnInjection`, `registerSessionSchedulerJob`
  (cleanup-only), `sendSessionAttachment`, `scheduleSessionTurn`
  (cron-only), `unscheduleSessionTurnsByTag`.
- `OpenClawPluginAgentEventsApi` — `registerAgentEventSubscription`,
  `emitAgentEvent`. Sub-only; no scheduling.
- No seam advertises a "session-state observer with threshold callback"
  or equivalent.

The audit cited the seam-availability change from the Wave-0 AUDIT-E
re-execution. The Wave-0 doc correctly reports that
`registerSessionSchedulerJob` is on the public API (`api-builder.d.ts:17`
exports it on `OpenClawPluginApi.session.workflow`). That is true —
the seam is *exposed*. The audit then inferred that *exposed seam =
watchdog-implementable*. The JSDoc rules that inference out.

## (2) There is no auto-rejection loop currently in the plugin

The audit invokes the marketed `autoApprove` use case
(`slice-audit-E-runtime.md:75-76`). But the catalog itself (W1-F4)
documents that `autoApprove` is **unwired**: *"`/plan auto on` flips
an `autoApprove` flag that does nothing — the runtime that fires
auto-approve 'lands at P-final'."*

Confirmed in the plugin source:

- `src/state/store.ts:646-735` — `setAutoApprove` writes the flag.
- `src/types.ts:212` — `autoApprove?: boolean` declared.
- `src/index.ts:378-395` — the flag is read in `before_tool_call`
  but only carried alongside `mode`/`approval`; line 451 makes the
  acceptEdits-gate predicate `approval === "edited"`, intentionally
  decoupled from `autoApprove`. Comment at lines 437-446 spells out
  that the plugin does NOT trigger anything on `autoApprove`.
- `src/tools/exit-plan-mode.ts` — no `autoApprove` read; submission
  is never auto-resolved to `approve`.

There is no caller that takes `autoApprove === true` and converts a
pending approval into an `approve` action. So the *loop* the
watchdog is meant to bound (auto-approve resolution loop) **does not
exist in the current plugin.** Wave-1 W1-F4 is the parent fix; once
auto-approve is wired, the loop becomes possible — at which point this
finding can be revisited *with context on the wired mechanism*.

User-driven rejections (the user clicking Reject many times) are
already mitigated by the in-host deescalation hint that ships in the
plugin: `src/prompt/plan-decision-injection.ts:62-66` adds a
"Consider asking the user to clarify their goal" instruction once
`rejectionCount >= 3`. The `S6-S13-S14-foundation.md` section 4.3
analysis explicitly says this is the soft mitigation that makes the
watchdog deferral acceptable; it is in place.

## (3) The in-host does not have a plan-mode turn-limit watchdog

`S6-S13-S14-foundation.md:163` claims the in-host *"lives in the
runner — `pi-embedded-runner/run/attempt.ts` increments a turn counter
on every model-output processing pass and triggers an auto-exit when
the threshold is reached"*. Verified read-only against
`/Volumes/LEXAR/repos/openclaw-pr70071-rebase` tip `ea04ea52c7`:

- `src/agents/pi-embedded-runner/run/attempt.ts` — `grep -n
  "planMode\|plan_mode\|planTurn\|turnCount\|consecutive"`: matches
  only at line 522 ("consecutive unknown-tool attempts", an unrelated
  stream-wrapper rewrite) and line 3085 (typo guard). **No plan-mode
  turn counter.**
- `src/agents/pi-embedded-runner/` (whole directory): `grep -rn
  "rejectionCount\|consecutivePlan\|maxConsecutive"` returns no
  matches.
- `src/agents/pi-embedded-runner/run.ts:897` — `MAX_RUN_LOOP_ITERATIONS
  = resolveMaxRunRetryIterations(profileCandidates.length)`. This IS
  an outer loop guard at the runner level (`run/helpers.ts:74-79`:
  `BASE_RUN_RETRY_ITERATIONS = 24`, max 160). But it counts **all**
  retry causes (model errors, overload rotations, compaction
  retries) — it is not plan-mode-aware. The trip path
  (`run.ts:1149-1183`) returns a generic "Exceeded retry limit" error,
  not an `exitPlanMode` call.
- Whole `src/` directory: `grep -rn "exitPlanMode" --include="*.ts"`
  returns 0 matches. The in-host has no programmatic exit-plan-mode
  affordance at all — exits happen only through user-initiated tool
  calls (`exit_plan_mode`) or the approval state machine.
- `src/agents/plan-mode/` directory: does not exist. Plan-mode logic
  in the in-host lives at `src/agents/plan-mode/` per file
  references in other audits, but the directory on the inspected tip
  appears under a different name (the inspected branch is the rebase
  worktree, which may have moved files since the audit). I confirmed
  the in-host has **no `rejectionCount` field anywhere in `src/`** —
  that field is a plugin invention (`src/types.ts:139` plugin-side,
  zero matches in-host).

The S6 foundation-audit's `host_ref` for a watchdog is unsourced.
There is no in-host implementation to port. Building one ourselves
without a parity reference would re-introduce the "port not done
correctly" pattern this whole effort exists to root out.

## Design questions that remain open (un-decidable without a contract)

If we wanted to ship a watchdog anyway as a plugin-invented safety
net, every one of these is a guess:

1. **What is a "turn"?** A `before_agent_finalize` event? A
   `before_tool_call`? A `recordRejection` call? An
   `enqueueNextTurnInjection`? Each measures a different surface.
2. **What threshold?** The audit suggests "~25". The deescalation hint
   already fires at 3. A watchdog at 25 is so high it would not catch
   the marketed "tight loop" scenario; at 5 it would fight the
   existing deescalation hint.
3. **What action on hit?** Auto-exit plan mode (`store.exitPlanMode`)?
   Disable auto-approve (`store.setAutoApprove({enabled: false})`)?
   Both? Emit a `[PLAN_MODE_AUTO_EXIT]` synthetic injection? Each is
   plausible; none is in-host-cited.
4. **Reset rules.** Does `enterPlanMode` reset the counter (probably)?
   Does `recordApproval`/`recordEdit` (already resets `rejectionCount`
   per `src/plan-mode/approval.ts:118,130`)? Does cancel? Does a
   manual `exitPlanMode`?
5. **Persistence.** Is the counter on the session-state extension
   (persistent across host restart) or in-memory (cheap, lost on
   restart)?

Without an in-host implementation to anchor on, every answer is a
plugin invention. The Wave-1 effort's first guardrail is "no `host_ref:
TBD` anywhere"; a plugin-invented watchdog would either need a
`host_ref:` of `n/a (plugin-invented)` — which is acceptable per the
catalog's `plan-tier-model.ts` precedent — but would still need a
*design contract* the audit can validate. That contract doesn't exist
yet.

## Smallest implementable subset that delivers real value

The S6 foundation audit Section 4.4 enumerates four "gap tests to add
even without watchdog implementation". On inspection:

- **D-G1** (rejectionCount monotonic increment): **already covered**
  by `tests/state/store.test.ts:566-572`.
- **D-G2** (no wrap/cap of rejectionCount): **already covered**
  by `tests/state/store.test.ts:575-593` (cross-cycle increment).
- **D-G3** (audit emitter receives rejectionCount): **already covered**
  by `tests/ui/session-actions.test.ts:405-423` (rejection injection
  emits with rejectionCount metadata).
- **D-G4** (code comment noting deferral with link to in-host): not
  yet present; the actionable carryover.

D-G4 is the genuinely-implementable subset: a comment in
`src/types.ts` (where `rejectionCount` lives) and/or
`src/state/store.ts` (where `recordRejection` lives) noting that the
field exists *in case* a watchdog is wired later and explicitly
linking this blocker doc. No behavior change; pure documentation.

## Recommendation

**Defer-to-issue, blocked on prerequisites.**

The watchdog is not implementable today as the audit framed it. It
becomes implementable when **both** of:

1. **W1-F4 (auto-approve wiring) ships.** Until auto-approve actually
   resolves submissions, there is no loop to bound; the watchdog is
   theatre.
2. **An in-host implementation lands to anchor on.** Either the
   in-host adds a plan-mode turn-limit watchdog (the audit's S6
   section 4 says this is on the in-host roadmap implicitly), or the
   project explicitly accepts a plugin-invented watchdog with a
   design-doc round before code (the `first-principles-architectural-
   decision` skill is the right vehicle for that round).

Until both ship, the W1-E1 catalog row should be **downgraded from P1
to P3 (informational)** with the rationale updated to point at this
doc — replacing "the seam now exists, the deferral is stale" with
"the seam was misread; the loop being watchdogged does not yet exist
in the plugin; deferral remains correct on the merits."

### What this PR ships

Pure documentation. No source changes beyond:

- This blocker doc.
- A short comment in `src/types.ts` near `rejectionCount` linking to
  this doc (D-G4 from the S6 foundation audit).

### Tracking

- W1-E1 row in `wave-1-catalog.md`: needs severity + rationale update
  pointing here.
- `EXECUTION-STATUS.md` "Remaining Wave-3 findings" table: move from
  "investigation" to "deferred" with link to this doc.
- W1-F4 (`/plan auto` dead toggle): real precondition; finishing that
  reopens this finding with new context.

## Lessons

- "The seam now exists" is a *necessary* condition for resolving a
  seam-blocked deferral, not a sufficient one. Re-read the JSDoc.
  Public-API exposure on a `d.ts` file does not equal runtime
  behavior.
- Audit findings can themselves drift: this finding rests on a
  premise (`pi-embedded-runner/run/attempt.ts` increments a per-turn
  counter) that was unsourced in the foundation audit and is not
  present in the inspected in-host tip. Wave-1 was lossy on
  `host_ref:` discipline for this row.
- "Marketed use case" arguments need a *current* state check. The
  marketing assumes a feature (`autoApprove` actually self-executing)
  that is unwired today. Build the feature first, then bound it.
