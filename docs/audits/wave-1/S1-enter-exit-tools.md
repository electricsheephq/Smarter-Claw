# Wave-1 Audit — Slice S1: enter_plan_mode + exit_plan_mode (F1)

**Auditor**: A8 (Wave-1 read-only first-principles testing-gap analysis)
**Scope**: `enter_plan_mode`, `exit_plan_mode` tools + their plugin ports.
**Mode**: Read-only. No code edits. Bugs/gaps documented for downstream wiring.

---

## 1. Slice summary

S1 covers the two model-facing tools that drive the plan-mode state machine:

- **`enter_plan_mode`** — flips a session into plan mode. Mutation gate then starts blocking write/edit/exec/etc. Read-only tools (read, web_search, update_plan) remain available.
- **`exit_plan_mode`** — submits the proposed plan for user Approve / Reject. Mints an approvalId, computes a payloadHash, persists `lastPlanSteps + title + approvalId + payloadHash` synchronously (this is the race-fix anchor commit `1081067476`).

**In-host vs plugin port — locus of mutation differs:**
- In-host: the tool body has *no* side effects — it just returns a structured result, and the embedded runner intercepts the tool call to fire approval events + apply state transitions via `persistPlanApprovalRequest` in `pi-embedded-subscribe.handlers.tools.ts:130-237`.
- Plugin: there is no runner — the tool body itself calls `PlanModeStore.enterPlanMode()` / `PlanModeStore.persistApprovalRequest()`.

This is a meaningful architectural difference (the plugin's tool body is "thick" where the in-host's is "thin"), which broadens the parity surface for these two files.

**Files reviewed**:
- In-host source: `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/tools/enter-plan-mode-tool.ts`, `exit-plan-mode-tool.ts`
- In-host related: `tool-description-presets.ts`, `update-plan-tool.ts` (PLAN_STEP_STATUSES), `common.ts`, `param-key.ts` (snake_case aliasing)
- In-host tests: `exit-plan-mode-tool.test.ts` (subagent gate + archetype fields), `plan-mode/integration.test.ts` (enter/exit smoke), `ask-user-question-tool.test.ts`
- Plugin port: `/Users/lume/repos/Smarter-Claw/src/tools/enter-plan-mode.ts`, `exit-plan-mode.ts`, `common.ts`, `ask-user-question.ts`
- Plugin state: `src/state/store.ts`, `src/state/in-memory-gateway.ts`, `src/helpers/payload-hash.ts`, `src/helpers/approval-id.ts`, `src/types.ts`
- Plugin tests: `tests/tools/enter-plan-mode.test.ts` (9 tests), `tests/tools/exit-plan-mode.test.ts` (16 tests)

---

## 2. Tool contracts

### 2.1 `enter_plan_mode`

| Surface | In-host | Plugin |
|---|---|---|
| Tool name | `enter_plan_mode` | `enter_plan_mode` |
| Label | `Enter Plan Mode` | `Enter Plan Mode` |
| Schema | `{ reason?: string }` with `additionalProperties: false` | `{ reason?: string }` with `additionalProperties: false` |
| displaySummary | `ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY` ("Enter plan mode — block mutation tools until the user approves a plan.") | **MISSING** — plugin tool object never sets `displaySummary` |
| description | `describeEnterPlanModeTool()` — long-form 6-paragraph contract including LIFECYCLE block + plan-mode reference pointer | **Custom 5-line description** — does NOT match host text |
| Output text | 4-sentence multi-clause; tells model "Plan mode is now active. Next required step: investigate read-only ... call exit_plan_mode ..." | Plugin's `TOOL_OUTPUT_TEXT` constant — **string content matches in-host text byte-for-byte** |
| State transition | No side effect from tool body. Runner intercepts. | Tool body calls `PlanModeStore.enterPlanMode({sessionKey, reason})` |
| `details.status` | `entered` (always) | `entered` (fresh write) OR `already-in-plan-mode` (noop) OR `failed` OR `no-session` |
| `details.mode` | `"plan"` | `"plan"` |
| `reason` echo | Echoed in details only when trimmed-non-empty | Same |
| Error path | None — runner handles persistence | Soft-error returns (NOT throws): `no-session` when sessionKey unresolved; `failed` when store throws |

