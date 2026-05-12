# Wave-1 Consolidated Audit Plan

**Date**: 2026-05-12
**Author**: Wave-1 consolidation analyst (A-final)
**Inputs**: 10 Wave-1 audit reports (S1–S15) covering ~295 raw findings.
**Method**: Dedupe across slices, categorize into A (bug fixes) / B (testing gaps) / C (feature parity), priority-rank P0/P1/P2.

---

## Section 1: Executive summary

### Counts

- **Raw findings**: ~295 across 10 reports
- **Deduped findings**: 138 unique items (53% dedupe rate, hitting the ~50% target)

### Bucket distribution

| Bucket | P0 | P1 | P2 | Total |
|---|---:|---:|---:|---:|
| **A — Bug fixes** | 18 | 18 | 6 | 42 |
| **B — Testing gaps** | 13 | 27 | 18 | 58 |
| **C — Feature parity** | 12 | 16 | 10 | 38 |
| **Totals** | 43 | 61 | 34 | **138** |

### Confidence summary

| Slice | Confidence | Why it's where it is |
|---|---:|---|
| S6/S13/S14 foundation | 90% | Foundation slices have the densest tests; the main worry is the missing canonical-spec doc + the `newPlanApprovalId` hard-refusal test (deferred-by-design). |
| S12 accept-edits | 80% bypass risk | Gate algorithm is byte-identical, but the trigger predicate diverges in a way that turns plain-Accept into a silent bypass. THE highest-leverage gap. |
| S2/S10 mutation-gate | 82% (18% bypass risk) | Algorithm parity is solid; integration wiring is the weak link. |
| S1 enter/exit tools | 78% | Tool descriptions diverge byte-by-byte from in-host; no parity test enforces equality. |
| S9 UI surfaces | 70% | Sidebar variant scoped well, but sanitization gaps on `plan.edit` body + `plan.answer` selectedOption are real bug surface. |
| S8 rejection UX | 65% | `recordApproval` has FOUR P0 parity divergences silently locked in by passing tests. |
| S15/S11 persistence | 62% | SessionStoreGateway has zero behavioral coverage; `approvalRunId` never persisted — grant ledger is functionally dead code. |
| S3 persistApprovalRequest | 55% | Solid per-branch coverage but concurrency, audit-throw, schemaVersion-downgrade paths uncovered. |
| S4/S5 prompt+archetype | 55% | Static content byte-clean but no byte-equality tests; ACTION CONTRACT block, AVAILABLE branch, auto-enable not ported. |
| S7 escalating retry | 38% | Lowest — plugin retains ~30% of in-host semantics; `madeToolCall` is single-bit proxy of 5 orthogonal signals. |

### Top-5 most-urgent findings across all buckets

1. **A-P0-1 — Trigger predicate divergence in accept-edits gate** (S12 + S9 + S8). Plain "Accept" doesn't engage the gate in the plugin; in-host blocks. THE silent-bypass bug. P0(bypass)=80%.
2. **A-P0-2 — `recordApproval` 4-way parity drift** (S8). Plugin's recordApproval doesn't reset `rejectionCount`, doesn't clear `feedback`, doesn't transition `mode→normal`, and blocks `rejected→approved`. Tests cement all four divergences.
3. **A-P0-3 — `approvalRunId` never persisted** (S15 + S11). Grant ledger is functionally dead — its only correlation field is never populated. Debug-log threading is broken.
4. **A-P0-4 — Sanitization not applied to `plan.edit` body + `plan.answer` selectedOption** (S9). Adversarial body containing `[PLAN_DECISION]:` can close the envelope and inject decisions next turn.
5. **C-P0-1 — ACTION CONTRACT block missing from system prompt** (S4). Plugin's `buildPlanModeSystemContext()` omits the 5-paragraph block between the header and hard rules — material divergence vs in-host, degrades agent steering.

---

## Section 2: Bucket A — Bug fixes

Behavior is wrong/broken. Real defects requiring code change. Includes parity drift where plugin SHIPS divergent behavior from in-host (not just tests).

