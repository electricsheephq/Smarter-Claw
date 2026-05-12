# Parity-Test Harness — Design (no code yet)

**Status**: Design-only. Closes the 2 HIGH findings from `13-PRE_LOCK_ADVERSARIAL.md`:
- **HIGH 1**: Plugin's `PlanModeStore.persistApprovalRequest` unit tests certify the SPEC, not parity with the in-host reference.
- **HIGH 2**: 875-test corpus can ship "passing" while silently diverging if the catalog drifted from code.

**Output**: a mechanical harness that gates plugin shipping on parity with the in-host reference, not on the plugin team's spec-faithfulness.

---

## The problem in one sentence

Spec parity is a hope; mechanical parity is a guarantee. Writing tests for the plugin tests what the plugin DOES — but the plugin can do exactly the wrong thing if the spec was wrong. We need tests where the in-host reference and the plugin both run the same input and we assert they produce the same output.

---

## Architecture: two test layers, one shared input table

```
                      shared inputs.json
                  (CRUD-like test cases)
                       /              \
                      /                \
                     ↓                  ↓
       in-host reference         plugin under test
       (rebase/pr70071-...)     (Smarter-Claw branch)
                |                       |
                |   captures            | captures
                | output snapshot       | output snapshot
                |                       |
                ↓                       ↓
            host.snapshot.json    plugin.snapshot.json
                          \      /
                           ↓    ↓
                       DIFF / assert
                       (parity gate)
```

Both runners produce a deterministic snapshot for each input case. The harness diff'd them; any diff fails the build.

---

## Layer 1: Pure-logic parity (unit-level)

**Target functions** (start with these; expand as plugin grows):
1. `persistPlanApprovalRequest` (the 10-invariant function) — highest priority, zero in-host unit tests today
2. `accept-edits-gate` mutation check
3. `escalating-retry` level selection
4. `sanitizeFeedbackForInjection` + `newPlanApprovalId`
5. Plan-archetype prompt generation
6. Exec-allowlist normalization

**Test format**:
- One `inputs.json` file per target function, in `parity-harness/inputs/<function>.json`
- Schema:
  ```json
  [
    {
      "id": "case-001",
      "description": "plain happy path; first plan approval emitted",
      "input": { /* function arguments */ },
      "state_before": { /* relevant in-memory state */ }
    },
    {
      "id": "case-002",
      "description": "idempotent reuse on payloadHash match",
      "input": { /* same as case-001 but second invocation */ },
      "state_before": { /* result of case-001 applied */ }
    }
  ]
  ```

**Runners**:
- `parity-harness/runners/host-reference.ts` — runs the in-host implementation against each input case. Imports the actual `persistPlanApprovalRequest` (or similar) from `/Users/lume/repos/openclaw-pr70071-rebase`. Outputs `host.snapshot.json` of shape `{ caseId, result, state_after, audit_events_emitted, log_lines }`.
- `parity-harness/runners/plugin-under-test.ts` — runs the plugin's `PlanModeStore.persistApprovalRequest` (or whatever). Same input → same snapshot shape.

**Differ**:
- `parity-harness/diff.ts` — reads both snapshots, computes a structural diff. If any case's host snapshot ≠ plugin snapshot, fail with a per-case diff report.
- Tolerates documented-divergence in a whitelist (e.g., timestamps, plugin-id strings).

**Run**:
```bash
pnpm parity-harness  # runs both, diffs, fails the build on any unexplained drift
```

CI gate: this is part of `npm test` in the plugin repo, runs on every PR.

---

## Layer 2: Integration parity (end-to-end)

For the ~30% of in-host tests that are gateway-internal (sessions, runtimes, etc.), per Agent O's finding, we can't unit-port them. But we can integration-test:

**Shared scenario format**:
- `parity-harness/scenarios/<feature>.yaml` describes a multi-step session:
  ```yaml
  id: scenario-001
  description: Plan approval cycle — user enters plan, agent emits plan, user approves
  steps:
    - kind: agent-tool-call
      tool: enter_plan_mode
      args: {}
    - kind: assert-state
      check: planMode === "plan"
    - kind: agent-message
      content: "Here's my plan:..."
    - kind: agent-tool-call
      tool: ask_user_question
      args: { question: "Continue?", options: ["yes","no","Other"] }
    - kind: user-slash
      command: "/approve"
    - kind: assert-state
      check: planMode === "execute" && approvalRunId === <captured>
  ```

**Runners**:
- `parity-harness/runners/host-session.ts` — drives a host instance via the gateway WS protocol. The session is real; the assertions are the contract.
- `parity-harness/runners/plugin-session.ts` — drives a plugin-loaded session via the same gateway WS protocol. The session is real; the plugin's behavior must match.

