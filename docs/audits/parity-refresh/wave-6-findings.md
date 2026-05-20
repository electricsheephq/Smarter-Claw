# Wave 6 — Final Adversarial Findings

**Date**: 2026-05-20
**Auditor**: Wave-6 adversarial pass (read-only against post-Wave-5 working tree)
**Method**: re-scan the wave-1 audit categories now that Wave-3 fixes have
landed, looking SPECIFICALLY for things that were NOT in the original 19,
or things the Wave-3 fixes weakened. Verification battery (typecheck +
parity-harness + 868 unit tests) re-ran clean before this pass.

This is the "find what the audit + fix waves missed" pass. **None of the
findings here are P0**; the codebase is release-ready. They are tracked
for the next maintenance cycle and as honest documentation of the residual
silent-drift surface area the parity-harness does not pin.

---

## Headline

| Severity | Count | Verdict |
|---|---|---|
| P0 | 0 | nothing ships broken |
| P1 | 2 | doc-vs-reality drift; potential regression-detection gap |
| P2 | 5 | refinements; mostly known-latent surfaces |
| P3 | 0 | — |

Wave-6 found **0 new P0 correctness or security issues**. The plugin's
state machine, gates, prompt artifacts, and `/plan` resolution paths
ship clean. The findings below are about (a) documentation drift, (b)
silent surfaces the parity-harness does not pin, and (c) dead code
from older "ported but never wired" findings that survived the Wave-3
fix wave.

---

## Findings

### W6-1 — README + RELEASE_NOTES version drift; patcher instructions broken on min-host

**Severity:** P1 (user-facing — operators following the README hit a hard
error when trying the inline-UI patcher).

**Files:** `README.md`, `RELEASE_NOTES.md`, `scripts/install-chat-stream-seam.mjs`.

