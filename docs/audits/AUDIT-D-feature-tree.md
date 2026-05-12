# AUDIT-D: Feature tree + slice catalog for the parity audit

**Date**: 2026-05-12
**Scope**: Map every requirement in the `architecture-v2/` design docs to (in-host source) × (plugin file) × (PR ladder step) × (tests). Used as the source-of-truth catalog for the slice-by-slice review.
**Companion audits**: [`AUDIT-C-github.md`](./AUDIT-C-github.md) (GitHub state), [`AUDIT-E-sdk-seam-parity.md`](./AUDIT-E-sdk-seam-parity.md) (Beta-5 SDK seam parity — 0 mismatches).

---

## Summary

| Count | What |
|---:|---|
| **12** | Plan-mode features (per `01-PARITY_CATALOG.md`) |
| **15** | Audit slices (12 features + 3 cross-cutting foundations) |
| **14** | PR ladder steps (P-1 → P-14) implementing them |
| **30** | Plugin test files in `tests/` |
| **585** | Tests passing on CI (551 unit + 34 Eva live-smoke integration) |
| **38** | Beta-5 SDK seams examined (Audit E) |
| **12** | Seams actively used by the plugin (Audit E) |
| **0** | Signature mismatches between plugin calls and Beta-5 SDK (Audit E) |
| **17** | Architecture documents on `architecture-v2-planning` |

---

## Slice catalog

Each slice has: an architecture-doc anchor, an in-host source (commit `ea04ea52c7` at `/Users/lume/repos/openclaw-pr70071-rebase`), a plugin implementation path, the PR-ladder step that landed it, and the tests that verify it.