Both runners use the same in-process gateway harness (no separate processes) so they're fast (< 1 sec per scenario).

**Diff**:
- Compare the trace of session events: state transitions, tool calls fired, messages produced, RPC responses.
- Failures show the first divergence point with full surrounding context.

---

## Layer 3: Continuous parity (post-ship)

Even after the plugin ships, the in-host reference branch (rebase/pr70071-...) MAY get fixes that the plugin needs to absorb. Or the plugin may diverge accidentally during refactors.

**Periodic check** (manual or cron):
- Pull latest in-host reference
- Run all parity-harness scenarios
- Generate drift report
- Open issue if drift > tolerance

**Sunset condition**: once the plugin is mature and in-host is removed (or the upstream UI PR lands so the plugin owns backend entirely), the parity harness becomes the regression test suite. Less drift-detection, more "did we break our own contract."

---

## Test corpus port plan

The 875 in-host tests need to be classified:
- **Pure logic (~70%, ~613 tests)**: port verbatim to plugin test suite. These run against plugin implementations directly.
- **Layer 2 integration (~20%, ~175 tests)**: port AS scenarios to `parity-harness/scenarios/`. These run against both host and plugin and diff.
- **Layer 1 unit-parity (~10%, ~87 tests)**: covered by `parity-harness/inputs/` cases — both impls tested with same inputs.

**Net plugin test count after port**: ~613 (verbatim) + ~262 (parity-harness cases, since each scenario is one case but tests both impls). The plugin gets MORE total assertions than the in-host had — because parity-harness doubles coverage.

---

## Effort estimate

- Layer 1 harness scaffolding: ~600 LOC of TypeScript across 8 files. Sized to ship as PR-3.5 (between PlanModeStore foundation and the first feature wiring).
- Layer 2 harness scaffolding: ~800 LOC, including the in-process gateway driver. Sized to ship as part of PR-5 (Eva live-smoke #1).
- Layer 3 (cron + drift detection): ~200 LOC + a workflow file. Ships as PR-14 (release-readiness).

Total parity-harness scaffolding: ~1,600 LOC. Net addition to the PR ladder: roughly equivalent to one additional PR worth of code.

---

## Why this addresses the HIGH findings

**HIGH 1 (mutator tests certify spec)**:
- Layer 1 covers `persistPlanApprovalRequest` with shared inputs. The plugin can't ship if its outputs differ from the in-host reference.
- Layer 2 covers the end-to-end flow that exercises the function in context.
- Together: spec compliance is automatically also reference compliance.

**HIGH 2 (test corpus could ship "passing" while diverging)**:
- The 70% pure-logic ports run against the plugin. They certify the plugin's spec.
- The 20-30% integration ports run via parity-harness against BOTH impls. They certify the reference is matched.
- Drift surface is therefore exactly the 70% — and those are pure-logic where divergence would be visible at code review.

---

## Open design questions

1. **Should host-reference snapshots be checked into git**, or regenerated on each run? If checked in, drift in the host changes the snapshots and CI catches it. If regenerated, the source-of-truth is always the latest host code. Recommend: check in, with a CI job to regenerate on `master` of openclaw upstream (so we know within a day if upstream changed behavior).

2. **How do we handle the host being a moving target?** Pin to a specific commit (ea04ea52c7 today). Bump the pin deliberately; never accidentally.

3. **What's the tolerance threshold for "documented divergence"?** Plugin id strings WILL differ. Timestamps WILL differ. Anything else needs justification. Recommend: tight whitelist, fail by default.

---

## Integration with the PR ladder

| PR # | Adds parity-harness component |
|---|---|
| PR-3 | (existing) PlanModeStore foundation |
| PR-3.5 (NEW) | Layer 1 scaffolding + first case for `persistApprovalRequest` (~600 LOC) |
| PR-5 | (existing) Eva live-smoke #1; **add** Layer 2 scaffolding here (~800 LOC) |
| PR-8, 13 | (existing) Eva live-smoke #2/#3; **add** scenarios for those features |
| PR-14 | (existing) v1.0 release; **add** Layer 3 cron + drift detection (~200 LOC) |

Total: ~1,600 LOC of parity-harness across the ladder, distributed across 5 PRs.

---

## Recommendation

Build this. It's the difference between "plugin works as far as we can tell" and "plugin provably matches the reference until proven otherwise." Eva's "zero divergence acceptable" mandate requires mechanical enforcement; this is the mechanical enforcement.

The cost (~1,600 LOC over the ladder) is small relative to the safety win. The mental cost (always having two implementations diverge-free) is also the mental cost of "100% parity" which is what we already agreed to. No new commitment.