**Symptom.** Wave-0 (PR #97) bumped `minHostVersion` to `2026.5.18` and
`package.json` version to `1.0.0-port.15`. The chat-stream-seam patcher
in `scripts/install-chat-stream-seam.mjs` still hard-codes
`MANIFEST_RELDIR = "patches/openclaw-2026.5.10-beta.5"` (line 65), and
only `patches/openclaw-2026.5.10-beta.5/` exists on disk. So:

1. **`README.md:51`** declares `Minimum host version: openclaw >= 2026.5.10-beta.5`
   — stale; should be `2026.5.18`.
2. **`README.md:83,166`** still claim `1.0.0-port.14` and reference it
   as "current v0.x dev." Plugin is at `1.0.0-port.15`.
3. **`README.md:54-81`** documents the inline-UI patcher as a working
   tactical unblock. On a host that meets `minHostVersion = 2026.5.18`
   (the only host this plugin will load on), the patcher fails with
   exit code 3 (`does not match manifest version`) — the
   `chat-stream-seam-patcher.test.ts:150-155` actually tests this
   failure path. Following the README produces an error; the README
   does not warn.

**Why this matters.** A user reading the README to enable inline UI
follows the printed steps and hits a hard error. The blocker doc
`blocker-W1-S17-webchat-ui.md` correctly explains the patcher is
upstream-blocked, but README is the entry point — users will not read
the blocker doc unless told to.

**Recommended fix.**
- README: bump `2026.5.10-beta.5` → `2026.5.18`; bump `1.0.0-port.14` → `1.0.0-port.15`.
- README §"Optional: chat-stream seam patch" lead: prepend a
  `**Status: blocked on upstream PR #80982 (see
  blocker-W1-S17-webchat-ui.md). Instructions below are documented
  for completeness; patcher does NOT apply against 2026.5.18.**`
- Either drop the patcher commands from README, or update them to
  point at a regenerated manifest once Smarter-Claw#78 closes upstream.

**Why P1 not P2.** This is a user-facing broken workflow that ships in
the README of a release-candidate build. A first-time installer trying
inline UI gets an exit-code-3 with no clear "this is expected" signal.

---

### W6-2 — `plan-render.ts` has no byte-fixture test (same antipattern as W1-D3, for the W1-F2 persister)

**Severity:** P1 (regression-detection gap on a "byte-faithful port"
claim).

**Files:** `src/plan-mode/plan-render.ts` (`renderFullPlanArchetypeMarkdown`),
`tests/plan-mode/plan-render.test.ts`.

**Symptom.** `src/plan-mode/plan-render.ts:4-8` explicitly claims:

> Parity contract: byte-faithful port of the in-host
> `renderFullPlanArchetypeMarkdown` (+ private helpers `escapeMarkdown`,
> `neutralizeMentions`, `renderPlanChecklist`'s markdown branch) at
> `src/agents/plan-render.ts:268-355` (commit `ea04ea52c7`).

Every test in `tests/plan-mode/plan-render.test.ts` is `.toContain()` /
`.toMatch()` / section-ordering checks — **no byte-fixture, no
parity-harness pin**. Wave-2's parity harness covers 8 surfaces;
`renderFullPlanArchetypeMarkdown` is not among them. A future change to
this renderer that introduces drift (re-orders sections, changes
escape semantics, adjusts footer text) ships green CI even if the
output diverges from the cited in-host source.

**This is the same antipattern W1-D3 flagged** for the system-prompt
artifacts (`archetype-prompt.ts`, `reference-card.ts`, `plan-mode-injection.ts`).
W1-D3 was closed by the parity harness adding `promptsCheck`. The
new W1-F2 persister landed AFTER the harness was built, and its
output surface wasn't added.

**Recommended fix.**
1. Add a `parity-harness/checks/plan-render.ts` check with a
   `runners/plan-render.reference.ts` vendored from in-host
   `src/agents/plan-render.ts:268-355`. Input: a curated set of
   `PlanArchetypeMarkdownInput` cases (empty plan, full plan with all
   sections, mention-injection adversarial cases, markdown-escape edge
   cases). Compare both sides byte-for-byte.
2. Optionally, also add `plan-filename.ts` (slug generation) and
   `plan-archetype-persist.ts` (TOCTOU-safe write, EEXIST collision
   handling) — both are byte-faithful ports per their docstrings, and
   both are currently unit-tested only via `.toContain()`-style
   assertions or fs-state checks rather than byte-pinned reference
   diffs.

**Why P1 not P2.** The persister is a P0-fix-shipped surface (the
prompt's "plan-*.md" promise) — a regression here re-opens the exact
W1-F2 honesty gap. The fact that the parity-harness was BUILT to
close this antipattern but doesn't cover this new surface is the
asymmetry worth catching.

---

### W6-3 — Grant-ledger pruned on `rejected`, but `rejected` is non-terminal (latent bug)

**Severity:** P2 (latent — has no consequence today because `grantLedger.get`
is never called; would matter if E-11 is ever closed).

**File:** `src/index.ts:294-303`.

**Symptom.** The `before_agent_finalize` audit-emit hook calls
`grantLedger.prune(event.prev.approvalId)` when the next approval
state is `approved | edited | rejected` (lines 297-300). But the
W1-S9-2 fix in PR #99 (re-port of `resolvePlanApproval`) confirmed
that `rejected` is **non-terminal** in the in-host state machine —
re-approvable (`src/plan-mode/approval.ts:100,137`). A rejected plan
can be re-approved on the same `approvalId`.

If a future PR closes E-11 (wires `grantLedger.get()` into the
debug-log enrichment path the class was built for), the ledger
lookup will silently miss for sessions that were rejected then
re-approved — the entry was pruned on the reject.

**Why latent.** E-11 is open: `grant-ledger.get()` is never called in
`src/`. The prune-on-reject thus has no observable consequence today.
But it is a "ported but never wired"-class trap — the wiring is
correct relative to a 3-state terminal model (approved | edited |
rejected) that the state machine itself contradicts.

**Recommended fix.** Drop `rejected` from the prune-trigger predicate
in `src/index.ts:297-300`:

```ts
if (
  event.prev?.approvalId &&
  (event.next.approval === "approved" || event.next.approval === "edited")
) {
  grantLedger.prune(event.prev.approvalId);
}
```

Or extend the predicate to "rejected AND no longer reachable via
re-approval" (which is "next mode is no longer plan" — i.e. the
session exited plan mode). The cheap fix is dropping rejected from
the predicate; the principled fix is gating on "session left plan
mode entirely."

**Why P2.** Latent (no consumer today); affects only the future E-11
closure path; cheap two-line fix.

---

### W6-4 — `register(api)` never invoked in CI (E-9 carryover)

**Severity:** P2 (test-gap; carries over from Wave-1 E-9, was triaged
to P2 originally and stays P2).

**File:** `tests/p1-skeleton.test.ts`, `src/index.ts`.

**Symptom.** `tests/p1-skeleton.test.ts` exercises the plugin's
module shape (`pluginEntry.id`, `pluginEntry.kind`,
`__testing.resolveConfig`) but never actually calls
`pluginEntry.register(fakeApi)`. So nothing in CI asserts:

1. **All 5 hooks register** (`before_tool_call`, `before_model_resolve`,
   `before_agent_finalize`, `before_prompt_build`, `session_start`).
2. **`before_model_resolve` registers conditionally on `config.planTierModel`**
   (`src/index.ts:504`) — a conditional registration whose negative
   case has no test.
3. **`enabled: false` skips all wiring** (`src/index.ts:170-177`).
4. **Session-extension namespace is registered.**
5. **`registerTool` x 3** (`enter_plan_mode`, `exit_plan_mode`,
   `ask_user_question`).
6. **`registerCommand` x 2** (`/plan`, `/plan-mode`).
7. **`registerCli` x 1** (`plan-clear`).
8. **`registerControlUiDescriptor` x 1** (sidebar approval card).
9. **`registerSessionExtensionSchema`** (W1-S9-1 schema fields).

Eva-live-smokes exercise some of this indirectly via `harness.ts`, but
none of them assert the registration *list* — a regression that
silently drops one `api.registerCommand` call would ship green CI.

**Recommended fix.** Add a `tests/p1-skeleton.test.ts::register integration`
describe block that builds a fake `OpenClawPluginApi` that records
every `api.on / registerTool / registerCommand / registerCli /
registerControlUiDescriptor / registerSessionExtensionSchema` call,
invokes `pluginEntry.register(fakeApi)`, and asserts the full
registration list across the `enabled: true` and `enabled: false`
paths.

**Why P2.** Real test-gap; not blocking a release; not changed by any
Wave-3 fix (so not a regression). Maintainability investment for the
next cycle.

---

### W6-5 — `grant-ledger.get()` is still never consumed (E-11 carryover)

**Severity:** P2 (parity-gap; carries over from Wave-1 E-11).

**File:** `src/runtime/grant-ledger.ts`, `src/index.ts:255-303`.

**Symptom.** `src/index.ts` calls `grantLedger.record(...)` on
pending-approval transitions and `grantLedger.prune(...)` on terminal
states. But `grantLedger.get(...)` — the lookup the entire class
exists for, per its docstring at `src/runtime/grant-ledger.ts:22-23`
("a CHEAP lookup by approvalId-only ... useful in hot paths like
debug-log emit where the caller has an approvalId ... and wants to
enrich the event with approvalRunId") — has **zero callers in `src/`**.

The class is wired write-only. It is correctly tested as a data
structure (14 unit tests in `tests/runtime/grant-ledger.test.ts`) and
its lifecycle (record/prune) is correctly threaded into the
`before_agent_finalize` audit emitter. But the debug-log enrichment
that consumes the ledger is never built.

**Recommended fix.** Either (a) wire the `get`-based enrichment into
the debug-log emit path the docstring promises (the
`logPlanModeApprovalTransition` callsite at `src/index.ts:244-251`
is the natural callsite — pass `grantLedger.get(event.next.approvalId)`
into the debug emission for cross-event correlation), or (b)
downgrade the class to "infrastructure for a future correlation
feature, not yet consumed; lookups deferred to vNext" and remove
the `record`/`prune` calls until the consumer ships (the cleanest
"do not write what is never read" version).

**Why P2.** Class is correctly tested in isolation and the `record`
side is fail-soft. The only observable consequence today is memory
overhead (one Map entry per pending plan cycle, freed on terminal
state). Not a regression; not blocking.

---

### W6-6 — `event.provider` / `event.model` still discarded (E-4 carryover)

**Severity:** P2 (missing-feature; carries over from Wave-1 E-4).

**File:** `src/index.ts:520-547,679-720`, `src/runtime/escalating-retry.ts`.

**Symptom.** `2026.5.18` exposes `provider?: string` and `model?: string`
on `PluginHookBeforeAgentFinalizeEvent`
(`node_modules/openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts:143-150`).
The in-host's incomplete-turn detection is provider-gated
(`incomplete-turn.ts:556-573` — only fires for
`isStrictAgenticSupportedProviderModel` or
`GEMINI_INCOMPLETE_TURN_PROVIDER_IDS`).

The plugin's `TurnSignal` interface
(`src/runtime/escalating-retry.ts`) has no `provider` / `model` field,
and `src/index.ts:710-715` builds the signal without reading
`event.provider` / `event.model`. The plugin therefore retries
uniformly regardless of provider, diverging from in-host (which would
NOT retry for an unsupported provider). The coarse-detection
limitation comment (`escalating-retry.ts:40-59`) does not mention
provider gating.

**Recommended fix.** Either (a) thread `provider`/`model` through
`TurnSignal` and gate the escalating-retry detector on it (the parity
fix), or (b) extend the coarse-detection limitations comment to
acknowledge "the in-host gates by provider; the plugin does not — we
retry uniformly across providers" so the divergence is honest, not
silent.

**Why P2.** Behavior divergence (over-retry on unsupported providers
wastes turns; doesn't break correctness). Not changed by any Wave-3
fix; carryover.

---

### W6-7 — `attemptIndex` never wired; escalation tiers (FIRM/FINAL) dead in production (E-10 carryover)

**Severity:** P2 (parity-gap; carries over from Wave-1 E-10).

**File:** `src/index.ts:710-715`, `src/runtime/escalating-retry.ts`.

**Symptom.** `escalating-retry.ts`'s `TurnSignal.attemptIndex` drives
the FIRM/FINAL escalation tier resolvers
(`escalating-retry.ts:406-458`). But `src/index.ts:710-715` constructs
the `TurnSignal` without `attemptIndex`, so it always defaults to 0 —
the plugin always emits the *standard* instruction and never
escalates to FIRM/FINAL in production.

The escalation resolvers are unit-tested in isolation, but the
integration ("does the plugin actually escalate?") evaluates to **no**.
The SDK enforces `maxAttempts` via `idempotencyKey`, but the
*instruction text* never escalates because the plugin never threads
back the attempt count.

**Recommended fix.** Investigate whether the SDK exposes a retry-count
the plugin can read (e.g. from `event.metadata.attemptIndex` or via a
host-side counter). If yes, plumb through. If no, either remove the
FIRM/FINAL tier code (dead) or document the limitation explicitly in
the doc block.

**Why P2.** Standard instruction still functions; the escalation is
just inert. Not a current bypass; not a Wave-3 regression.

---

## Verification (re-run at the start of Wave 6)

```
$ pnpm typecheck
> tsc --noEmit   (no output — clean)

$ pnpm parity-harness
[parity-harness] ✓ 156/156 cases parity-clean across 8 checks
Test Files  1 passed (1)
     Tests  9 passed (9)

$ pnpm test
Test Files  39 passed (39)
     Tests  868 passed (868)
```

All green. The Wave-6 findings above are surfaced from adversarial
re-reading of `src/`, `tests/`, the parity-harness scope, and the
README — they do not affect the green-state of the verification
battery. None of them are P0; the plugin is release-ready.

---

## What Wave 6 did NOT find

- **No P0 correctness or security regressions** vs Wave-1.
- **No state-machine drift** — `resolvePlanApproval` parity-pinned;
  `persistApprovalRequest` 10-invariant pinned.
- **No prompt-byte drift** — `archetype-prompt.ts`, `reference-card.ts`,
  `plan-mode-injection.ts` all parity-pinned via `promptsCheck`.
- **No gate algorithm drift** — `mutation-gate.ts`, `accept-edits-gate.ts`
  both byte-identical to in-host and parity-pinned.
- **No new "ported but never wired" findings** beyond E-11 and E-4
  carryovers — Wave-3 closed A5 (with #107 follow-up) + W1-F4 (wired)
  + the surface scan didn't find a fresh instance.
- **No test-passes-for-the-wrong-reason in the 3 spot-checked suites**:
  `tests/runtime/injection-writer.test.ts` (D1 + D2 hard-pinned with
  exact-match `.toBe(...)` assertions, not `.toContain()`),
  `tests/gates/accept-edits-trigger.test.ts` (real handler invocation
  with state-table cases, not mock-mocking), `tests/state/store.test.ts`
  (real lock + writeCount assertions on each invariant).