| ID | P | Title (≤60 chars) | Slices | Description | Action | LOC |
|---|---|---|---|---|---|---|
| **A-P0-1** | P0 | Trigger predicate diverges (plain-Accept bypass) | S12, S9, S8 | Plugin's `isAcceptEditsPhase = autoApprove \|\| approval==='edited'` MISSES plain-Accept (user clicks Accept with no edits). In-host fires gate via `postApprovalPermissions.acceptEdits` set on BOTH paths. Result: rm -rf, DROP TABLE, openclaw config set ALL ALLOWED in plain-Accept post-approval state. THE single most important security finding. In-host file: `pi-tools.before-tool-call.ts:324`; `fresh-session-entry.ts:104-119`. | Extend `PlanModeSessionState` with `postApprovalPermissions.acceptEdits: boolean`. Set it on BOTH `recordApproval` paths (with-edits AND plain-Accept). Update `isAcceptEditsPhase` in `src/index.ts:399-400` to read it. Add the in-host-equivalent invariant test ("gate DOES fire on plain Accept"). | medium |
| **A-P0-2** | P0 | recordApproval doesn't reset rejectionCount | S8 | In-host `approval.ts:99-100` explicitly resets `rejectionCount: 0` on approve. Plugin `store.ts:567-573` spreads `...current` keeping prior count. Net: approved-then-re-entered session retains rejection history, first single rejection triggers deescalation hint as noise. | In `src/state/store.ts:recordApproval`, set `rejectionCount: 0` in the patch. Update `store.test.ts:746-754` to assert reset. | small |
| **A-P0-3** | P0 | recordApproval doesn't clear feedback | S8 | In-host `approval.ts:99` sets `feedback: undefined` on approve. Plugin spreads `...current`, preserving stale feedback. Pollutes downstream UI projection. | In `src/state/store.ts:recordApproval`, set `feedback: undefined` in the patch. Add test assertion. | small |
| **A-P0-4** | P0 | recordApproval doesn't transition mode→normal | S8 | In-host `approval.ts:95,107` sets `mode: "normal"` immediately. Plugin keeps `mode: "plan"` until the runtime drains the injection. Load-bearing: the mutation gate (S6) reads session.mode to decide whether mutation tools are allowed — divergence lets mutation tools fire post-approval but pre-injection-drain. | In `src/state/store.ts:recordApproval`, set `mode: "normal"` in the patch. Decide: align with in-host immediate transition, OR document the deferral as intentional and add a layer-2 mutation-gate check that fail-closes post-approval. | small |
| **A-P0-5** | P0 | recordApproval blocks rejected→approved transition | S8 | In-host `approval.ts:82-83` ALLOWS rejected→approved (user changes mind). Plugin `store.ts:562-565` short-circuits with `kind: "skipped"` when `approval !== "pending"`. Legitimate UI flow (click Reject then Approve) is blocked. | In `src/state/store.ts:recordApproval`, allow transitions from `rejected` (drop the `approval !== "pending"` short-circuit OR exempt `rejected`). Mirror in-host `approval.test.ts:87-96`. | small |
| **A-P0-6** | P0 | approvalRunId never persisted; grant ledger dead | S15, S11 | `PersistApprovalRequestInput` (store.ts:112-125) has NO `approvalRunId` field. Audit emitter's `event.next.approvalRunId` always undefined. `grantLedger.record({...,approvalRunId: undefined})` always omits the field. Grant ledger is functionally a memory leak / dead code — its only correlation field is never populated. `logPlanModeApprovalTransition` likewise never gets a `correlation` arg. | Extend `PersistApprovalRequestInput` with `approvalRunId?: string`. Thread through `exit_plan_mode` tool body. Persist on state. Update audit-emitter wiring at `index.ts:226-271` to pass `correlation: {approvalRunId}`. | medium |
| **A-P0-7** | P0 | plan.edit body NOT sanitized before injection | S9 | `plan.edit` handler accepts body, writes verbatim into `${opener}\n${bodyText}` via `enqueuePlanApprovedInjection`. No `sanitizeFeedbackForInjection` on the body. Adversarial body containing `[PLAN_DECISION]:` closes the envelope and injects decisions next turn. | In `src/runtime/injection-writer.ts:enqueuePlanApprovedInjection`, route `bodyText` through `sanitizeFeedbackForInjection`. Add adversarial test. | small |
| **A-P0-8** | P0 | plan.answer selectedOption + questionPrompt unsanitized | S9 | Same envelope-injection risk as A-P0-7 but for `plan.answer`. selectedOption and questionPrompt bypass `sanitizeFeedbackForInjection`. | In `src/runtime/injection-writer.ts:enqueueQuestionAnswerInjection`, sanitize selectedOption + questionPrompt. Add adversarial test. | small |
| **A-P0-9** | P0 | plan.answer has no pending-question state check | S9 | Plugin's `plan.answer` handler doesn't call `readSnapshot` or verify a question is pending. A stale questionId fires its `[QUESTION_ANSWER]:` injection regardless of state. UI client can answer against a session that has moved on. | Add a pending-question check to `src/ui/session-actions.ts:plan.answer`. Return new error code `NO_PENDING_QUESTION` on mismatch. Test the negative path. | small |
| **A-P0-10** | P0 | Trailing-slash bypass on protected paths | S12 | `normalizeCandidatePath` strips trailing `/`, breaking `startsWith` check. `~/.openclaw/` → `~/.openclaw` → `startsWith("~/.openclaw/")` is false → ALLOWED. Empirically verified. | In `src/gates/accept-edits-gate.ts:normalizeCandidatePath` (line 367-388), preserve trailing slash OR change checkProtectedPath to `startsWith(prefix) \|\| === prefix.replace(/\/$/,"")`. Add positive test for both forms. | small |
| **A-P0-11** | P0 | Quoted command bodies bypass destructive check | S12 | `bash -c "rm -rf /tmp/x"` → ALLOWED (gate sees `bash`, not `rm`). Same for `sh -c`, `zsh -c`. In-host has the same bug, but in-host is layered by plan-mode prompt teaching; plugin ships layer 2 alone. | Add recursion: when toolName ∈ {bash, exec, sh, zsh} AND command starts with one of those + `-c`, extract the quoted body and re-check against destructive patterns. Add test corpus. | medium |
| **A-P0-12** | P0 | Plugin exit_plan_mode does NOT require title | S1 | In-host throws `ToolInputError("exit_plan_mode requires a 'title' field")` since live-test iter-3. Plugin schema marks title Optional and execute() conditionally spreads only when set. Missing fix port. Customer impact: empty/wrong/chat-leaked plan titles persist to markdown filename slug (the exact bug the in-host fix was for). | In `src/tools/exit-plan-mode.ts`, throw `ToolInputError` when title is missing or whitespace-only. Mirror in-host description. Add test. | small |
| **A-P0-13** | P0 | Plugin exit_plan_mode does NOT clamp title to 80 | S1 | In-host: `title = trimmedTitle.slice(0, 80)`. Plugin forwards full raw title to store via `readStringParam`. 200-char title leaks into state.title. | In `src/tools/exit-plan-mode.ts`, add `.slice(0, 80)` after trim. Add boundary test (79/80/81 chars). | small |
| **A-P0-14** | P0 | exit_plan_mode silently drops archetype fields | S1 | Plugin schema declares analysis/assumptions/risks/verification/references; execute() body NEVER reads them; not in details, not persisted. Comment says "P-8 deferral" but no test pins current drop-behavior. | In `src/tools/exit-plan-mode.ts`, port `readPlanArchetypeFields` semantics (trim + drop blank; risks need both `risk` AND `mitigation`). Echo in details and persist. Test against `readPlanArchetypeFields` in-host. | medium |
| **A-P0-15** | P0 | exit_plan_mode output text + status string drift | S1 | In-host: `"Plan submitted for approval — <title> (1 step)."`; plugin: `"Plan submitted for approval (1 step). Waiting for user Approve/Reject."` — drift. Status string convention: in-host `approval_requested` (snake_case) vs plugin `approval-requested` (kebab-case). Model reads this byte string and reshapes its next turn. | Align plugin output text + status conventions byte-for-byte with in-host. Add byte-equality test against in-host source. | small |
| **A-P0-16** | P0 | Plugin tool descriptions diverge from in-host | S1 | Plugin's `TOOL_DESCRIPTION` for both enter_plan_mode and exit_plan_mode is 4-5 line generic text; in-host descriptions have 6-8 load-bearing clauses ("STOP AFTER THIS TOOL CALL", subagent-wait, TOOL LIFECYCLE, bootstrap-reference pointer). Each clause was added as a live-test fix for a documented bug. Drift silently regresses model behavior. | Port `describeEnterPlanModeTool()` / `describeExitPlanModeTool()` outputs verbatim. Add byte-equality test (or substring-presence test for each load-bearing clause). | medium |
| **A-P0-17** | P0 | readStringParam drops snake_case args silently | S1 | In-host uses `readSnakeCaseParamRaw` so `{plan_step, active_form}` work as aliases. Plugin does plain `params[key]` lookup. Model emitting snake_case args (which it often does because tool descriptions teach via examples) has values silently dropped. | In `src/tools/common.ts:readStringParam` (and related helpers), add snake_case fallback via `readSnakeCaseParamRaw` equivalent. Test both forms. | small |
| **A-P0-18** | P0 | sweepExpired's clock-skew NaN propagation | S11 | `Date.now() - entry.recordedAt < 0` (NTP rollback) makes entries appear future-dated and never expire. Forward jump then expires "future-dated" entries that should be live. | In `src/runtime/grant-ledger.ts`, guard against negative deltas (treat as already-expired or refuse-record). | small |
| **A-P1-1** | P1 | recordRejection clears approvalId (parity drift) | S8 | In-host approval.ts:115-124 preserves approvalId across rejected state. Plugin sets `approvalId: undefined`. Rejected state loses cycle identity → stale-event guard breaks for late-arriving signals from another channel. Plugin test 620-622 cements the divergence. | In `src/state/store.ts:recordRejection`, drop the `approvalId: undefined` line. Update test. | small |
| **A-P1-2** | P1 | recordRejection blocks rejected→rejected | S8 | In-host allows re-rejection (no `approval === "pending"` short-circuit). Plugin gates on pending → second reject is SKIPPED. | Allow rejected→rejected in `src/state/store.ts:recordRejection`. Add test. | small |
| **A-P1-3** | P1 | recordRejection lacks `??` defensive guard | S8 | In-host: `(current.rejectionCount ?? 0) + 1`. Plugin: `current.rejectionCount + 1` — would NaN if undefined sneaks in. State always has count today, but defense-in-depth absent. | Add `?? 0` guard. Trivial. | small |
| **A-P1-4** | P1 | timeout path NOT implemented at all | S8 | In-host has timeout transitions. Plugin's `recordTimeout` mutator: missing entirely. `expired`/`timed_out` decision text works in `buildPlanDecisionInjection` but no mutator triggers it. | Either implement `recordTimeout` in `src/state/store.ts` OR document explicit deferral with a TODO comment + spec amendment. | medium |
| **A-P1-5** | P1 | Plugin `decideEscalatingRetry` PLAN_YIELD requires empty text | S7 | In-host fires PLAN_YIELD regardless of text content (checks yieldDetected). Plugin's `!signal.lastAssistantMessage?.trim()` MISSES "Starting execution now" + yield (the canonical post-approval ack-then-yield case). | In `src/runtime/escalating-retry.ts:89-102`, drop the empty-text requirement OR fix the proxy. Add test for "I'll start now" + yield. | small |
| **A-P1-6** | P1 | No grace-window on PLAN_YIELD / PLAN_ACK_ONLY | S7 | In-host has POST_APPROVAL_YIELD_GRACE_MS=2min + POST_APPROVAL_ACK_ONLY_GRACE_MS=5min. Plugin uses stateful `snap.approval === "approved"` with NO time bound. Stale sessions in `approved` state over-fire indefinitely. | Persist `recentlyApprovedAt: number` on state. Gate PLAN_YIELD/PLAN_ACK_ONLY on (now - recentlyApprovedAt) < 2min/5min. | medium |
| **A-P1-7** | P1 | isPlanningNarration uses anchor-only patterns | S7 | Plugin: `^I'll`, `^Let me`, etc. — anchor-only. In-host: `\b\b` word boundaries. Plugin misses "OK, I'll …", "Sure, I'll …", "Got it — I'll …" etc. | In `src/runtime/escalating-retry.ts:153-174`, switch from `^` anchors to `\b` boundaries. Add the missing in-host patterns (`\bi'm going to`, `\bnext`, `\bi can do that`). | small |
| **A-P1-8** | P1 | No completion-cue / blocker-text suppressor | S7 | In-host `PLANNING_ONLY_COMPLETION_RE` suppresses retry when text contains `done|finished|implemented|updated|fixed|changed|ran|verified|found|blocked by`. Plugin missing — fires PLANNING_RETRY on "I'll be brief: I've already verified the schema." | Port `PLANNING_ONLY_COMPLETION_RE` into `src/runtime/escalating-retry.ts`. Add suppressor in `isPlanningNarration`. | small |
| **A-P1-9** | P1 | No provider/contract gate in PLANNING_RETRY | S7 | In-host fires PLANNING_RETRY only for `executionContract === "strict-agentic"` OR Gemini-family. Plugin: no provider gate → all models get retry pressure. Regression risk for Claude/GPT-5 users not on strict-agentic. | Plumb provider/model + executionContract through `decideEscalatingRetry`. Gate PLANNING_RETRY accordingly. | small |
| **A-P1-10** | P1 | No suppression for lastToolError / hadPotentialSideEffects | S7 | In-host suppresses all 3 detectors when previous tool errored or had side effects. Plugin: no analog → fires retry on top of error-recovery responses. | Add suppression checks. Plumb error/side-effect signals through `decideEscalatingRetry`. | small |
| **A-P1-11** | P1 | madeToolCall proxy is single-bit collapse | S7 | Plugin: `madeToolCall = event.stopHookActive === true`. Comment says "we assume." Collapses 5+ orthogonal SDK signals into 1 bit. Yield-with-no-tool-call may set stopHookActive=true → false negative. | Verify `stopHookActive` semantics empirically. Refactor to use multi-bit signal extraction (yield/error/sideEffect/clientToolCall/aborted/timedOut). | medium |
| **A-P1-12** | P1 | Schema-version silent downgrade on write | S15, S14 | `readSnapshot` refuses to read future-version states (good — fail-safe). `persistApprovalRequest` (and `stampSchemaVersion`) silently overwrites future-stamped state with CURRENT. Asymmetric. Mixed-version plugin fleets silently downgrade each other's writes. | Decide policy: (a) `persistApprovalRequest` refuses to write future-version state (returns `kind: "failed"`), OR (b) downgrade is explicitly documented in spec. Either way, add a regression test. | small |
| **A-P1-13** | P1 | Audit/logger throw leaks state-audit inconsistency | S3 | If `audit({...})` throws after the write committed, the outer catch returns `kind: "failed"` but disk has new state. Caller sees `failed` and treats as no-write; state is corrupted. | In `src/state/store.ts:persistApprovalRequest`, catch audit-emitter and logger throws separately (swallow). Add test for both sync + async audit throws. | small |
| **A-P1-14** | P1 | setAutoApprove lazy-init emits spurious audit | S11 | When no plan-mode payload exists, `setAutoApprove({enabled: false})` creates `{mode:normal, autoApprove:false}` payload AND emits an audit (prev=undefined→next={autoApprove:false}). Pollutes log + ledger as if operator toggled something. | Add early-return when `current === undefined && !enabled` (no-op lazy init). Test the negative-disclosure. | small |
| **A-P1-15** | P1 | `__schemaVersion: 99` not refused at write | S14 | `stampSchemaVersion` re-stamps without checking incoming version. Pin policy or refuse. | Decide policy in `src/state/schema-version.ts:stampSchemaVersion`. Add explicit "downgrade or refuse" branch. | small |
| **A-P1-16** | P1 | persistApprovalRequest may write empty lastPlanSteps | S15 | Truthiness guard at store.ts:259-261 (`&& lastPlanSteps.length > 0`) means empty/absent input results in row WITHOUT steps. Re-emit with different hash → rotate path writes empty-steps row. Empty-plan-body race in different form. | Add precondition: empty/absent `lastPlanSteps` → `kind: "skipped", reason: "missing-fields"`. The type already declares this option. | small |
| **A-P1-17** | P1 | Debug-log activation config-key drifts from in-host | S11 | In-host reads `agents.defaults.planMode.debug` (config-level). Plugin reads `pluginConfig.debug` (plugin-level). Operator following in-host runbook (`openclaw config set agents.defaults.planMode.debug true`) toggles host, NOT plugin. | Decide: (a) plugin reads same host config path, OR (b) document the new key in operator-facing README. Add cross-test. | small |
| **A-P1-18** | P1 | Debug-log event-kind taxonomy diverges from in-host | S11 | Plugin renames/reshapes: `tool_call` (lost union), `synthetic_injection` (different fields), `nudge_event`→`nudge_phase`, `subagent_event` (open-string event), `toast_event`→`ui_toast`. Plugin DROPS `approval_event` entirely. Operator runbooks keyed off `[plan-mode/<kind>]` patterns silently fail. | Re-align event taxonomy with in-host. Restore `approval_event`. Restore literal-union discriminators. | medium |
| **A-P2-1** | P2 | DangerousFlags `-ok` / `-okdir` not blocked | S2 | `find -ok cmd ;` and `-okdir cmd ;` execute commands (with prompt) but NOT in DANGEROUS_FLAGS. Real bypass; not in test corpus. | Add `-ok`/`-okdir` to DANGEROUS_FLAGS in `src/gates/mutation-gate.ts`. Add test. | small |
| **A-P2-2** | P2 | DEFAULT_PLAN_MODE_STATE is mutable global | S14 | `DEFAULT_PLAN_MODE_STATE.mode = "plan"` would mutate global default; downstream session creations break in same process. | `Object.freeze(DEFAULT_PLAN_MODE_STATE)` in `src/types.ts`. | small |
| **A-P2-3** | P2 | Tool case-insensitive normalization for find -EXECDIR | S2 | DANGEROUS_FLAGS regex has `i` flag; `cmd.toLowerCase()` already normalizes. Double-protection but uppercase form untested. | Just add positive test. (Not a bug per se but covers a regression target.) | small |
| **A-P2-4** | P2 | DangerousFlags missing dd/sed-i/cp/mv | S12 | Untested negative-disclosure for several commonly-needed but excluded-by-design tools (dd, sed -i, cp, mv, awk -i inplace, etc.). Today safe by default-deny in mutation gate; risky if anyone adds these to read-only prefixes. | Negative-disclosure test corpus for these tools. (Mostly a testing gap, listed here because surfacing it is a deliberate decision.) | small |
| **A-P2-5** | P2 | Lock release on update-throw not asserted | S15 | InMemoryGateway's lock release on inner-callback throw is by `finally { lock?.release() }`. Not directly tested. | Add test: `withLock(async () => { throw })` followed by another `withLock` that succeeds. | small |
| **A-P2-6** | P2 | exit_plan_mode invalid-input throws vs returns | S1 | In-host THROWS ToolInputError; plugin returns soft `details.status: "invalid-input"`. Different error-handling philosophy. Acceptable divergence but not pinned. | Pick one. Either align with in-host (throw) OR document the soft-return contract. Add test for the chosen behavior. | small |

