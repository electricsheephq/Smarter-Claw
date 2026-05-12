# 04 — Lessons Learned from the Failed Plugin Port

**Status:** Post-mortem of `electricsheephq/Smarter-Claw@main` (last commit `d17d497`, 2026-04-25).
**Bottom line:** the plugin shipped 8.5K LOC, 42 host patches, 19 open issues (7 release-blockers, all P0), README claiming "feature-complete" while the live operator (Eva) hits a "messages disappear" UX regression on first use. The plugin **runs** in a sandbox; it does not have **parity** with PR #70071.

This doc is the failure dossier. No diplomacy.

---

## A. Architectural mistakes (wrong abstraction)

### A1. Chose "plugin-owned namespaced state + 42-patch installer" over "wait for SDK seams"
- `installer/patch-plan.json` declares 42 patches against host v2026.4.23 — 6 core diffs + 26 UI anchor-patches + 9 brand-new UI files copied verbatim from PR #70071 + 1 schema patch.
- Equivalent to forking the host UI while pretending to be a plugin.
- The takeover doc (`docs/TAKEOVER_ARCHITECTURE_PLAN.md`, branch `takeover/parity-architecture-plan`) admits this: *"where current OpenClaw hooks cannot reproduce the integrated behavior, Smarter-Claw must add narrow reversible host patches rather than accepting lower parity."* That sentence is the load-bearing rationalisation that justified everything that followed.
- Concrete result: the rebased in-host port (`openclaw-pr70071-rebase`, 172 commits on `v2026.4.24`) replaces the entire plugin-installer combo and works end-to-end. The patcher approach was the wrong abstraction from week one.

### A2. Two parallel state vocabularies — by design — never reconciled
- `src/types.ts:84-105` documents the split: plugin uses `idle | proposed | awaiting-approval | approved | rejected | cancelled | expired`; PR #70071 host/UI uses `none | pending | approved | edited | rejected | timed_out`.
- "Adapters bridge the two when needed" (`src/types.ts:250`) — but no central adapter exists (`grep -n "projectFor\|toHostShape" src/` returns nothing of substance).
- Issue #44 ("Contract-lock PR #70071 compatibility adapter") and #45 ("Fix approval ID and pending approval vocabulary") are both P0 release-blockers acknowledging the vocabulary leaked into UI/sessions rows.
- This was a premature "we'll abstract it" that locked in a forever translation tax.

### A3. `appendSystemContext` chosen for plan injections instead of turn-boundary delivery
- `src/injection-drain-hook.ts:11`, `src/archetype-hook.ts:5-6`, and `src/execution-status-injection.ts:171` all rely on `appendSystemContext`.
- Issue #47 (P0 blocker): PR #70071 prepends to the next user/model turn via a runner seam. `appendSystemContext` is generic system context — wrong timing, wrong determinism.
- The drift between "what we have available" and "what parity requires" was rationalised away with a comment ("appendSystemContext is the cacheable surface") rather than fixed.

### A4. Two snapshot persister paths
- `docs/TAKEOVER_ARCHITECTURE_PLAN.md` flags this directly: *"Choose one snapshot persister path and remove duplicated partial behavior."*
- `src/snapshot-persister.ts` runs in plugin space; `installer/patches/core/pi-embedded-subscribe-exit-plan-mode-emit.diff` runs in the host. Both partially persist. Neither alone is complete.