| Slice | Feature | In-host source | Plugin file(s) | PR | Tests (file → cases) |
|---|---|---|---|---|---|
| **S1** | F1: `enter_plan_mode` + `exit_plan_mode` tools | `src/agents/tools/enter-plan-mode-tool.ts`, `exit-plan-mode-tool.ts` | `src/tools/enter-plan-mode.ts`, `src/tools/exit-plan-mode.ts`, `src/tools/common.ts` | P-4 | `tests/tools/enter-plan-mode.test.ts` (9) + `exit-plan-mode.test.ts` (16) = 25 |
| **S2** | F2: Mutation gate (`before_tool_call` fail-CLOSED) | `src/agents/plan-mode/mutation-gate.ts` | `src/gates/mutation-gate.ts` | P-5 | `tests/gates/mutation-gate.test.ts` (116) |
| **S3** | F3: `persistApprovalRequest` 10-invariant mutator (race-fix anchor) | `src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237` (race-fix commit `1081067476`) | `src/state/store.ts` | P-3 | `tests/state/store.test.ts` (67) |
| **S4** | F4: planMode runtime context propagation (archetype injection) | inline at `src/agents/pi-embedded-runner/run/attempt.ts:702-732` | `src/prompt/archetype-prompt.ts`, `src/prompt/plan-mode-injection.ts` + `before_prompt_build` hook in `src/index.ts` | P-7 | `tests/prompt/plan-mode-injection.test.ts` (17) |
| **S5** | F5: Plan archetype + `ask_user_question` + auto-mode | `src/agents/plan-mode/plan-archetype-bridge.ts`, `src/agents/plan-mode/auto-enable.ts` | `src/prompt/reference-card.ts`, `src/prompt/pending-injections.ts`, `src/tools/ask-user-question.ts` | P-8 | `tests/prompt/reference-card.test.ts` (8) + `pending-injections.test.ts` (10) + `tests/tools/ask-user-question.test.ts` (16) = 34 |
| **S6** | F6: Plan-tier model override + turn-limit | scattered across runner | `src/runtime/plan-tier-model.ts` | P-9 | `tests/runtime/plan-tier-model.test.ts` (10) — **turn-limit watchdog deferred** (documented gap, v0.x acceptable) |
| **S7** | F7: Auto-continue + escalating retry (3 detectors) | `src/agents/pi-embedded-runner/run/incomplete-turn.ts` (~1070 LOC) | `src/runtime/escalating-retry.ts` + `before_agent_finalize` hook | P-10 | `tests/runtime/escalating-retry.test.ts` (21) |
| **S8** | F8: Rejection UX + cycle tracking + deescalation at ≥3 | `src/agents/plan-mode/approval.ts`, `src/agents/plan-mode/types.ts:172-209` | `src/prompt/plan-decision-injection.ts` + `recordRejection` mutator in `src/state/store.ts` | P-11 | `tests/prompt/plan-decision-injection.test.ts` (25) |
| **S9** | F9: UI surface (sidebar variant; inline deferred to P-final) | `ui/src/ui/{chat,chat/plan-cards,chat/mode-switcher,chat/plan-resume,views/plan-approval-inline}.ts` | `src/ui/sidebar-descriptor.ts`, `src/ui/session-actions.ts`, `src/ui/sweep-command.ts` | P-12 | `tests/ui/sidebar-descriptor.test.ts` (7) + `session-actions.test.ts` (25) + `sweep-command.test.ts` (9) = 41 |
| **S10** | F10: Exec allowlist + dangerous-flag blocking | embedded in `mutation-gate.ts` + `accept-edits-gate.ts` | `src/gates/mutation-gate.ts` (exec-prefix list) + `src/gates/accept-edits-gate.ts` (3 hard constraints) | P-5 + P-13 | mutation-gate (116) + `tests/gates/accept-edits-gate.test.ts` (72) = 188 |
| **S11** | F11: Approval grant ledger + approvalRunId/approvalId correlation + structured debug log | `src/agents/plan-mode/plan-mode-debug-log.ts:46-62, 260-287` | `src/runtime/grant-ledger.ts`, `src/runtime/debug-log.ts` | P-14 | `tests/runtime/grant-ledger.test.ts` (14) + `debug-log.test.ts` (17) = 31 |
| **S12** | F12: Shell-escape layered defense + approvalRunId silent-bypass guard | `src/agents/plan-mode/accept-edits-gate.ts` | `src/gates/accept-edits-gate.ts` (572-LOC verbatim port) | P-13 | accept-edits-gate.test.ts (72) + `tests/eva-live-smokes/smoke-4-accept-edits-adversarial.test.ts` (16) = 88 |
| **S13** | Plugin foundation: manifest, entry, degraded-state warning | host-side wiring | `src/index.ts`, `openclaw.plugin.json`, `package.json` | P-1 | `tests/p1-skeleton.test.ts` (15) |
| **S14** | Public types + helpers (`PlanMode` union, `newPlanApprovalId`, sanitize, payload-hash, schema-version) | `src/agents/plan-mode/types.ts` + helpers | `src/types.ts`, `src/helpers/{approval-id,sanitize,payload-hash}.ts`, `src/state/schema-version.ts` | P-2 | `tests/types.test.ts` (8) + `helpers/approval-id.test.ts` (9) + `helpers/sanitize.test.ts` (9) + `helpers/payload-hash.test.ts` (14) + `state/schema-version.test.ts` (7) = 47 |
| **S15** | Real persistence gateway (SessionStoreGateway via `updateSessionStoreEntry`) | integration in `src/gateway/sessions-patch.ts` | `src/state/session-store-gateway.ts`, `src/state/in-memory-gateway.ts` | P-6 | `tests/state/session-store-gateway.test.ts` (6) |

### Cross-cutting test surfaces

| Surface | Files | Cases |
|---|---|---|
| Parity harness Layer 1 | `tests/parity/parity-harness.test.ts` + `parity-harness/inputs/persistApprovalRequest.json` | 1 (driver) covering 11 input cases |
| Eva live-smokes (P-5/P-8/P-11/P-13) | `tests/eva-live-smokes/{harness,smoke-1,smoke-2,smoke-3,smoke-4}.ts` | 34 |
| Plugin-skeleton CI gate | `tests/p1-skeleton.test.ts` | 15 |
| Injection-writer (cross-cutting) | `tests/runtime/injection-writer.test.ts` | 23 |

---

## Slice → PR mapping

The PR ladder (P-1 → P-14) lands slices in a specific order chosen so each step is reviewable + reversible:

| Step | Slice(s) landed | Cumulative tests (running total) |
|---|---|---|
| P-1 | S13 | 15 |
| P-2 | S14 | 62 |
| P-3 | S3 | 129 |
| P-3.5 | parity-harness layer 1 | 130 |
| P-4 | S1 | 155 |
| P-5 | S2 + part of S10 (mutation-gate side) | 271 |
| P-6 | S15 | 277 |
| P-7 | S4 | 294 |
| P-8 | S5 | 328 |
| P-9 | S6 (partial — turn-limit deferred) | 338 |
| P-10 | S7 | 359 |
| P-11 | S8 | 384 |
| P-12 | S9 | 425 |
| P-13 | S10 (accept-edits side) + S12 | 497 |
| P-14 | S11 | 528 |
| Eva live-smokes | cross-cutting integration | 562 |
| (CI fixes — no new slices) | — | 585 |