---

## Section 3: Bucket B — Testing gaps

Behavior is correct but untested. No code change to source.

| ID | P | Title (≤60 chars) | Slices | Description | Action | LOC |
|---|---|---|---|---|---|---|
| **B-P0-1** | P0 | No concurrency tests for invariants 5+6 | S3, S15 | The WHOLE POINT of invariants 5+6 is to prevent races. A buggy gateway impl that races without locking is the exact failure mode that motivated the slice. No concurrent persistApprovalRequest test exists; in-memory gateway has zero behavioral coverage. | Add concurrency property tests: 2-4 parallel persistApprovalRequest calls with same/different hashes. Assert one-persisted-others-reused. | medium |
| **B-P0-2** | P0 | SessionStoreGateway has zero behavioral coverage | S15 | `session-store-gateway.test.ts` is 6 shape-only cases (no-throw / class exists / constants match). The production gateway has different lock granularity, different serialization, different patch shape from InMemoryGateway. 84 store invariant tests run on InMemoryGateway only. | Add `tests/integration/session-store-gateway.test.ts` with real temp-file storePath + real `updateSessionStoreEntry` via SDK side-load. Re-run relevant store invariants against both gateways as a parameterized matrix. | large |
| **B-P0-3** | P0 | InMemoryGateway has no dedicated test file | S3 | `tests/state/in-memory-gateway.ts` is a re-export shim. The real implementation at `src/state/in-memory-gateway.ts` has no tests for: serialization, reentrancy deadlock, clone defense, lock release on throw, writeCount accuracy. | Add `tests/state/in-memory-gateway.test.ts` covering all listed properties. | medium |
| **B-P0-4** | P0 | No byte-equality test of archetype prompt vs in-host | S4 | `archetype-prompt.ts:18-20` promises a parity-harness file (`tests/parity/archetype-prompt-parity.test.ts`) that DOES NOT EXIST. Plugin tests use `.toContain` / regex / length-bucket; never byte-equal. A reviewer can paraphrase any paragraph and tests stay green. Prompt-cache silently busts every plan-mode turn. | Add `tests/parity/archetype-prompt-parity.test.ts` that imports in-host text via fs.readFileSync and asserts `expect(plugin).toBe(host)`. Same for reference-card. | medium |
| **B-P0-5** | P0 | No byte-equality test of plan-decision-injection | S8 | Plugin docstring `plan-decision-injection.ts:4-7` says "byte-identical port" but no test imports in-host function and compares outputs. The wording IS the contract per in-host docstring. | Add `tests/parity/plan-decision-injection.parity.test.ts` with table of ~30 input rows through both implementations. Assert byte-equality. | medium |
| **B-P0-6** | P0 | newPlanApprovalId hard-refusal not tested | S14 | Test file explicitly defers ("Requires environment mocking awkward in unit tests"). Source comment says "hard-refuse" is load-bearing — RNG-unavailability fallback is the security boundary. Future refactor swapping the throw for Math.random() ships silently. | Either: (a) inject RNG via constructor (refactor — clean), OR (b) use `vi.stubGlobal('crypto', undefined)` + `vi.doMock("node:crypto")` to assert the throw fires. | small |
| **B-P0-7** | P0 | Manifest-vs-implementation drift NOT tested | S13 | The manifest's `configSchema.properties` declares enabled/planTierModel/planTierProvider. No test cross-checks that EVERY property the manifest declares is consumed by `resolveConfig`. A future PR adding e.g. `autoApproveDefault` without wiring ships silently — LESSONS_LEARNED guardrail #2 failure mode. | Add `tests/manifest-vs-implementation.test.ts` that loads `openclaw.plugin.json`, enumerates `configSchema.properties`, and asserts each is consumed by `resolveConfig`. | small |
| **B-P0-8** | P0 | planTierProvider without planTierModel untested | S6 | If operator sets `planTierProvider: "anthropic"` without `planTierModel`, the entire hook registration is skipped — provider override silently lost. Manifest accepts it. Classic "manifest accepts, runtime ignores" failure. | Add test: `resolveConfig({planTierProvider: "anthropic"})` → either warns or sets to undefined. Update `resolveConfig` to error or warn. | small |
| **B-P0-9** | P0 | Audit-emitter wiring untested end-to-end | S11, S15 | `index.ts:226-271` audit callback (the wiring point that fires debug log + grant ledger + base audit) has no integration test. Documented behavior depends on order of audit→record→prune→debug-log; nothing verifies. | Add `tests/integration/audit-wiring.test.ts` with real PlanModeStore + InMemoryGateway + GrantLedger + captured logger. Run full lifecycle. Assert correlated outputs. | medium |
| **B-P0-10** | P0 | apply_patch with additionalPaths not unit-tested | S12 | `extractApplyPatchTargetPaths` has its own tests, but `checkAcceptEditsConstraint({toolName: "apply_patch", additionalPaths: [...]})` is not directly unit-tested. The fix for Codex #68939 has extraction logic tested but not consumption. | Add table-driven test passing apply_patch + additionalPaths variants through `checkAcceptEditsConstraint`. | small |
| **B-P0-11** | P0 | create/delete tool branches untested | S12 | `PATH_WRITER_TOOLS` includes `create` and `delete`. No test calls `checkAcceptEditsConstraint({toolName: "create"\|"delete"})`. | Add positive tests for both. | small |
| **B-P0-12** | P0 | diskutil erasedisk / eraseall untested | S12 | Coded at gate.ts:96-97. Most destructive macOS primitives have ZERO positive coverage. | Add positive tests. | small |
| **B-P0-13** | P0 | killall openclaw + alternate forms untested | S12 | gate.ts:203 has `\bkillall\b.*\bopenclaw\b/i` with zero positive test. Same for `launchctl unload/stop`, `systemctl stop/kill`, `openclaw config unset`. | Add positive tests for each. | small |
| **B-P1-1** | P1 | No concurrency test for grant-ledger | S11 | Concurrent record + get + prune race; TTL boundary exactly-at-N (strict-greater-than vs ≥). | Add concurrency tests. Add TTL boundary tests at exact ms. | small |
| **B-P1-2** | P1 | Grant-ledger has no upper bound + no abuse test | S11 | Attacker (or buggy approvalId rotation) records 100K unique approvalIds → O(N) memory until TTL sweeps. | Add upper-bound enforcement OR document max. Add abuse test (1M unique ids). | small |
| **B-P1-3** | P1 | Adversarial sanitization table not exercised | S8 | ADV-1..ADV-18 from S8 audit: multi-occurrence regex `/g`, NFC/NFD, soft-hyphen, RTL override, idempotency, etc. All unset. | Add `tests/helpers/sanitize.adversarial.test.ts` with table. | small |
| **B-P1-4** | P1 | rejectionCount boundary table not exercised | S8 | CM-3..CM-17: count===4, ===100, MAX_SAFE_INTEGER, -1, NaN, Infinity, isolation across sessions, persistence across reload, schemaVersion path. | Add table-driven boundary tests. | small |
| **B-P1-5** | P1 | recordApproval prev-state matrix incomplete | S3 | 6 valid prev states for `approval` × 6 next = 36 transitions. Only 6 covered by test (none, pending-reuse, pending-rotate, approved, rejected via C11). Missing: edited, timed_out. | Add `describe.each([...prev]).it("transitions from %s to pending", ...)` matrix. | small |
| **B-P1-6** | P1 | Audit-throw / logger-throw paths uncovered | S3 | If audit({...}) throws after write committed, function returns `kind: "failed"` but disk has new state. Caller sees `failed`; state is corrupted. Discovered by inspection, not test. | Add test for sync + async audit-throw + logger-throw. | small |
| **B-P1-7** | P1 | exit_plan_mode tool description byte-equality | S1 | No test asserts plugin description includes the 8 load-bearing in-host clauses (STOP-AFTER, subagent-wait, TOOL LIFECYCLE, etc.). Even after A-P0-16 fix, no regression net. | Add byte-equality OR substring-presence-each-clause test. | small |
| **B-P1-8** | P1 | enter_plan_mode TOOL_OUTPUT_TEXT byte-equality | S1 | Test E7 only checks 2 substrings. Four-clause structure unpinned. Future maintainer could rewrite the 3rd or 4th clause and E7 stays green. | Replace E7 with full-string equality OR add 4 substring-presence assertions. | small |
| **B-P1-9** | P1 | enter→exit→approve→enter lifecycle untested at tool layer | S1 | Store-level covers each mutator. Tool-level view of state through several cycles not exercised. Idempotent reentry: enter while already in plan mode noop. | Add tool-layer lifecycle test. | small |
| **B-P1-10** | P1 | Plugin reference-card byte-equality vs in-host | S4 | Box-drawing chars `═┌┐│└┘├─▼↻` are easy to corrupt via terminal copy-paste, font substitution, editor's whitespace-trim. No test catches. | Add byte-equality vs in-host text (or full-snapshot). Mirror archetype-prompt test. | small |
| **B-P1-11** | P1 | No __snapshot__ of buildPlanModeSystemContext output | S4 | A single `toMatchInlineSnapshot` would pin every byte. Cheap; catches everything in P0/P1 archetype-prompt drift in one assertion. | Add inline-snapshot test. | small |
| **B-P1-12** | P1 | No test for `before_prompt_build` hook ITSELF | S4 | `api.on("before_prompt_build", ...)` handler is wired but never asserted: returns undefined when sessionKey absent / mode normal / snapshot null. Returns appendSystemContext when mode plan. | Add hook-invocation tests covering all 5 branches. | small |
| **B-P1-13** | P1 | rejectionCount cross-session isolation untested | S8 | No test seeds two sessions and proves a reject on A does not affect B's count. | Add isolation test. | small |
| **B-P1-14** | P1 | ConcurrentReject double-click race untested | S8, S9 | When user double-clicks Reject, first clears approvalId, second hits stale-guard → returns `NO_PENDING_APPROVAL` instead of clear duplicate code. UX bug class but untested. | Add concurrent-reject test; consider new `DUPLICATE_RESOLUTION` code. | small |
| **B-P1-15** | P1 | Cross-action race (accept+reject+cancel) untested | S9 | Four-way race: accept + reject + cancel + auto.toggle fired in rapid succession from buggy UI. Store-level lock serializes; session-action code paths not asserted. | Add 4-way concurrent test against InMemoryGateway. | small |
| **B-P1-16** | P1 | plan.cancel STORE_ERROR path untested | S9 | `cancelAction` has STORE_ERROR branch, never tested. Sweep CLI covers IO; session-action layer doesn't. | Add test. | small |
| **B-P1-17** | P1 | plan.edit error paths nearly all untested | S9 | STALE_APPROVAL_ID, MISSING_SESSION_KEY, NOT_IN_PLAN_MODE, NO_PENDING_APPROVAL, INVALID_PAYLOAD, STORE_ERROR all untested for `plan.edit`. | Add 6 error tests for plan.edit. | small |
| **B-P1-18** | P1 | Sidebar descriptor pluginId field not asserted | S9 | Protocol schema requires `pluginId: NonEmptyString`. Plugin's `buildPlanModeSidebarDescriptor` returns no pluginId. Host may auto-inject; no test verifies registration succeeds against wire schema. | Add contract test that runs descriptor through `PluginControlUiDescriptorSchema`. | small |
| **B-P1-19** | P1 | Stale-event guard NOT enforced at store layer | S8 | Plugin pushes `expectedApprovalId` check OUT to `session-actions.ts:checkApprovalId`. Any caller bypassing session-action layer bypasses the guard. | Plumb `expectedApprovalId` through store mutators OR add layer-2 enforcement test. | medium |
| **B-P1-20** | P1 | stopHookActive semantics not verified empirically | S7 | `madeToolCall = event.stopHookActive === true` is an UNVERIFIED ASSUMPTION. Parity-harness fixture for tool-call/yield/error/stop turns missing. | Add parity-harness fixtures. | small |
| **B-P1-21** | P1 | Hook registration count + order untested | S13 | Future PR adding a hook could double-register the same hook (double-firing). Mock `api` recording `.on()` calls would catch. | Add snapshot test. | small |
| **B-P1-22** | P1 | Plugin's session_start hook reason filter untested | S13 | Hook filters out non-"new" reasons via string compare. No test pins reset/idle/daily/etc. filter behavior. | Add table-driven reason-filter test. | small |
| **B-P1-23** | P1 | SMARTER_CLAW_USE_INMEMORY env var path untested | S13 | Switch reads at register-time; warning fires; gateway type changes. None of these asserted. | Add env-var test. | small |
| **B-P1-24** | P1 | Parity-harness lacks rotate-from-none/edited/timed_out | S3 | `parity-harness/inputs/persistApprovalRequest.json` covers approved/rejected/missing-id/empty-id. Doesn't cover the three most-common rotate cases. | Extend inputs with 3 new cases. | small |
| **B-P1-25** | P1 | Plugin computePlanPayloadHash has no golden-value test | S14 | Plugin computes against a reference impl in test that mirrors source. Both can drift the same way silently. | Add 5-10 hard-coded `expect(hash).toBe("ABCDEF123456")` for known inputs. | small |
| **B-P1-26** | P1 | sessionKey opacity assumption untested | S3, S15 | Gateway uses sessionKey as map key. Untested: contains `:`, `/`, unicode, empty, very long. | Add fuzz/property test. | small |
| **B-P1-27** | P1 | resolveConfig partial-type-pollution paths untested | S13 | Untested: `{enabled: 1\|0}` (truthy/falsy number), `{planTierModel: 42}`, `{planTierModel: [...]}` (array). | Add table-driven negative tests. | small |
| **B-P2-1** | P2 | Stamp idempotency across mutator chains untested | S14 | 100 sequential mutators on same session — should produce exactly one `__schemaVersion: 1`, not 100 nested stamps. Spread shorthand handles correctly but unpinned. | Add test. | small |
| **B-P2-2** | P2 | recordApproval audit emitter call-shape untested | S11 | `recordApproval` audit emits with `prev.approvalId`/`next.approvalId` — should rotate cleanly. No test catches a typo'd `approvalid` field key. | Add explicit assertion on audit call shape. | small |
| **B-P2-3** | P2 | sanitizeFeedbackForInjection idempotency untested | S14 | `sanitize(sanitize(x))` should equal `sanitize(x)`. Pre-sanitized canonical form `[ZWSP/PLAN_DECISION]` doesn't get re-rewritten. | Add idempotency test. | small |
| **B-P2-4** | P2 | sanitize multi-occurrence regex /g flag untested | S8 | `foo[/PLAN_DECISION]bar[/PLAN_DECISION]baz` should produce 2 rewrites. Current tests use single-occurrence. | Add multi-occurrence test. | small |
| **B-P2-5** | P2 | Unicode / homoglyph sanitization untested | S14, S8 | `[/plan_decision]` lowercase (in-host covers, plugin doesn't); fullwidth `［／PLAN_DECISION］` (regex skips, defensible); soft-hyphen `[/PL­AN_DECISION]` (NOT matched — possible envelope break). | Add adversarial sanitization corpus. | small |
| **B-P2-6** | P2 | `additionalProperties: false` on plan[] items untested | S1 | Top-level enforced; nested `plan` items (and `risks` items) unverified. Unknown-key in plan step would silently propagate to lastPlanSteps. | Add additionalProperties test. | small |
| **B-P2-7** | P2 | Unicode / long-string boundary in plan-mode args | S1 | No test for title at 79/80/81 chars; summary 10kb; step text 1MB; reason field long. After A-P0-13 fix lands. | Add boundary tests. | small |
| **B-P2-8** | P2 | Empty-string title behavior unspecified | S1, S3 | `readStringParam` returns undefined for empty string. Whitespace-only behavior in tests covers "  " but not `""`. Plugin spread truthiness preserves prior title. | Add tests for empty-string and whitespace-only. | small |
| **B-P2-9** | P2 | activeForm preservation through persist untested | S3 | `PlanStep.activeForm` optional UI hint. Bundle spread preserves it but no test pins. | Add test asserting activeForm survives persist. | small |
| **B-P2-10** | P2 | toolCallId deterministic propagation untested | S1 | ask_user_question test asserts `q-{toolCallId}` is byte-stable. No equivalent for enter/exit. Same plan via two toolCallIds → same payloadHash. | Add deterministic-output test. | small |
| **B-P2-11** | P2 | Suffix-match priority untested in mutation gate | S2 | `repo.delete.read` is ambiguous; mutation-suffix check fires first. Behavior is correct but only one indirect test. | Add explicit ordering test. | small |
| **B-P2-12** | P2 | Mode-flag tampering case/whitespace untested | S2 | `"Plan"` / `" plan "` / `"PLAN"` / `null` / `undefined` — gate goes dormant on each. Strict-equality is the dominant pattern. | Add invariant assertion test. | small |
| **B-P2-13** | P2 | Hex-byte-escape false-positive untested | S12 | Legitimate `echo "\x72m is part of ascii table"` is blocked. C4 layer's regex is intentionally broad; false-positive rate in real workflows unclear. | Add false-positive corpus + decide policy. | small |
| **B-P2-14** | P2 | Sweep CLI state-variety untested | S9 | Only `approval=pending` tested. Approved/rejected/edited/timed_out states untested with --dry-run. | Add table-driven state-variety tests. | small |
| **B-P2-15** | P2 | `plan.auto.toggle: false` untested at handler | S9 | Single test case is `enabled: true`. Disable path tested at store level only. | Add test. | small |
| **B-P2-16** | P2 | continueAgent unset for auto.toggle untested | S9 | Future change adding `continueAgent: true` to auto.toggle would silently fire turn. | Add explicit "auto.toggle does NOT continue agent" test. | small |
| **B-P2-17** | P2 | Sidebar schema 5 PlanModeSessionState fields missing | S9 | Schema covers 9 of 14 fields. Missing: enteredAt, confirmedAt, updatedAt, lastPlanPayloadHash, approvalRunId. | Decide: extend schema OR document omissions in test. | small |
| **B-P2-18** | P2 | xargs / awk / dd / cp / mv / sed -i untested | S2 | Safe by default-deny but no negative-disclosure test. A future addition of any to read-only prefixes would silently break the contract. | Add negative-disclosure corpus. | small |

---

## Section 4: Bucket C — Feature parity

Feature missing or incomplete vs in-host. Bigger scope than a bug fix; new code to add a feature surface.

| ID | P | Title (≤60 chars) | Slices | Description | Action | LOC |
|---|---|---|---|---|---|---|
| **C-P0-1** | P0 | ACTION CONTRACT block missing from system prompt | S4 | In-host `attempt.ts:692-701` injects 5-paragraph ACTION CONTRACT between header and hard rules (LOGS guidance, "ack-without-tool-call = defect" framing, etc.). Plugin's `buildPlanModeSystemContext()` SKIPS entirely. Major byte-diff vs in-host. Degrades steering. | Port the ACTION CONTRACT block into `src/prompt/plan-mode-injection.ts:buildPlanModeSystemContext()`. Test against in-host text. | medium |
| **C-P0-2** | P0 | auto-enable.ts (regex-pattern auto-toggle) not ported | S4 | In-host: 96 LOC + 5 test groups for auto-enabling plan mode when model id matches operator-config regex (`^openai/gpt-5\.` etc.). Per CLAUDE.md, Eva uses GPT-5.4 and plan-mode auto-on was a key affordance. Plugin tree has ZERO impl. Operator config knob silently inert. | Port `auto-enable.ts` from in-host. Wire into session_start hook. Replicate 5 test groups. | large |
| **C-P0-3** | P0 | PLAN MODE AVAILABLE branch not ported | S4 | In-host emits ~12-line block when `enabled=true` but mode != "plan", instructing agent to call `enter_plan_mode`. Plugin returns undefined → agent never sees the discovery prompt. Fresh installs miss plan-mode entry point. | Port AVAILABLE block into `src/prompt/plan-mode-injection.ts`. Wire into `before_prompt_build` for the `mode === "normal" && config.enabled` case. Test. | medium |
| **C-P0-4** | P0 | subagent gate missing entirely | S1 | In-host exit_plan_mode enforces 4-distinct-guards on runId/ctx/open/openCount, throws ToolInputError with corrective text, lists pending child IDs, enforces SUBAGENT_SETTLE_GRACE_MS wait window. Plugin: zero gate. | Port `subagent-gate.ts` from in-host. Wire into `src/tools/exit-plan-mode.ts`. Add `cycleId` and `blockingSubagentRunIds` fields to `PlanModeSessionState`. | large |
| **C-P0-5** | P0 | Pending-injection writer side not ported | S4 | Plugin's `pending-injections.ts` only ports READ-side composer + type table. Missing: `enqueuePendingAgentInjection`, `consumePendingAgentInjections`, `sortAndCapQueue`, `migrateLegacyPendingInjection`, `upsertIntoQueue`, `filterExpired`. These are the seams the host runtime uses to actually queue `[PLAN_DECISION]`, `[QUESTION_ANSWER]`, `[PLAN_COMPLETE]` into next agent turn. | Port the 6 functions from in-host. Wire into session-action handlers. Port 11 in-host test groups. | large |
| **C-P0-6** | P0 | Inline plan-approval card not ported (deferred) | S9 | In-host: `renderInlinePlanApproval` mounts above input bar with title strip + Accept/Edit/Revise buttons; hides input bar; PR-10 `renderInlineQuestion` variant for ask_user_question. Plugin: deferred to P-final pending upstream `chat-input-bar` Control UI surface. | After `openclaw/openclaw#80982` merges: register 3rd `PluginControlUiDescriptor` with `surface: "chat-input-bar"`. No new actions needed. Test descriptor shape + negative-firing on legacy SDK. | medium |
| **C-P0-7** | P0 | Mode-switcher chip not ported (deferred) | S9 | In-host renders pill/chip + dropdown w/ 6 entries (Default/Ask/Accept/Plan/Plan-auto/Bypass) + Ctrl+1..6 shortcut handler. Plugin: deferred. | After PR-80982 merges: register `surface: "chat-header-chip"` descriptor + `mode.set` session-action + `store.setMode` mutator. Resolve dropdown-ownership question (host renders + plugin contributes Plan/Plan-auto entries). | large |
| **C-P0-8** | P0 | Plan-event cards in message stream not ported (deferred) | S9 | In-host renders informational expandable cards in chat-stream when plan events flow. Plugin: deferred. | After PR-80982 merges: register `surface: "chat-message"` descriptor with `activeWhen: {sessionExtensionNamespace: "plan-mode", valuePath: "lastPlanSteps"}`. Host renders. | small (post-merge) |
| **C-P0-9** | P0 | Turn-limit watchdog not ported (deferred) | S6 | In-host enforces max consecutive plan-mode turns, auto-exits via `exitPlanMode`. Plugin: NOT IMPLEMENTED. Per audit S6: ACCEPTABLE to defer for v1.0 IF sidebar UI surfaces `rejectionCount` AND S4 deescalation hint at >=3 fires. Both need confirmation. | Implement turn counter persistence + threshold-trigger via `registerSessionSchedulerJob`. Or: confirm sidebar UI + deescalation prerequisites are met and defer + document. | medium |
| **C-P0-10** | P0 | Escalating retry: STANDARD→FIRM→FINAL not ported | S7 | In-host has 3-level escalation per detector. Plugin returns same fixed instruction per attempt. Agent sees same 200-byte string 3 times; gain rapidly approaches zero. | Add escalation-by-attempt-index to `src/runtime/escalating-retry.ts`. Port in-host instruction texts. | medium |
| **C-P0-11** | P0 | Empty-response retry detector outside post-approval not ported | S7 | In-host `resolveEmptyResponseRetryInstruction` fires when agent produced literally nothing. Plugin subsumes under PLAN_YIELD ONLY when post-approval. Normal + empty + no-tool-call + not-post-approval = silent stall, no retry. | Port `EMPTY_RESPONSE_RETRY_INSTRUCTION` detector. Wire as 4th detector in `escalating-retry.ts`. | medium |
| **C-P0-12** | P0 | Reasoning-only retry detector not ported | S7 | In-host `resolveReasoningOnlyRetryInstruction` fires when provider-side reasoning failure produced reasoning but no answer. Plugin: NONE. SDK's empty-response handling may own this — if not, silent gap. | Decide: rely on SDK OR port the detector. Verify via empirical SDK test. | medium |
| **C-P1-1** | P1 | TOOL displaySummary missing on both tools | S1 | In-host sets `displaySummary` on enter_plan_mode + exit_plan_mode (used by sidebar/sessions list UI). Plugin's tool objects don't. UI surfaces render empty. | Add `displaySummary` constants in plugin tool defs. Mirror in-host text. | small |
| **C-P1-2** | P1 | logPlanModeDebug + exitPlanGateLog emissions absent | S1 | In-host emits `logPlanModeDebug({kind:"tool_call",...})` + `exitPlanGateLog.info(...)` on tool execute. Plugin: none. | Wire `logPlanModeDebug` calls into enter/exit tool execute paths. | small |
| **C-P1-3** | P1 | Hook-integration test for mutation-gate wiring missing | S2 | Gate function tests well; hook-wiring layer at `src/index.ts:332-383` has NO mutation-gate.test.ts coverage. Parameter extraction (params.command \|\| params.cmd) + mode-resolution (ctx.getSessionExtension \|\| store.readSnapshot) is the actual production security boundary. | Add `tests/index.before-tool-call.test.ts` that injects a fake `before_tool_call` event and verifies block-on-mode. | medium |
| **C-P1-4** | P1 | composePromptWithPendingInjections not wired to before_prompt_build | S4 | Plugin's hook returns only `{appendSystemContext: buildPlanModeSystemContext()}`. There's no path from "[QUESTION_ANSWER] got queued" to "next turn's user prompt has injection prepended". Function exists but has no callers. | Wire `composePromptWithPendingInjections` into `before_prompt_build` (via `prependUserPrompt` or equivalent SDK seam). Read queue. | medium |
| **C-P1-5** | P1 | recentlyApprovedAt + grace windows not ported | S7, S15 | See A-P1-6. Listed here as feature-parity because the data field doesn't exist on `PlanModeSessionState`. | Add `recentlyApprovedAt: number` to state type. Persist on recordApproval. Gate PLAN_YIELD/PLAN_ACK_ONLY on it. | medium |
| **C-P1-6** | P1 | resumePendingPlanInteraction analog missing | S9 | In-host fires a hidden `chat.send` with `deliver: false` + `plan-resume-<uuid>` idempotencyKey after approval/answer persisted. Plugin trusts host's drain loop to continue. May or may not be enough. | Investigate: does SDK's `enqueueNextTurnInjection` actually drain? Add test. If gap, port `resumePendingPlanInteraction` analog. | small (if needed) |
| **C-P1-7** | P1 | cycleId + blockingSubagentRunIds not on state | S1, S15 | In-host `persistPlanModeEnter` initializes `cycleId: randomUUID()` (gate-state-unavailable fix). `blockingSubagentRunIds` used as fallback when parentCtx is missing. Plugin doesn't model either. When subagent integration lands, persisted state won't match what gateway expects. | Add both fields to `PlanModeSessionState`. Set in `enterPlanMode`. Used by C-P0-4 subagent gate port. | small |
| **C-P1-8** | P1 | Audit logger contract: meta as second arg | S11 | In-host's `logger.info("[plan-mode/<kind>]", metaObj)` (structured-logger pattern). Plugin: single-string concat. Logs not bit-compatible with in-host — log-scraping scripts fail. | Update `src/runtime/debug-log.ts` to emit meta as second arg. May require PluginLogger interface extension. | small |
| **C-P1-9** | P1 | __schemaVersion bumped to v2 plan | S14 | Type currently allows additive-only v1.x. Future feature work (e.g. timeout mutator, approvalRunId) may justify v2. No migration plan documented. | Document v2 migration plan + add forward-compat readSnapshot test. | small |
| **C-P1-10** | P1 | Provider-aware planTierProvider routing | S6 | Today's hook returns `{modelOverride, providerOverride?}`. Routing depends on SDK seam. Untested. | Add provider routing test that asserts the SDK respects `providerOverride`. | small |
| **C-P1-11** | P1 | Manifest minHostVersion + peerDep consistency | S13 | minHostVersion + peerDep both `"2026.5.10-beta.5"`. No CI test that they stay in sync. | Add `release-readiness-preflight` check (per skill) to assert. | small |
| **C-P1-12** | P1 | files array in package.json untested | S13 | Adding `scripts/install-chat-stream-seam-v2.mjs` without updating `files` → published tarball missing it. | Add CI step that asserts `files` includes all `scripts/*.mjs`. | small |
| **C-P1-13** | P1 | Sub-agent propagation undocumented/untested | S4, S15 | When parent agent calls `sessions_spawn`, subagent's prompt is built independently. Does `before_prompt_build` fire for subagents? If yes: subagent gets archetype but ISN'T bound by mutation gate (session-scoped). If no: subagent sees no plan-mode prompt. | Document the chosen behavior. Add tests for both branches. | small |
| **C-P1-14** | P1 | sweep CLI batch-mode (`--all-sessions`) deferred | S9 | Explicitly deferred per `src/ui/sweep-command.ts:13-19`. Audit notes operator pain. | Defer to v1.1+ with explicit comment in commander config. | small (defer) |
| **C-P1-15** | P1 | Sanitization at session-action boundary | S9 | `plan.edit body`, `plan.answer selectedOption + questionPrompt` need sanitization at the session-action boundary, not just in the injection-writer. Defense in depth. | Apply A-P0-7 + A-P0-8 at session-action layer too. | small |
| **C-P1-16** | P1 | timeout state machine + recordTimeout | S8 | See A-P1-4 — feature-parity entry. | Implement `recordTimeout` mutator + timeout injection text + test. | medium |
| **C-P2-1** | P2 | non-English narration support in retry detector | S7 | In-host has `ACK_EXECUTION_NORMALIZED_SET` for Arabic/German/Japanese/French/Spanish/Portuguese/Korean. Plugin: English only. Non-English users get strictly worse experience. | Port set. Use in PLANNING_RETRY normalization. | medium |
| **C-P2-2** | P2 | Structured-plan format detection (headings/bullets) | S7 | In-host `PLANNING_ONLY_HEADING_RE` + `PLANNING_ONLY_BULLET_RE` + `hasStructuredPlanningOnlyFormat`. Plugin missing — falls back to anchor patterns, misses bullet/heading plans. | Port regex set + detection function. | small |
| **C-P2-3** | P2 | single-action-then-narrative pattern detection | S7 | In-host `SINGLE_ACTION_EXPLICIT_CONTINUATION_RE` + `SINGLE_ACTION_MULTI_STEP_PROMISE_RE`. Plugin doesn't have. | Port if subagent-integration needs it. Otherwise defer. | small |
| **C-P2-4** | P2 | Extract plan-details from narration | S7 | In-host `extractPlanningOnlyPlanDetails` extracts steps from assistant narration for UI surfacing (auto-plan-write). Plugin: nothing. | Defer to v1.x. | small (defer) |
| **C-P2-5** | P2 | resolveIncompleteTurnPayloadText analog | S7 | In-host emits user-visible "⚠️ Agent couldn't generate a response" when agent abandoned. Plugin: relies on SDK. | Decide via empirical test. If SDK doesn't surface, add minimal "stalled" UI. | small |
| **C-P2-6** | P2 | `xargs rm`, `find -ok`, `find -okdir` block | S2 | A-P2-1 listed `-ok`/`-okdir`. `xargs rm` is more nuanced — not in any list. | Add `-ok`/`-okdir` (already in A-P2-1). Decide: add `xargs` to a "needs-check" list. | small |
| **C-P2-7** | P2 | Mutation-gate hook integration test | S2 | See C-P1-3 — same target. | (Listed only for completeness; same action.) | n/a |
| **C-P2-8** | P2 | macOS realpath canonicalization in protected-path check | S12 | `/private/etc/openclaw/*` (macOS canonical) bypasses prefix list. Tool that uses `realpath` before passing to gate emits canonical form. | In `normalizeCandidatePath`, add explicit `/private/etc` → `/etc` mapping (or canonicalize via Node fs). Add test. | small |
| **C-P2-9** | P2 | Sudo / wrapper-prefix strip in destructive prefix check | S12 | `sudo rm -rf /`, `command rm`, `time rm`, `exec rm`, `/bin/rm` all bypass prefix anchor. | In `matchExecPrefix`, strip leading `sudo`/`doas`/`command`/`exec`/`time` wrapper. Recognize absolute paths (`/bin/rm`). Add test corpus. | medium |
| **C-P2-10** | P2 | Command-chain tokenization in destructive check | S12 | `ls && rm -rf` and `ls; rm` bypass — gate matches start-of-string. | In `checkAcceptEditsConstraint`, tokenize cmd on `&&`/`;`/`\|` BEFORE prefix match. Re-check each segment. Add test corpus. | medium |

---

## Section 5: Cross-cutting themes

Patterns that appear across multiple slices.

### Theme T1 — "No byte-equality oracle for in-host parity"

**Surfaces in**: S3 (parity harness uses port-of-port), S4 (no archetype/reference-card byte-equality), S8 (no plan-decision-injection parity), S1 (no tool description byte-equality), S2 (control-flow parity asserted but reason-text only "semantically equivalent"), S12 (gate algorithm byte-clean but no programmatic verification), S15 (gateway port).

**Root cause**: The plugin docs make "byte-identical port" claims that no test enforces. The closest is `parity-harness/host-reference.ts` — itself a manual port, not a sym-link of in-host code. README warns about this; nothing prevents drift.

**Recommendation**: A **single repository-level parity skill**: read in-host source files directly via `fs.readFileSync(LEXAR_PATH + "/src/.../X.ts", "utf-8")`, parse them, assert plugin equivalents are byte-identical (or substring-presence for known-stable clauses). Replace `host-reference.ts` with this approach. Run on every CI build. Estimate: 1-2 days; pays for itself by closing 8+ findings across A-P0-15, A-P0-16, B-P0-4, B-P0-5, B-P1-7, B-P1-8, B-P1-10.

### Theme T2 — "InMemoryGateway-only test coverage"

**Surfaces in**: S3 (100% store tests), S6 (plan-tier-model), S7 (escalating-retry), S8 (rejection cycle), S11 (debug log), S15 (gateway itself).

**Root cause**: Eva live-smoke harness sets `forceInMemory: true` by default to avoid file IO in CI. SessionStoreGateway has 0% runtime coverage; the production race-fix surface (filesystem lock + skipCache + mergeSessionEntry) is unverified.

**Recommendation**: Add `tests/integration/` directory exercising real SessionStoreGateway against a temp-file storePath. Re-run a subset of store invariants as a parameterized matrix. Closes B-P0-2 + B-P0-3 + parts of S15 confidence gap.

### Theme T3 — "Single-bit signal proxies (madeToolCall, autoApprove)"

**Surfaces in**: S7 (madeToolCall is single-bit proxy of 5 SDK signals), S12 (trigger predicate is single-bit proxy of postApprovalPermissions.acceptEdits).

**Root cause**: Plugin's interface to host signals is collapsed via SDK abstraction. The plugin doesn't have access to clientToolCall / yieldDetected / didSendDeterministicApprovalPrompt / didSendViaMessagingTool / lastToolError / replayMetadata.hadPotentialSideEffects.

**Recommendation**: Map each missing signal to a SDK property OR document the loss and add a regression test that the plugin's coarse signal works in the dominant case + fails-safe in the edge case.

### Theme T4 — "Manifest accepts but runtime no-ops"

**Surfaces in**: S6-G1 + S6-G4 (planTierProvider without planTierModel), S13-G1 (manifest-vs-impl drift), S13-G14 (SMARTER_CLAW_USE_INMEMORY env var untested), S13-G18 (advisory log-only / no user surfacing).

**Root cause**: LESSONS_LEARNED guardrail #2 fail mode. Manifest schema is permissive; implementation reads only some fields; no automated cross-check.

**Recommendation**: One test file (`tests/manifest-vs-implementation.test.ts`) that loads the manifest, enumerates `configSchema.properties`, and asserts each is read by `resolveConfig` (regex of source-code AST). Foundation-tier finding.

### Theme T5 — "Operator visibility gap"

**Surfaces in**: S11 (event-kind taxonomy diverges from in-host; activation key drifts), S13 (advisory log-only / no surface), S9 (sweep CLI behavior unclear in edge states), S6 (plugin downgrade silently disables every plan-mode feature with no user signal).

**Root cause**: Plugin emits debug logs and audits, but the formats / event-kinds / config-keys all diverged from in-host. Operator runbooks won't work. Forward-compat soft-refusal is invisible to users.

**Recommendation**: Pick ONE: (a) align debug-log emission format byte-for-byte with in-host (closes 4 P1 gaps in one shot), OR (b) document new plugin-specific format in operator-facing README + provide migration script. Either way, a test asserting the chosen format.

### Theme T6 — "Architectural concern: thick-tool-body vs thin-runner"

**Surfaces in**: S1 (in-host tool body is "thin"; plugin's is "thick" with state-mutation). S2 (mutation gate is in-line in plugin's own handler vs in-host's pi-tools.before-tool-call.ts hook). S12 (same).

**Discussion**: In-host pattern is "tool returns structured result, runner intercepts to fire approval events + apply state transitions via `persistPlanApprovalRequest`". Plugin pattern is "tool body directly calls `PlanModeStore.persistApprovalRequest`". Tradeoffs:
- Pro plugin: simpler control flow, fewer cross-process surfaces, single transaction.
- Con plugin: less testable in isolation; tool can't be reused without store dependency.

Not a bug; document the architectural choice in `architecture-v2/`. Add a note to the canonical spec doc when restored.

---

## Section 6: Recommended sequencing

### Critical path: Wave-1 fix-it order (must land before any live-test)

1. **A-P0-1** Trigger predicate divergence (silent-bypass) — S12 — load-bearing
2. **A-P0-2..A-P0-5** recordApproval 4-way parity drift — S8 — locked-in tests cement broken behavior; fix BEFORE adding tests
3. **A-P0-6** approvalRunId never persisted — S15+S11 — grant ledger is dead
4. **A-P0-7..A-P0-9** Sanitization gaps on plan.edit/plan.answer — S9 — envelope injection surface
5. **A-P0-10..A-P0-11** Trailing-slash + quoted-body bypass — S12 — accept-edits gate hardening
6. **A-P0-12..A-P0-17** exit_plan_mode tool fix + tool description ports — S1 — model-facing prose drift
7. **A-P0-18** Grant-ledger clock skew — S11 — small but high-yield

### Wave-1 finishing (after critical path)

- **B-P0-4..B-P0-7** Byte-equality + parity harness tests (block silent drift)
- **B-P0-9** Audit-emitter wiring integration test
- **B-P0-10..B-P0-13** Untested coded patterns
- **C-P0-1** Port ACTION CONTRACT block
- **C-P0-9** Decide turn-limit watchdog (defer or implement)

### Wave-2 audit-target candidates (what to look at next)

- **Subagent integration** — once C-P0-4 (subagent gate) ports, audit the full sessions_spawn + parent-child correlation surface.
- **SDK seam diffs** — re-audit AUDIT-E (sdk-seam-parity) against patches/openclaw-2026.5.10-beta.5 after PR-80982 merges. Specific focus: chat-stream surfaces.
- **Live-host integration** — once B-P0-2 lands (SessionStoreGateway tests), audit the full real-host write path including archive/rotate/mergeSessionEntry side effects.
- **`enqueueNextTurnInjection` failure path** — Wave-1 found this is unexercised. Wave-2 should drive a full failure-mode taxonomy.
- **Auto-mode lifecycle** — port C-P0-2 first; Wave-2 audits the regex-matching + cache-stability + cross-session-isolation surface.

### Items safe to defer to v1.0+

- **C-P1-14** sweep CLI `--all-sessions` batch mode — explicit deferral
- **C-P2-1..C-P2-5** non-English narration, structured-plan format, single-action pattern, plan-details extraction, incomplete-turn payload text — escalating-retry feature gaps; ship after dominant-language path verified
- **C-P0-7..C-P0-8** Mode-switcher chip + plan-event cards in chat stream — blocked on upstream PR-80982
- **C-P0-9** Turn-limit watchdog — conditional defer (S4 deescalation hint + S9 sidebar rejectionCount surface must verify first)
- **B-P2-1..B-P2-18** P2 testing gaps — defense-in-depth; ship after P0/P1 land

---

## Section 7: Confidence + open questions

### Per-slice confidence scores

| Slice | Confidence | Notes |
|---|---:|---|
| S1 enter/exit tools | 78% | Per-author note: 22% uncertainty in deferred-by-design vs regression classification |
| S2 mutation-gate + S10 exec allowlist | 82% (P=18% bypass) | Algorithm byte-clean; hook-wiring + integration weakest |
| S3 persistApprovalRequest | 55% | Concurrency + audit-throw + schemaVersion paths uncovered |
| S4 + S5 prompt + archetype | 55% | Static content byte-clean; no byte-equality tests; ACTION CONTRACT absent |
| S6 + S13 + S14 foundation | 90% / 95% | High; weak on hard-refusal coverage + canonical-spec doc |
| S7 escalating retry | 38% | Lowest — plugin retains ~30% of in-host semantics |
| S8 rejection UX | 65% | 4 P0 parity divergences in recordApproval locked in by passing tests |
| S9 UI surfaces | 70% | Sidebar well-scoped; sanitization at boundary + cross-action races weak |
| S12 accept-edits | (P=80% bypass) | Trigger predicate divergence is THE highest-leverage finding across all 10 reports |
| S15 + S11 persistence + ledger | 62% | SessionStoreGateway has 0% behavioral coverage; approvalRunId dead |

### Cross-cutting open questions (not answered from the 10 reports)

1. **Does the trigger-predicate divergence actually manifest at live-gateway level?** S12 audit says "verified empirically with /tmp probes" — but the probes test the gate function in isolation, not the full host→plugin path. **A live-host integration test for plain-Accept + rm-rf is needed before treating A-P0-1 as fully scoped.**

2. **Does the SDK's `updateSessionStoreEntry` actually pass `skipCache: true`?** S15 audit relies on this being inherited verbatim. If the SDK ever degrades, the race returns silently. **Needs a parity test that introspects the SDK function.**

3. **Does `before_prompt_build` fire for subagent prompts (sessions_spawn children)?** S4 audit raises this; behavior is undocumented. **Needs an empirical test once subagent integration ships (C-P0-4).**

4. **What's the SDK's actual `event.stopHookActive` semantics?** S7 audit treats it as a guess. **Needs parity-harness fixture testing tool-call/yield/error/clean-stop scenarios.**

5. **Is the cycleId / blockingSubagentRunIds gap (S15) load-bearing for S15?** The gateway-side approval gate uses these as fallback when parentCtx is missing. **Needs verification that S15 isn't already planning to introduce them via a different mechanism.**

6. **Did the in-host's "plain Accept" path actually behave the way S12 says it did?** S12 audit cites `fresh-session-entry.ts:104-119` for the live-disk read of `postApprovalPermissions.acceptEdits`, but doesn't confirm what code sets that field on plain Accept (vs Accept-with-edits). Needs verification by reading the in-host UI accept-button handler.

7. **Are the in-host's debug-log event-kind names (`approval_event`, `nudge_event`, `toast_event`) actually used by any operator runbook today?** S11 audit assumes they are. If not, the divergence is benign and B-P1-18 / A-P1-18 can drop to P2.

8. **Is the auto-enable.ts port (C-P0-2) actually blocked, or just deprioritized?** Per CLAUDE.md it was a key product affordance. Needs explicit decision: ship in Wave-1 or defer to v1.1.

---

**End of consolidated plan.**