### A5. Mutation gate hard-fails silently
- Issue #75 (UX-blocker, Eva live regression): gate returns `blocked`, agent retries other tools, all blocked, agent gives up, user sees nothing.
- The right abstraction was "block + synthesise a tool-result the agent must surface to the user" (option a in #75). The plugin chose "return blocked" because that's the smallest hook contract — abstraction picked for implementation convenience, not user experience parity.

### A6. Global cron heartbeat instead of per-session one-shots
- `src/plan-nudge-crons.ts:48-95`: one interval cron, payload-side filtering.
- PR #70071 used per-session one-shot crons scheduled inside `enter_plan_mode`. Confirmed in README "Known limitations": *"today uses a global interval cron with payload-side filtering; openclaw-1 used per-session one-shots."*
- Picked because the SDK didn't have per-session scheduling — then advertised as feature-complete in the config schema (`openclaw.plugin.json` exposes nudge knobs that have no per-session backing).

---

## B. Implementation mistakes (started, not finished)

### B1. Schema-accepted, no-op config knobs (README.md:145-147 admits this)
The plugin manifest (`openclaw.plugin.json`) declares these — implementation ignores them:
- `mutationGate.blockedTools` (override list — unused)
- `retry.limit` (`docs/TAKEOVER_ARCHITECTURE_PLAN.md`: "queue's per-id dedup gives an effective limit of 1 today")
- `autoApprove.default` (issue #44 acceptance: not wired to real lifecycle)
- `snapshot.persist`, `snapshot.maxStepsRendered`
- `archetype.minStepCount`
- `agents` filter — honoured only on `agent_end`; all other handlers fall through (README.md:233)

**This is the loudest drift signal in the repo.** Manifest claims a contract; code ignores it.

### B2. Files that advertise "no-op" / "installer required" / "wiring not installed"
- `src/snapshot-persister.ts:169` — *"subscribe + persistSnapshot deps required to fire. Returning no-op shutdown handle."*
- `src/slash-command-deps.ts:162` — *"Returning current state is a no-op for persistSmarterClawState"*
- `src/tool-result-persist-hook.ts:21` — hook returns `undefined` so host treats it as no-op
- Issue #18 — slash command leaks *"wiring not installed"* message to attackers (still open)

### B3. Hooks that don't fire for plugin-registered tools
README.md:232: *"`tool_result_persist` / `before_message_write` hooks don't fire for plugin-registered tools through Pi. Plan-markdown audit-trail write happens in the tool body as a workaround."* — workaround instead of a fix.

### B4. Subagent gate enforced in only one of two paths
Issue #73 (SECURITY blocker): `exit_plan_mode` tool body checks `blockingSubagentRunIds`; `sessions.patch` (inline UI approve button) does not. Result: user clicking Approve bypasses the gate.

### B5. Diff parser bugs in the patcher itself
Issues #15 (silent-corruption on hunk-header oldLen/newLen mismatch), #25 (invertUnifiedDiff naive line-number swap), #26 (`\ No newline at end of file` marker before separator crashes). All P2 still open. **The installer that the architecture depends on is itself half-built.**

### B6. Tests are pure-logic, never integration
- 18 test files, 0 host-applied or live-runtime tests.
- `tests/escalating-retry.test.ts` covers a state machine; no test verifies the gate's user-visible behaviour, no test verifies the installer's patches round-trip cleanly against a real host worktree, no test catches issue #75 (mutation-gate silent block).
- Eva ran the plugin → first thing she found was the silent-block regression. The 563 unit tests passed and predicted nothing.

---

## C. Process mistakes (how, not what)

### C1. Worked from spec, not from in-host source-of-truth
- The TAKEOVER doc opens with *"Source of truth: OpenClaw PR #70071 behavior"* — but PR #70071 is 39K LOC of working code. The plugin treated it as a behavioural spec and re-derived implementations, instead of mechanical line-by-line port with deviation log.
- No parity catalog exists in the repo (`grep -ri "parity catalog\|parity matrix" .` finds only references to its absence in the takeover doc).
- Result: 7 P0 blockers all describing the same failure-mode — *"plugin behaviour drifts from PR #70071"*.

### C2. No feedback loop with reality until Eva ran it
- 70+ commits between Initial commit (`a39d2b5`) and the first live operator regression (`#75`, found 2026-04-25 04:54).
- Vocabulary split (A2), wrong injection seam (A3), silent-block UX (A5), subagent bypass (B4) all *would have been caught by 30 minutes against the real PR #70071 reference flow.*
- Adopted `dev-snapshot-2026-04-24` and tagged `v1.0.0` / `v2.0.0` as "releases" before live test (later retracted in README.md:50-54: *"Those were dev-snapshot tags that were inappropriately framed as releases."*).

### C3. Scope creep ratcheted, never contained
- Started as a plugin. Grew to "plugin + installer". Grew to "plugin + installer + UI shadow-fork". Grew to "plugin + installer + UI shadow-fork + 6 core host diffs". Grew to "...+ host-mutation queue spec" (`docs/sprint-2-plan` branch).
- Sprint 2 added 3 CRITICAL blockers (per `origin/docs/sprint-2-plan` tip) before Sprint 1 was operator-verified.
- Sprint planning happened in branches not yet merged to main. The repo's `main` does not reflect even the *known* required work.

### C4. CI lane stable, release lane broken
- PRs #39-#42 added CI infrastructure (atomic manifest write, packed-artifact smoke, stable job names). All passed. None of them caught: silent UX block, vocabulary split, wrong injection timing, subagent bypass.
- `docs/TAKEOVER_ARCHITECTURE_PLAN.md`: *"Remaining risk is runtime parity, host adapter correctness, timing/debuggability, and installer release confidence."* — CI proved none of those.

### C5. Two builders (Smarter Claw Bot + EVA) writing to same branches with no parity owner
- Commit log shows alternating authorship. No single owner of the contract between plugin and host.
- The TAKEOVER doc tries to retroactively create roles ("Parity architect", "Host/installer architect", etc.) — *after* the mess existed.

---

## D. Missing context (knowledge gaps)

### D1. Team did not know "PR #70071 is the executable spec; the plugin port is a transcription, not a re-design"
- **Knowledge sentinel**: parity catalog file at `architecture-v2/PARITY_CATALOG.md` mapping every feature to in-host `file:line` in the rebase tree (`/Users/lume/repos/openclaw-pr70071-rebase`). Any feature without a `host_ref` cannot be ported.

### D2. Team did not know "if you have to patch the host UI, you've left plugin-land"
- **Knowledge sentinel**: a CI check that fails if `installer/patches/ui/` is non-empty. Hard cap: zero UI patches. UI lives in-host or it doesn't ship.

### D3. Team did not know "config schema is a contract, not an aspiration"
- **Knowledge sentinel**: a test that loads `openclaw.plugin.json`, parses every declared config knob, and asserts each one is referenced from source code with an executable code path. No knob may be schema-accepted-but-no-op.

### D4. Team did not know "the in-host implementation IS already running"
- The `openclaw-pr70071-rebase` worktree at `v2026.4.24` + 172 commits is live and Eva-verified per memory. The plugin re-derived 8.5K LOC of behaviour that already existed in-host as ~39K LOC of tested code.
- **Knowledge sentinel**: before any plugin work, the agent must `cd /Users/lume/repos/openclaw-pr70071-rebase && git log --oneline -5` and confirm the in-host implementation hash being ported from. No hash → no port.

### D5. Team did not know vocabulary translation is a free-floating bug factory
- 7 of the 7 P0 release-blockers (#73, #75, #44, #45, #47, #48, #43) involve vocabulary, projection, or boundary mismatch — not feature absence.
- **Knowledge sentinel**: zero-translation rule. Plugin emits exactly the same field names and enum values as the in-host implementation. If translation is needed, the host needs an SDK seam first.

---

## Top 10 Guardrails for the New Port

> **Guardrail 1 — Parity catalog is the entry condition.** Before any plugin code is written, `architecture-v2/PARITY_CATALOG.md` must exist and list, for each in-host feature, the `file:line` in `/Users/lume/repos/openclaw-pr70071-rebase` that implements it. **Testable:** a CI check parses the catalog and fails if any feature row has `host_ref: TBD` while a corresponding plugin source file exists.

> **Guardrail 2 — Zero UI patches.** `installer/patches/ui/` must be empty for the lifetime of the project. UI parity ships via in-host PR or it doesn't ship. **Testable:** `test -z "$(ls installer/patches/ui 2>/dev/null)"` in CI.

> **Guardrail 3 — Zero schema-only config knobs.** Every property in `openclaw.plugin.json#configSchema` must be referenced from source code in a non-trivial code path. **Testable:** AST scan that maps every JSON-schema key to at least one `config.<knob>` read in `src/` or `index.ts`; failure is a hard CI error.

> **Guardrail 4 — Single vocabulary.** Plugin state types must use the exact enum values declared in the in-host reference (`SessionEntry.planMode`, `SessionEntry.pendingInteraction.kind`, approval state strings). **Testable:** a contract test imports the host's type declarations and asserts plugin types are structurally equal — `Equal<HostPlanMode, PluginPlanMode>` (typed-test).

> **Guardrail 5 — Live integration test before commit ≈5.** A `tests/integration/` suite that starts a real OpenClaw gateway, runs the plugin against it, and exercises the full plan→approve→execute→complete flow must exist before the 5th feature commit (not the 47th). **Testable:** CI job `integration-roundtrip` must be present in `.github/workflows/` from the first PR; it counts plugin source commits and fails if > 5 land without the integration test reaching `assert(planComplete)`.

> **Guardrail 6 — Eva canary gate on every PR.** Every PR that touches plan-mode logic must include a 1-line manual repro the operator can paste into Eva's chat. **Testable:** PR template requires `## Eva Repro:` section; CI fails if PR body lacks it and any file under `src/` changed.

> **Guardrail 7 — No "no-op" returns in production paths.** No source file may contain the literal strings `"no-op shutdown handle"`, `"wiring not installed"`, `"installer required"`, or equivalent stubs. **Testable:** ripgrep CI check; fails on match.

> **Guardrail 8 — Gate-blocked tool calls must surface to user.** Mutation gate must emit a synthetic tool-result the agent surfaces; silent `blocked` returns are forbidden. **Testable:** integration test asserts the user-facing transcript contains the gate-reason string within one assistant turn of a blocked tool call.

> **Guardrail 9 — Subagent gate is one function, called from every entry point.** `checkSubagentGate(slot)` must be invoked from (a) the tool body, (b) the sessions.patch handler, (c) the slash-command path. **Testable:** unit test asserts all three callsites import the same symbol; integration test reproduces issue #73 and asserts it now blocks.

> **Guardrail 10 — Tag = canary-validated.** No `v1.x` or `v2.x` git tag may exist before the operator has run the build against live traffic for ≥24h with zero `area/runtime` issues opened. **Testable:** release workflow checks `gh issue list --label area/runtime --created-since=<tag-date - 24h>` returns empty before allowing the tag push.

---

## Closing note

The previous port failed because it picked a plugin abstraction that couldn't reach parity, then patched around the gap until the patches became the system. The fix is not "patch better". The fix is to **stop pretending the plugin boundary holds when the feature requires host changes**. If you need host changes, change the host first, then the plugin shrinks to the residual.

The 172-commit in-host rebase exists and works. Port from it. Don't re-derive it.