### 2.2 `exit_plan_mode`

| Surface | In-host | Plugin |
|---|---|---|
| Tool name | `exit_plan_mode` | `exit_plan_mode` |
| Label | `Exit Plan Mode` | `Exit Plan Mode` |
| displaySummary | `EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY` ("Exit plan mode and request user approval of the proposed plan.") | **MISSING** — never set |
| Schema | `{ title?, plan, summary?, analysis?, assumptions?, risks?, verification?, references? }` — top-level NO `additionalProperties: false` declaration | Same fields + **top-level `additionalProperties: false`** |
| `plan` array | `minItems: 1`, items have `additionalProperties: false` | Same |
| `risks[]` items | `additionalProperties: false` | Same |
| description | `describeExitPlanModeTool()` — 8-clause long-form including "STOP AFTER THIS TOOL CALL", required title note, subagent-wait warning, full TOOL LIFECYCLE | **Custom 5-line description** — short; **omits all the agent-steering nudges that were demonstrably load-bearing** ("STOP AFTER THIS TOOL CALL", subagent-wait warning) |
| Output text on success (1 step) | `"Plan submitted for approval — <title> (1 step)."` | `"Plan submitted for approval (1 step). Waiting for user Approve/Reject."` — **DRIFTS from host** (uses parenthetical with title only when present; appends "Waiting for user Approve/Reject" in plugin) |
| Title requirement | **REQUIRED** — throws `ToolInputError` "exit_plan_mode requires a `title` field" when missing or whitespace-only | **OPTIONAL** — plugin accepts no-title, no-throw, persists no-title state |
| Title clamp | `slice(0, 80)` | **NOT clamped** — full string forwarded to store |
| Plan validation | `readPlanSteps` throws `ToolInputError` on empty/missing plan, invalid status, multi-in_progress (THROWS — propagates) | Same validation logic, but plugin wraps in try/catch and returns soft `details.status: "invalid-input"` instead of throwing |
| in_progress cap | At most 1 — throws | Same |
| activeForm | Optional pass-through | Same |
| Archetype fields | Parsed via `readPlanArchetypeFields` — trim + drop blank; risks need both `risk` AND `mitigation` non-blank; outputs conditional-spread in details | **NOT parsed** — plugin schema accepts them but tool body **discards them entirely** (doesn't read or forward) — silent loss of agent intent |
| payloadHash | SHA-1, `{t, s, steps}` JSON, 12-char prefix | Same (parity-contract'd in `helpers/payload-hash.ts`) |
| approvalId mint | Implicit — minted by runner | Tool body mints via `newPlanApprovalId()` |
| Subagent gate | In-host enforces 4 distinct guards on `runId`/`ctx`/`open`/`openCount`; throws ToolInputError with corrective text + lists pending child IDs; also enforces SUBAGENT_SETTLE_GRACE_MS wait window | **NOT in plugin** — no subagent gate at all |
| Result details | `{status: "approval_requested", title?, summary?, plan, payloadHash, analysis?, assumptions?, risks?, verification?, references?}` | `{status: "approval-requested" \| "duplicate-detected" \| "not-in-plan-mode" \| "failed" \| "no-session" \| "invalid-input", approvalId, payloadHash, stepCount, title?, summary?}` — **diverges substantially** |
| Status string convention | `approval_requested` (snake_case) | `approval-requested` (kebab-case) — **drift** |
| Debug logging | `logPlanModeDebug({kind:"tool_call",...})` + `exitPlanGateLog.info(...)` emit always | None |

### 2.3 State machine

```
enter_plan_mode:
  none/normal → plan + approval=none + rejectionCount=0 + enteredAt=now
  plan        → plan (noop, no extra write — invariant: writeCount unchanged)

exit_plan_mode:
  Precondition: mode === "plan"   (else: skipped/not-in-plan-mode)
  current.lastPlanPayloadHash === payloadHash AND
    current.approval === "pending" AND
    current.approvalId is a non-empty string
    → REUSE existing approvalId (audit skipped)        [Invariant 3+7+9]
  else
    → WRITE { approval: "pending", approvalId: candidate, title, payloadHash, lastPlanSteps } [Invariant 1+4]
```

---

## 3. Test coverage matrix

### 3.1 Plugin enter-plan-mode.test.ts (9 tests)

| # | Test | Contract coverage |
|---|---|---|
| E1 | factory returns tool definition with required fields | name, label, description, execute |
| E2 | schema rejects unknown properties | `additionalProperties:false` declared |
| E3 | entering from no state writes mode=plan, approval=none | state transition + fresh write |
| E4 | entering when already in plan mode is noop (no extra write) | idempotency + writeCount unchanged |
| E5 | reason echoed in details when provided | `reason` echo |
| E6 | blank reason dropped from details | trim-blank dropping |
| E7 | output text tells model what to do next | partial check — only `/exit_plan_mode/` + `/do NOT stop/i` matched |
| E8 | soft no-session error when sessionKey unresolved | `no-session` path |
| E9 | soft failure when gateway throws IO error | `failed` path |

### 3.2 Plugin exit-plan-mode.test.ts (16 tests)

| # | Test | Contract coverage |
|---|---|---|
| X1 | factory tool shape (name/label/description/execute) | basic identity |
| X2 | top-level `additionalProperties:false` declared | schema declaration |
| X3 | rejects missing plan array | empty/missing plan |
| X4 | rejects empty plan array | empty array |
| X5 | rejects plan with multiple in_progress | in_progress > 1 |
| X6 | rejects plan step with invalid status | enum validation |
| X7 | accepts completed + in_progress + pending mix | normal happy path |
| X8 | mints valid plan-approvalId via newPlanApprovalId | approvalId format |
| X9 | computes payloadHash and exposes it in details | hash present, hex+12 chars |
| X10 | persists state through PlanModeStore | approval pending, approvalId, title, lastPlanSteps, lastPlanPayloadHash all present |
| X11 | step count reflected in result text | "1 step" / "2 steps" |
| X12 | duplicate-detected status reuses approvalId on identical re-submit | Invariant 3 reuse path |
| X13 | changing plan mints fresh approvalId | Invariant 3 rotate path |
| X14 | not-in-plan-mode when session has no plan-mode payload | precondition guard |
| X15 | no-session when sessionKey unresolved | sessionKey-missing path |
| X16 | failed when store gateway throws | IO-failure path |

---

## 4. Testing gaps

### 4.1 P0 — material correctness gaps (would let regressions ship)

**G1. Plugin tool description does NOT match the in-host `describeExitPlanModeTool()` output, but no parity test enforces this.**
The in-host description contains 8 load-bearing clauses, several of which were added as live-test fixes for documented agent behavior bugs:
- "STOP AFTER THIS TOOL CALL" (Bug A — agent emitted chat text after exit_plan_mode, broke approval card lifecycle)
- subagent-wait warning (Eva post-mortem fix)
- TOOL LIFECYCLE block (Bug F — agent misordered tool calls)
- pointer to bootstrap reference card
The plugin replaces all of this with a 5-line generic description. **No test asserts the plugin description includes any of these strings.** Drift here silently regresses model behavior.

**G2. Plugin tool description for `enter_plan_mode` similarly diverges from `describeEnterPlanModeTool()` without test coverage.**
In-host description has 5 load-bearing clauses including the TOOL LIFECYCLE rule and the bootstrap reference pointer. Plugin's `TOOL_DESCRIPTION` is generic 4-line text. No parity test exists.

**G3. Plugin `exit_plan_mode` does NOT require `title` field but in-host now does (Bug 2/6 fix — required since live-test iter-3).**
In-host throws `ToolInputError("exit_plan_mode requires a \`title\` field — ...")` on missing/whitespace title. Plugin schema marks title `Optional` and the tool body conditionally spreads `title` only when set. There is **no test asserting plugin rejection of missing-title** — that contract is silently absent in the port. Customer impact: empty / wrong / chat-leaked plan titles persist to the markdown filename slug (the exact bug the in-host fix was for).

**G4. Plugin `exit_plan_mode` does NOT clamp title to 80 chars.**
In-host: `title = trimmedTitle.slice(0, 80)`. Plugin passes the full raw `title` through `readStringParam(params, "title")` to the store. No test would catch a 200-char title leaking into `state.title`.

**G5. Plugin `exit_plan_mode` accepts archetype fields in schema but DROPS them in the tool body.**
The plugin schema declares `analysis`, `assumptions`, `risks`, `verification`, `references` as optional pass-through, BUT the execute() body never reads them — they don't appear in `result.details` and they're not persisted. Comment at line 22-24 says "P-4 ships the CORE schema... archetype fields land here at P-8 (archetype port)" — i.e., **a deferred-by-design gap**. The risk is that no test asserts the *current contract* (plugin silently swallows these), so when P-8 lands, the test for "details echoes analysis" might be added without ALSO testing trim-and-drop-blank semantics that in-host's `readPlanArchetypeFields` enforces.

**G6. Plugin output text drift on success path NOT regression-tested.**
- In-host: `"Plan submitted for approval — <title> (1 step)."` OR `"Plan submitted for approval (1 step)."` if no title
- Plugin: `"Plan submitted for approval (1 step). Waiting for user Approve/Reject."` (title NEVER appears in text)
This text is what the model reads back as the tool result and shapes its next-turn behavior. The phrasing "Waiting for user Approve/Reject" is plugin-only. No test asserts the exact text (only partial `/1 step/` match). **The model's chain-of-thought reads this byte-string**, so drift is a behavior change.

**G7. No test asserts the in-host `enter_plan_mode` `TOOL_OUTPUT_TEXT` four-clause structure end-to-end byte-identically.**
Test E7 matches only two substrings (`/exit_plan_mode/` and `/do NOT stop/i`). The four full clauses include `"Plan mode is now active."`, `"Next required step: investigate read-only..."`, `"Do NOT respond with the plan as chat text..."` — drift in the third/fourth clauses would not fail E7. Because this is the anti-halt nudge that demonstrably steers model behavior (per the source comment), every clause is load-bearing.

### 4.2 P1 — incomplete coverage of declared contracts

**G8. No subagent-gate parity test.**
The in-host exit_plan_mode has 5 distinct subagent-gate test cases (`empty openSubagentRunIds`, `no runId`, `1 open`, `5 open lists`, `7 open truncates`, `error mentions wait for completion`, `drained set succeeds`). The plugin has ZERO equivalent tests because the plugin **has no subagent gate at all**. If S5 / S6 (subagent integration slices) introduce a gate to the plugin, there is no prior contract test the plugin must pass, so a half-implementation could ship.

**G9. No SUBAGENT_SETTLE_GRACE_MS test in plugin.**
In-host enforces a settle window after the last subagent completes (blocks exit_plan_mode for X seconds). Not tested in plugin (because not implemented), but the gap is undocumented in the audit set.

**G10. No `displaySummary` parity test.**
In-host sets `displaySummary` on both tools (used by sidebar / sessions list UI). Plugin tools never set `displaySummary`. UI surfaces that read this will render empty. No test asserts the field even exists, let alone matches host text.

**G11. No `additionalProperties: false` enforcement test for `plan[]` items.**
Test X2 confirms top-level `additionalProperties:false`. No test confirms the nested `plan` items reject e.g. `{step, status, foo: "bar"}` — a unknown-key in a plan step would silently pass and propagate to lastPlanSteps. Same gap for `risks[]` items.

**G12. No empty-string `title` test (vs whitespace-only / missing).**
Plugin's `readStringParam` returns `undefined` for empty string. In-host's tests cover whitespace-only via `"   "` ("rejects calls with whitespace-only title"). Plugin has no test for either `title: ""` or `title: "   "`.

**G13. No long-string boundary test.**
- No test for title at boundary (79, 80, 81 chars to verify clamp/no-clamp behavior)
- No test for very long `summary` (e.g., 10kb) — does it appear verbatim in details? Does it propagate to channel renderers?
- No test for very long `step` text (1MB). The store would accept it, but downstream UI / persisted markdown may break.
- No test for very long `reason` field.

**G14. No Unicode handling test.**
Title may contain emoji, RTL characters, surrogate pairs, NUL bytes. The 80-char clamp uses `.slice()` which operates on UTF-16 code units; a 4-byte emoji could be split. In-host clamps; plugin does not clamp; **neither has a Unicode boundary test**.

**G15. No nested HTML/markdown injection test.**
Plan title / summary / analysis become markdown rendered in approval cards. Test that `<script>`, backticks, `[link](javascript:...)`, `__proto__` etc. don't break rendering. No coverage.

**G16. No `step: ""` (empty step text) rejection test.**
In-host: `readStringParam(stepParams, "step", { required: true, label: ... })` rejects empty/whitespace via `readStringParam`'s required path. Plugin uses the same helper. Neither has a direct test of `{step: "", status: "pending"}` rejection.

**G17. No duplicate-step-text test.**
What happens if `plan: [{step: "x", status: "pending"}, {step: "x", status: "pending"}]`? Both in-host and plugin accept this. payloadHash differs from single-x case. Behavior not codified.

**G18. No `step: null` / `step: 42` (wrong type) rejection test.**
`readStringParam` checks `typeof raw !== "string"`. Plugin & in-host differ: in-host returns `undefined` (so required-check throws "label required"), plugin throws "must be a string (got number)". **Different error message + different test surface**, neither tested.

**G19. No multi-`in_progress` boundary test at exactly N=2 / N=3 / N=0.**
- Plugin tests cover N=2 reject (good)
- Neither tests N=3 or higher
- Neither asserts the error message format (in-host: `"plan can contain at most one in_progress step"` — plugin emits same string but unchecked)

**G20. No test of payload-hash stability across rearrangement.**
- Same steps in different order → different hash (correct behavior; not tested)
- Same hash on identical re-submit (X12 covers via "duplicate-detected" status, but doesn't assert the hash equality directly)
- No test of hash determinism (the order of object keys `{t, s, steps}` matters — the parity contract specifies it explicitly; not tested)

**G21. No test of `activeForm` exclusion from payloadHash.**
Per `helpers/payload-hash.ts` doc: "`activeForm` field is deliberately EXCLUDED". This is a **parity-critical contract**. No test asserts `computePlanPayloadHash` ignores activeForm — i.e., two plans differing only in activeForm have the same hash.

**G22. No test of approvalId reuse semantics on cycle change.**
- Reject → re-submit same payload: does approvalId rotate? (Should it? Plugin's `recordRejection` clears `approvalId: undefined`, so next exit_plan_mode would fail the `hasApprovalId` invariant and rotate.) Not tested.
- Approve → next plan → first exit_plan_mode: should the new approvalId be unrelated to the prior one. Not tested.

**G23. No idempotency test on `enter_plan_mode` after a previous cycle's approval.**
Sequence: enter → exit → user approves → mode goes to "normal" with autoApprove preserved → user calls enter again. Does `enterPlanMode` correctly start a fresh cycle with `rejectionCount: 0`, `approvalId` cleared, `lastPlanSteps` cleared? Plugin's `exitPlanMode` clears these (good), but no test exercises the full enter→exit→approve→enter loop.

**G24. No test of `result.content` non-emptiness contract.**
In-host comment: "Return non-empty content (lossless-claw paired-tool-result fix)." Plugin tests check `content[0]?.text` for substring but don't verify the content array is non-empty as a top-level contract.

**G25. No test of toolCallId propagation / determinism.**
ask_user_question test (in-host) asserts `questionId = q-{toolCallId}` is byte-stable. Neither enter_plan_mode nor exit_plan_mode has a deterministic-output test on toolCallId — same plan submitted twice via two different toolCallIds should still produce same payloadHash (which is the SAME pair test as X12 but doesn't assert toolCallId is independent of the hash).

**G26. No AbortSignal handling test.**
Both tools accept `_signal: AbortSignal` but neither acts on it. If the runner aborts mid-`persistApprovalRequest` (which awaits a lock), the await might still finish writing. No test exercises the abort path.

**G27. No test of snake_case parameter alias acceptance.**
The in-host's `readStringParam` uses `readSnakeCaseParamRaw` so `{plan_step: ..., active_form: ...}` are accepted as aliases for `{planStep, activeForm}`. **The plugin's `readStringParam` does NOT do this snake_case fallback** — `params[key]` only. This is silent drift: a model emitting snake_case args (which it often does because tool descriptions teach via examples) would have its values silently dropped in the plugin port. No test asserts either behavior.

**G28. No test of `params` being non-object (string, null, undefined, array).**
Tool execute receives `args: unknown`. Plugin defaults to `{}` via `(args ?? {})` but doesn't cover `args = "some string"` or `args = []` (array — both code paths cast to `Record<string, unknown>` which then reads `.plan` = undefined). Behavior undefined.

### 4.3 P2 — defensive / future-proofing gaps

**G29. No test that `enter_plan_mode` followed by `exit_plan_mode` lands `lastPlanSteps` synchronously (the race-fix anchor scenario).**
The whole reason `1081067476` was committed is that `lastPlanSteps` must be on disk before the approval event broadcasts. Plugin's `persistApprovalRequest` test X10 checks lastPlanSteps is present *eventually*, but no test forces a race: imagine an "approve immediately" callback racing the store write. Plugin's gateway serializes via `withLock`, so the race may not be reachable — but the test invariant ("approvalId, payloadHash, title, lastPlanSteps land in one write") is not assertion-tested as a unit.

**G30. No test of `audit` emitter being called only on persist path.**
PlanModeStore optionally emits audit via the `audit` callback. Invariant 9 says NO audit on reuse path. No test asserts the audit emitter is NOT called when `kind: "reused"` is returned.

**G31. No test of `logger.warn` being called on IO-error path (Invariant 8 fail-soft).**
Plugin test X16 asserts the `details.status: "failed"` shape but doesn't verify that `logger.warn` was invoked (with the message-format the in-host emits).

**G32. No test of newPlanApprovalId throwing on missing crypto.**
`helpers/approval-id.ts` says "throws if no cryptographically secure RNG is available." No test exercises this throw path (would need to mock `globalThis.crypto` + import-time `nodeRandomUUID`).

**G33. No test of `isPlanApprovalId` regex strictness.**
Existing test X8 confirms a minted ID returns `true`. No test confirms it rejects: non-string, uppercase hex, missing `plan-` prefix, malformed UUID, non-v4 UUID (e.g. v1).

**G34. No test of result-`details` shape vs the host's `payloadHash` field being top-level.**
Host: `details.payloadHash` is always present on success. Plugin: same. But neither has a "details shape equality" snapshot that would catch a typo like `payloadHash` → `payloadhash`.

**G35. No test of `summary` being preserved verbatim including newlines.**
Test X8 uses single-line `"Update tooling"`. No test of multi-line summary, or summary with trailing whitespace, or summary that would otherwise be trimmed.

**G36. No fuzz-style test of plan with N items where N is very large.**
What if `plan` is 10,000 entries? Tool accepts and persists; payload hash is computed. Performance or memory limit not tested. (Likely OK but the store has no max-items cap.)

---

## 5. Output-text byte-identical drift check

The in-host comment on the `enter_plan_mode` tool body explicitly calls out the output text matters:

> "Tool result content matters: returning an empty body lets the model treat the tool call as the entire turn and stop. The text below tells the agent — visibly in the tool result — that entering plan mode is just step 1 and exit_plan_mode is the next required action. Without this nudge agents commonly respond with 'I'm opening a fresh plan cycle' then halt."

The plugin's `TOOL_OUTPUT_TEXT` constant is **byte-identical** to the in-host's joined string. **HOWEVER**:
- Plugin test E7 only asserts two substrings: `/exit_plan_mode/` and `/do NOT stop/i`. A future maintainer could rewrite the third or fourth clause and E7 would still pass.
- No `snapshot()` or full-string equality test exists.

For **`exit_plan_mode`**, the situation is worse:
- In-host: `"Plan submitted for approval — <title> (1 step)."`
- Plugin: `"Plan submitted for approval (1 step). Waiting for user Approve/Reject."`
- Already drifts. No test catches this because plugin tests only match `/1 step/` (X11).

For the **tool description text** (a much larger surface than the result text — it's read by the model every turn):
- Both `enter_plan_mode` and `exit_plan_mode` descriptions drift completely between host and plugin.
- No parity test exists.

**Recommendation**: Wave-1 should add a test that asserts both tool descriptions and tool output texts are byte-identical (or at least include each of the ~8 load-bearing substrings from the in-host `describeExitPlanModeTool()` and `describeEnterPlanModeTool()` outputs). The simplest form: import the in-host `describeExitPlanModeTool` and assert equality (if shipped) or assert presence of the key clauses.

---

## 6. In-host parity check (every contract matched?)

| Contract | In-host | Plugin port | Parity? |
|---|---|---|---|
| Tool name | `enter_plan_mode` / `exit_plan_mode` | same | yes |
| Label | `Enter Plan Mode` / `Exit Plan Mode` | same | yes |
| Schema additionalProperties:false (top) | enter: yes; exit: NOT declared | enter: yes; exit: yes | **DIVERGES** (plugin stricter — likely OK) |
| Schema additionalProperties:false (plan items) | yes | yes | yes |
| Schema additionalProperties:false (risks items) | yes | yes | yes |
| Schema PLAN_STEP_STATUSES enum | shared via update-plan-tool | plugin own const | mostly — both `["pending","in_progress","completed","cancelled"]` |
| displaySummary | set | NOT set | **MISMATCH** |
| Description text | full nudge-rich | short generic | **MISMATCH** — material |
| Output text (enter) | byte-stable | byte-stable | yes — but not enforced by test |
| Output text (exit, no-title path) | `"Plan submitted for approval (N steps)."` | `"Plan submitted for approval (N steps). Waiting for user Approve/Reject."` | **MISMATCH** |
| Output text (exit, with title) | `"Plan submitted for approval — <title> (N steps)."` | does not include title in text | **MISMATCH** |
| Title required | yes (throws if missing) | no | **MISMATCH** — fix not ported |
| Title clamped to 80 chars | yes | no | **MISMATCH** |
| Plan validation throw vs soft | in-host THROWS ToolInputError | plugin returns `details.status: "invalid-input"` (no throw) | **DIVERGES** — different error-handling philosophy |
| Status string convention | snake_case (`approval_requested`) | kebab-case (`approval-requested`) | **MISMATCH** — silently different |
| Archetype fields | parsed (trim+drop blank) and echoed in details | accepted in schema, DROPPED in body | **MISMATCH** — material |
| Subagent gate | yes (5 distinct guards + throw) | no | **MISMATCH** — material |
| SUBAGENT_SETTLE_GRACE_MS | yes | no | **MISMATCH** |
| logPlanModeDebug emissions | yes (gate_decision + tool_call) | no | **MISMATCH** |
| exitPlanGateLog emissions | yes | no | **MISMATCH** |
| payloadHash algorithm | SHA-1 12-char prefix of `{t,s,steps}` | same | yes (helpers/payload-hash.ts) |
| payloadHash activeForm exclusion | yes | yes | yes (but not regression-tested) |
| approvalId minting | runner-side | tool-body-side via `newPlanApprovalId` | **DIFFERENT LOCUS** — equivalent output |
| Subagent-gate ctx-fallback | yes (deferred to gateway gate) | n/a | n/a |
| readStringParam snake_case alias | yes (via readSnakeCaseParamRaw) | NO (plain `params[key]`) | **MISMATCH** — silent drop of snake_case args |

---

## 7. State-machine integration gaps

### 7.1 Integration with S3 `persistApprovalRequest`

The plugin's `exit-plan-mode.ts` directly calls `opts.store.persistApprovalRequest`, so the tool ↔ store integration is in-process and serial via the gateway lock. Wave-1 gaps:

- **No test of the full enter → exit → approve → exit-again loop end-to-end at the tool level.** The store-level tests (in `tests/state/store.test.ts`, S3 scope) likely cover this in isolation, but the tool's view of the state through several cycles is not asserted at S1.
- **No test of `recordRejection` followed by re-`exit_plan_mode` with identical payload.** Per Invariant 3 + the `approvalId: undefined` reset on rejection: a re-submit should rotate to a fresh approvalId (cannot reuse because the prior was cleared). The behavior IS tested at the store layer but not at the tool layer.
- **No test that the plugin tool's `details.approvalId` matches `store.peek(sessionKey)?.approvalId`** after each invocation. Mismatch could indicate the tool returned a stale candidate while the store kept a different value (the `kind:"failed"` path returns the *candidate*, not the persisted one — by design — but no test verifies this contract).
- **`autoApprove` carry-over not exercised at the tool level.** PlanModeStore.enterPlanMode preserves `autoApprove` across cycles (via the `current?.autoApprove === true` check), but the tool tests never seed `autoApprove: true` before an enter.

### 7.2 Integration with S15 gateway

The plugin's tools use `InMemoryGateway` only. S15 ports to a real SDK seam (`api.session.state.patch` or equivalent). Gaps:

- **No contract test on what fields the gateway emits/persists.** The in-host's `persistPlanApprovalRequest` writes the FULL `{ approval, approvalId, updatedAt, title, lastPlanPayloadHash, lastPlanSteps }` bundle. The plugin's store writes the same bundle through `PlanModeStateGateway.withLock`. **No abstract-contract test asserts the gateway interface must accept this full payload atomically** — when S15 swaps in the real gateway, a missed field would silently break the race-fix.
- **No `cycleId` field in plugin state.** The in-host `persistPlanModeEnter` initializes `cycleId: randomUUID()` (mentioned in line 339-340 of `pi-embedded-subscribe.handlers.tools.ts`) — this is the gate-state-unavailable fix. Plugin's `PlanModeSessionState` interface does NOT include a `cycleId` field. **Material parity gap.** When S15 wires the gateway, the approval-gate logic (which checks `isModernPlanCycleState && !parentCtx && !hasPersisted`) will fail-closed.
- **No `blockingSubagentRunIds` field in plugin state.** Same root cause — the gateway-side approval gate uses this list as fallback when `parentCtx` is missing. Plugin doesn't model it. When subagent integration lands, the persisted state will not match what the gateway expects.

### 7.3 Integration with the runner / before-tool-call hook

The plugin's `gates/mutation-gate.ts` mirrors the in-host's `checkMutationGate`. The integration shape:
- enter_plan_mode toggles state via tool body → mutation gate reads the state via PlanModeStore.readSnapshot
- exit_plan_mode does NOT exit plan mode — the runtime side (S10 plan-decision injection?) processes the user's Approve and clears `mode: "plan"`.

Gaps:
- **No test that `exit_plan_mode` does NOT itself flip mode to normal.** That's the runtime's job (on approval). A regression that adds `await opts.store.exitPlanMode(...)` inside the tool body would silently fail-open before the user approves.
- **No test that mutation gate respects `mode: "plan"` immediately after `enter_plan_mode` returns** (the read-after-write contract). Plugin's gateway is serialized, so this should hold trivially, but it's not asserted.

---

## 8. Confidence score

**Confidence: 78%**

Rationale:
- I have read every file in the slice and all parity-anchor references.
- The plugin tests cover the most-obvious happy paths and error states, but I am highly confident there are at least 25+ untested contracts based on the side-by-side reading.
- The plugin's stated design (P-4 ships core, P-8 ships archetype, P-11 ships rejection-cycle) means some gaps are deferred-by-design, not regressions — I have flagged these explicitly (G5, G9). The risk is downstream slice-owners assume "we'll add the test when we ship P-8" and forget the *negative* test for the current "field is silently dropped" behavior.
- The largest risk surfaces — description drift, output-text drift, snake_case alias, title required, archetype dropping — are silent: there is no green/red signal in the test suite if they regress further. **These are the gaps that most warrant immediate P0 tests** because they invisibly mis-shape the model's behavior.

**Where the 22% uncertainty lives**:
- I have not exercised the actual test files (read-only audit), so I cannot know which of these gaps the test suite would catch *by side effect*.
- I have not traced what S5 / S10 / S15 will add on top — some gaps may be picked up by sister-slice tests.
- The `cycleId` / `blockingSubagentRunIds` gap is potentially load-bearing for S15, but I have not verified that S15 isn't planning to introduce these — it may be on the roadmap.

**Total gaps identified: 36** (G1–G36)
- P0: 7 (G1–G7)
- P1: 21 (G8–G28)
- P2: 8 (G29–G36)

Exceeds the 15+ gap goal. Notably, the cluster of "description / output text / model-facing prose" drift gaps (G1, G2, G6, G7) is the highest-leverage finding because that text is the model's read-time context every plan cycle — silent drift directly shifts agent behavior.