Cumulative total matches the CI test count (585) at `main@47f3b73`.

---

## Coverage gaps + deferred items

1. **S6 turn-limit watchdog** — deferred from P-9 (the plan-tier-model PR shipped; the turn-limit watchdog is a separate concern needing `registerSessionSchedulerJob` wiring). Documented gap. v0.x acceptable; tracked in epic #77.

2. **S9 inline UI** — deferred to P-final, gated on upstream SDK seam (`registerChatStreamRenderer`, draft PR `openclaw/openclaw#80982`). Sidebar UI variant ships in v0.x.

3. **autoApprove runtime FIRE path** — `setAutoApprove` mutator (P-13) + before_tool_call layer-2 gate exist, but the runtime path that AUTO-RESOLVES approval on `exit_plan_mode` (skipping the pending state when autoApprove=true) is deferred to P-final. v0.x's plan.auto.toggle action persists the flag; the gate reads it correctly; the auto-resolve loop doesn't fire yet. Documented in RELEASE_NOTES.md "known limitations".

4. **Audit-trail enforcement (S11)** — `recordApproval`/`recordRejection` audit emits are tested. Cross-cutting "grant ledger persists across approval cycles" is observable only via in-memory `GrantLedger` class tests (14 cases). Sufficient for v0.x.

None of the above is a blocker for v0.x internal use.

---

## Slice-by-slice review schedule

The B.5 step of the Phase B plan ([../../glistening-swimming-rivest.md](../../../../.claude/plans/glistening-swimming-rivest.md) — the durable plan file outside this repo) walks each slice with this verification:

1. **Architecture statement check** — read the slice's source-of-truth doc references; confirm the doc-stated requirement is unambiguous.
2. **Implementation check** — read the listed plugin file(s); verify the requirement is encoded.
3. **`host_ref:` citation check** — every plugin file MUST carry a `host_ref:` comment pointing at the in-host source.
4. **Test coverage check** — confirm the slice's test file(s) pass (use the most recent CI run — don't burn local resources).
5. **Boundary check** — any inter-slice integration (e.g. S2 mutation gate reads state written by S3 persist) — verify the read/write contract is consistent.

Output per slice (filled in B.5):

| Slice | Status | Notes |
|---|---|---|
| S1 | ☐ | enter/exit tools |
| S2 | ☐ | mutation gate (load-bearing — security boundary) |
| S3 | ☐ | persistApprovalRequest 10 invariants (load-bearing — race-fix) |
| S4 | ☐ | archetype injection |
| S5 | ☐ | plan archetype + ask_user_question |
| S6 | ☐ | plan-tier model override (turn-limit deferred) |
| S7 | ☐ | escalating retry (load-bearing — "tests pass but real gateway doesn't fire" risk) |
| S8 | ☐ | rejection UX + cycle tracking |
| S9 | ☐ | sidebar UI |
| S10 | ☐ | exec allowlist (load-bearing — security) |
| S11 | ☐ | grant ledger + debug log |
| S12 | ☐ | shell-escape layered defense (load-bearing — security) |
| S13 | ☐ | plugin foundation |
| S14 | ☐ | public types + helpers |
| S15 | ☐ | real persistence gateway |

Load-bearing slices reviewed first: **S3, S2, S10, S12, S7.**
Foundation slices reviewed last: **S13, S14, S6.**

---

## Audit cross-walk

- This catalog is consistent with [`AUDIT-E-sdk-seam-parity.md`](./AUDIT-E-sdk-seam-parity.md) (every plugin file's SDK calls match Beta-5 signatures; 0 blockers).
- The [`AUDIT-C-github.md`](./AUDIT-C-github.md) shows the GitHub state at v1-port merge time: epic #77, upstream tracker #78, legacy cleanup #79, PR #80 (merged), v1.0.0-port.14 release.
- A killed Audit A (architecture parity) ran briefly; its only durable finding was that `composePromptWithPendingInjections` in `src/prompt/pending-injections.ts` is a parity-reference function (the host owns the actual drain via `api.session.workflow.enqueueNextTurnInjection`). NOT a coverage gap.
