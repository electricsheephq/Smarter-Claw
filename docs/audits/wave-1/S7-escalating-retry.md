# Wave-1 Audit — Slice S7: Auto-continue + Escalating Retry

**Auditor:** Wave-1 agent A4 (read-only)
**Date:** 2026-05-12
**Verdict surface:** plugin port of in-host incomplete-turn detection; 3 detectors via `before_agent_finalize` hook
**Confidence:** see §8

---

## 1. Slice summary

The Smarter-Claw plugin ships a coarse-grained re-implementation of OpenClaw's incomplete-turn detection pipeline. The in-host source lives at:

  `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-runner/run/incomplete-turn.ts` (~1070 LOC)

The plugin port lives at:

  `/Users/lume/repos/Smarter-Claw/src/runtime/escalating-retry.ts` (~183 LOC, ~5.8× compression)

The plugin tests live at:

  `/Users/lume/repos/Smarter-Claw/tests/runtime/escalating-retry.test.ts` (21 cases)

The hook wiring lives at `/Users/lume/repos/Smarter-Claw/src/index.ts:479-510`.

**Semantic vs. byte parity.** Test file comment line 4-10 explicitly acknowledges this is a **semantic** abstraction, not byte parity: "Full corpus (59 host-internal cases) deferred to Eva live-smoke #3 + a P-10.5 follow-up; the in-host's `incomplete-turn.ts` 1070-LOC detection pipeline integrates with runner internals that the SDK abstracts away."

The plugin compresses ~7 in-host detectors (reasoning-only, empty-response, planning-only, plan-mode-ack-only, post-approval-yield, ack-execution fast-path, auto-continue fast-path, plus single-action-then-narrative pattern, structured-planning-format detector, completion-cue suppressor, blocker-text suppressor, etc.) into 3 plugin detectors. This is the central audit risk.

**Composition.** The plugin's `decideEscalatingRetry` runs in `before_agent_finalize`. It reads plan-mode + approval state from the plugin's `PlanModeStore`, infers `madeToolCall` from `event.stopHookActive`, and returns a `{action: "revise", retry: {…}}` decision when a detector fires. The SDK enforces `maxAttempts` via the `idempotencyKey`.

---

## 2. The 3 detectors — semantics + trigger conditions

The plugin's detectors map to in-host detectors as follows:

| Plugin detector | In-host counterpart | In-host function |
|---|---|---|
| `PLAN_YIELD` | `resolveYieldDuringApprovedPlanInstruction` | incomplete-turn.ts:990–1070 |
| `PLAN_ACK_ONLY` | `resolvePlanModeAckOnlyRetryInstruction` | incomplete-turn.ts:853–948 |
| `PLANNING_RETRY` | `resolvePlanningOnlyRetryInstruction` | incomplete-turn.ts:741–810 |

### 2.1 PLAN_YIELD

**Plugin trigger** (escalating-retry.ts:89-102):

```ts
signal.isPostApprovalTurn &&
!signal.madeToolCall &&
!signal.lastAssistantMessage?.trim()
```

Fires only when: post-approval turn + no tool call + empty assistant text.

**In-host trigger** (incomplete-turn.ts:990–1070): 8 conjunctive gates:
1. (`planModeActive` AND `planApproval ∈ {approved, edited}`) OR `recentlyApprovedAt` within `POST_APPROVAL_YIELD_GRACE_MS` (2 min)
2. `!aborted && !timedOut`
3. `yieldDetected === true` (explicit yield signal — see §6)
4. `!clientToolCall`
5. `!didSendDeterministicApprovalPrompt`
6. `!didSendViaMessagingTool`
7. `!lastToolError`
8. `!replayMetadata.hadPotentialSideEffects`
9. `stopReason in {undefined, "stop"}`
10. No tool calls other than `sessions_yield` or `update_plan`

The in-host detector **escalates** via `retryAttemptIndex`: standard → FIRM. The plugin's `instruction` is fixed at the standard level (no escalation by attempt index).

### 2.2 PLAN_ACK_ONLY

**Plugin trigger** (escalating-retry.ts:104-119):

```ts
signal.planMode === "plan" &&
!signal.madeToolCall &&
!!signal.lastAssistantMessage?.trim()
```

Plan mode + non-empty assistant text + no tool call.

**In-host trigger** (incomplete-turn.ts:853–948): 13 conjunctive gates including:
1. `planModeActive === true` OR within `POST_APPROVAL_ACK_ONLY_GRACE_MS` (5 min)
2. `!aborted && !timedOut`
3. `!clientToolCall && !yieldDetected && !didSendDeterministicApprovalPrompt && !didSendViaMessagingTool && !lastToolError`
4. `!replayMetadata.hadPotentialSideEffects`
5. `stopReason in {undefined, "stop"}`
6. No `exit_plan_mode` call this turn
7. No `PLAN_MODE_INVESTIGATIVE_TOOL_NAMES` (read/lcm_*/grep/glob/ls/find/web_search/web_fetch/update_plan/enter_plan_mode) other than `update_plan`/`enter_plan_mode`
8. No non-plan tool call
9. Non-empty text (the empty case is owned by the empty-response detector)
10. text.length ≤ `PLAN_MODE_ACK_ONLY_MAX_VISIBLE_TEXT` (1500 chars)
11. Returns FIRM instruction when `retryAttemptIndex ≥ 1`

### 2.3 PLANNING_RETRY

**Plugin trigger** (escalating-retry.ts:121-138):

```ts
signal.planMode === "normal" &&
!signal.madeToolCall &&
isPlanningNarration(signal.lastAssistantMessage)
```

Normal mode + no tool call + planning-narration heuristic matches.

`isPlanningNarration` (escalating-retry.ts:153-174):
- text.length > 0 and ≤ 2000
- Starts with one of 7 patterns (`^I'll`, `^I will`, `^Let me`, `^First[,\s]`, `^Here's my plan`, `^My plan`, `^The plan`)
- No code blocks (no ```` ``` ````)
- Doesn't end with `?`

**In-host trigger** (incomplete-turn.ts:741–810): 17+ conjunctive gates including all the gates from PLAN_ACK_ONLY plus:
- `shouldApplyPlanningOnlyRetryGuard` (provider/model gate — strict-agentic OR Gemini families)
- `isLikelyActionableUserPrompt(prompt)` (user's actual prompt is actionable — not just chit-chat)
- `!attempt.didSendViaMessagingTool`
- No non-plan tool activity OR `hasSingleRetrySafeNonPlanTool` bypass
- `attempt.itemLifecycle.startedCount === planOnlyToolMetaCount` OR single-action bypass
- text.length ≤ `PLANNING_ONLY_MAX_VISIBLE_TEXT` (700 chars)
- text doesn't include ```` ``` ````
- `PLANNING_ONLY_PROMISE_RE` matches OR structured planning format
- `PLANNING_ONLY_ACTION_VERB_RE` matches (unless structured)
- `!PLANNING_ONLY_COMPLETION_RE.test(text)` (suppresses retry when assistant says "done/finished/implemented/etc.")
- `isSingleActionThenNarrativePattern` interaction
- Escalation via `resolveEscalatingPlanningRetryInstruction(attemptIndex)`: standard → FIRM → FINAL

### 2.4 Detector precedence

The plugin orders: `PLAN_YIELD > PLAN_ACK_ONLY > PLANNING_RETRY`. The tests verify two precedence cases (post-approval + plan + empty → PLAN_YIELD; plan + "I'll …" → PLAN_ACK_ONLY).

The mutual exclusion is achieved by the *gating predicates*, not by an explicit `if/else` cascade past the first hit — each detector has a different combination of plan-mode + text + isPostApprovalTurn. Plugin tests do NOT verify all the cross-detector pairs where a single turn could satisfy multiple — see §3 + §4.

---

## 3. State-space coverage matrix

Axes (per audit brief):
- `planMode ∈ {plan, normal}` — 2 values
- `madeToolCall ∈ {true, false}` — 2 values
- `lastAssistantMessage shape` — at minimum {empty, narration-match, narration-no-match, question, code-block, walls-of-text, single-word-ack} — 7 values (use representative 4 for the matrix below: empty, narration-match, plain-text, question)
- `isPostApprovalTurn ∈ {true, false}` — 2 values

Grand total: 2 × 2 × 4 × 2 = 32 combinations (matches brief).

Legend:
- **COVERED** — explicit test exercises this row
- **IMPLICIT** — test covers a generalization (e.g., "any non-narration text in normal mode" covers many shapes)
- **GAP** — no test exercises this row

| # | planMode | madeToolCall | message | isPostApproval | Expected detector | Covered? | Test or note |
|---|---|---|---|---|---|---|---|
| 1 | plan | true | empty | true | undefined | IMPLICIT | covered indirectly by "tool call wins" line 31-39 |
| 2 | plan | true | narration | true | undefined | IMPLICIT | line 31-39 generalizes |
| 3 | plan | true | plain-text | true | undefined | IMPLICIT | line 31-39 generalizes |
| 4 | plan | true | question | true | undefined | IMPLICIT | line 31-39 generalizes |
| 5 | plan | false | empty | true | PLAN_YIELD | COVERED | precedence test line 203-210 (plan + empty + post-approval → PLAN_YIELD) |
| 6 | plan | false | narration | true | **AMBIGUOUS — actual = PLAN_ACK_ONLY** | **GAP** | not explicitly tested; PLAN_YIELD requires empty text, so PLAN_ACK_ONLY wins. Confirm |
| 7 | plan | false | plain-text | true | **AMBIGUOUS — actual = PLAN_ACK_ONLY** | **GAP** | same as #6 |
| 8 | plan | false | question | true | PLAN_ACK_ONLY | **GAP** | plan + non-empty + post-approval + question → PLAN_ACK_ONLY (PLANNING_RETRY's `?` gate doesn't apply in plan mode). Confirm |
| 9 | plan | true | empty | false | undefined | IMPLICIT | line 74-82 |
| 10 | plan | true | narration | false | undefined | COVERED | line 74-82 |
| 11 | plan | true | plain-text | false | undefined | IMPLICIT | |
| 12 | plan | true | question | false | undefined | IMPLICIT | |
| 13 | plan | false | empty | false | undefined | COVERED | line 84-94 "different antipattern" |
| 14 | plan | false | narration | false | PLAN_ACK_ONLY | COVERED | line 212-220 (PLAN_ACK_ONLY wins over PLANNING_RETRY in plan mode) |
| 15 | plan | false | plain-text | false | PLAN_ACK_ONLY | COVERED | line 63-72 "OK I understand, working on it." |
| 16 | plan | false | question | false | PLAN_ACK_ONLY | **GAP** | plugin's PLAN_ACK_ONLY has NO question-mark filter; fires on questions too |
| 17 | normal | true | empty | true | undefined | IMPLICIT | |
| 18 | normal | true | narration | true | undefined | IMPLICIT | |
| 19 | normal | true | plain-text | true | undefined | IMPLICIT | |
| 20 | normal | true | question | true | undefined | IMPLICIT | line 31-39 generalizes |
| 21 | normal | false | empty | true | PLAN_YIELD | COVERED | line 19-29 (the canonical case) |
| 22 | normal | false | narration | true | **AMBIGUOUS** | **GAP** | PLAN_YIELD requires empty text; non-empty + post-approval + normal mode → falls through to PLANNING_RETRY heuristic. Likely UNEXPECTED — after approval, retrying with PLANNING_RETRY is wrong tone |
| 23 | normal | false | plain-text | true | undefined | **GAP** | post-approval + non-empty + non-narration → drop. Plugin does NOT fire PLAN_YIELD here even though semantically this is a "yielded after approval" case |
| 24 | normal | false | question | true | undefined | **GAP** | same as #23; clarifying question after approval — should clarify but plugin lets it pass |
| 25 | normal | true | empty | false | undefined | IMPLICIT | |
| 26 | normal | true | narration | false | undefined | COVERED | line 143-151 (PLANNING_RETRY suppressed by tool call) |
| 27 | normal | true | plain-text | false | undefined | IMPLICIT | |
| 28 | normal | true | question | false | undefined | IMPLICIT | |
| 29 | normal | false | empty | false | undefined | **GAP** | normal + empty + no-tool-call + no-post-approval — silent yield. Plugin doesn't fire. The in-host's `empty-response retry` would fire here |
| 30 | normal | false | narration | false | PLANNING_RETRY | COVERED | line 111-141 (canonical case + 7 starter variants) |
| 31 | normal | false | plain-text | false | undefined | COVERED | line 96-107 "OK I understand." (acknowledgement, not planning) |
| 32 | normal | false | question | false | undefined | COVERED | line 164-173 "I'll do X, but should I also do Y?" |

**Coverage stats:**
- COVERED (explicit test) = 11 (34%)
- IMPLICIT (covered by generalization) = 13 (41%)
- GAP (untested) = 8 (25%)

The **8 explicit gaps** are the spine of §4.

---

## 4. Testing gaps (P0/P1/P2)

P0 = retry fires incorrectly or fails to fire when it should
P1 = silent behavioral drift; user-visible but recoverable
P2 = cosmetic/log-only; or genuinely edge-case

### P0 — retry-fires-incorrectly / fires-when-it-shouldn't

**P0-1. PLAN_YIELD requires literally empty text — won't fire on "I'll start now" + yield.**
escalating-retry.ts:92 `!signal.lastAssistantMessage?.trim()`. After plan approval the agent commonly emits 1-2 sentences ("Starting execution now") before yielding. The in-host PLAN_YIELD fires regardless of text content (it checks `yieldDetected` not text emptiness). Plugin will MISS the canonical post-approval acknowledgment-then-yield case → cascade falls through to PLANNING_RETRY in normal mode (which has the wrong tone for "you just had approval"). Matrix row #22.

**P0-2. No `recentlyApprovedAt` grace-window analog.**
In-host PLAN_YIELD has a **2-minute grace window** post-approval (POST_APPROVAL_YIELD_GRACE_MS, incomplete-turn.ts:988). In-host PLAN_ACK_ONLY has a **5-minute grace window** (POST_APPROVAL_ACK_ONLY_GRACE_MS, incomplete-turn.ts:851). The plugin derives `isPostApprovalTurn` from `snap.approval === "approved" || "edited"` (index.ts:489-490) — a stateful read with no time bound. If the session sits in `approval: "approved"` for hours without auto-exiting plan mode, every chat-only turn for hours fires PLAN_ACK_ONLY-style pressure. Worse, every yield fires PLAN_YIELD. Test for this **does not exist**.

**P0-3. `madeToolCall` proxy is wrong.**
index.ts:488 `const madeToolCall = event.stopHookActive === true`. Comment at escalating-retry.ts:55-60 acknowledges: "*the hook event doesn't expose this directly … if stopHookActive is false AND lastAssistantMessage is non-empty, we assume the turn ended with chat-only*." This is a **single-bit proxy** for a multi-bit reality. In-host distinguishes:
- `clientToolCall` (tool call dispatched)
- `yieldDetected` (explicit yield via sessions_yield)
- `didSendViaMessagingTool` (messaging-tool exit path)
- `lastToolError` (failed tool)
- `replayMetadata.hadPotentialSideEffects` (any mutation might have happened)

The plugin collapses these to one `madeToolCall: boolean`. Possible drift:
- A turn that called a tool that errored may show `stopHookActive=true` and suppress the detector even though no progress was made → **false negative**.
- A turn that yielded explicitly with no tool call may show `stopHookActive=true` (the stop_hook runs on every turn closure) and suppress PLAN_YIELD → **false negative**. Verify against SDK semantics; the plugin's comment is a guess ("we assume").

No tests confirm `stopHookActive`'s actual semantics. **Run-cycle smoke test needed.**

**P0-4. `isPlanningNarration` is anchor-pattern-only.**
escalating-retry.ts:157-165 matches only **prefix** patterns (`^I'll`, `^I will`, `^Let me`, `^First`, `^Here's my plan`, `^My plan`, `^The plan`). The in-host `PLANNING_ONLY_PROMISE_RE` (incomplete-turn.ts:67) uses `\b…\b` boundaries, matching anywhere in the message:
```
i'll|i will|let me|i'm going to|first[, ]i'll|next[, ]i'll|i can do that
```
**Plugin false-negatives:**
- "OK, I'll start by …" (preamble before "I'll") — anchor fails
- "Sure thing. Let me check the config first." — anchor fails
- "Got it — first, I'll read the source." — anchor fails
- "Right, so I'm going to inspect the schema." — anchor fails (plugin has no `^I'm going to` pattern)
- "Next I'll handle the migration." — anchor fails (plugin has no `^Next` pattern)

In-host detects all of these; plugin misses them. **No tests cover any of these forms.**

**P0-5. No completion-cue suppressor.**
The in-host `PLANNING_ONLY_COMPLETION_RE` (incomplete-turn.ts:69) suppresses retry when text contains words like `done|finished|implemented|updated|fixed|changed|ran|verified|found|here(?:'s| is) what|blocked by|the blocker is`. The plugin has NO equivalent.

**False-positive trigger:** "I'll be brief: I've already verified the schema is correct." → plugin fires PLANNING_RETRY (starts with "I'll"); in-host suppresses (matches `verified`). Tests don't cover any "I'll…" + completion-cue cases.

**P0-6. No blocker-text suppressor.**
In-host: `blocked by` and `the blocker is` are in the COMPLETION_RE — the agent is allowed to say "I'll explain: the blocker is X" without triggering a retry. Plugin will fire PLANNING_RETRY on any "I'll …" preface regardless of blocker disclosure. False-positive class.

**P0-7. `?`-at-end gate is text-shape-specific.**
escalating-retry.ts:172 `t.endsWith("?")`. The in-host equivalent doesn't exist — instead, the in-host checks user's actionable-prompt-ness up front (`isLikelyActionableUserPrompt(params.prompt)`), not the assistant's reply shape. A trailing `?` in plugin gates the entire detector; if the assistant writes "I'll start by reading the spec. Sound good?", plugin suppresses. But "I'll start by reading the spec. Should I go now?" also suppresses. **Edge case:** "I'll start by reading the spec? OK." — ends in "OK." not "?", so retry FIRES even though the spec-line ends with "?" mid-text. No test covers a mid-text `?` that's followed by more content.

**P0-8. No `isLikelyActionableUserPrompt` guard.**
In-host has a *user-side* guard: if the user's prompt was small-talk (e.g., "hello", "thanks"), don't pressure the agent to "act now" — there's nothing to act on. Plugin doesn't read the user prompt at all. If the user said "Hi" and the agent replied "I'll be glad to help — what would you like?" the plugin fires PLANNING_RETRY (starts with "I'll", normal mode, no tool call, no question mark at end if there's a space before…). No test covers this. The plugin will pressure the agent to retry on conversational openings.

### P1 — silent behavioral drift

**P1-1. No `executionContract` / provider-model gate.**
In-host (incomplete-turn.ts:534-555) only applies PLANNING_RETRY to:
- `executionContract === "strict-agentic"`, OR
- Gemini family models (`google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`)

The plugin has NO provider gate. Every model gets the retry pressure. This is a **scope expansion** beyond in-host — could regress non-strict providers (Anthropic Claude on the default contract) by injecting unwanted pressure. No test covers a provider-gate omission.

**P1-2. Plugin's `PLAN_ACK_ONLY` text-length cap = ∞.**
In-host: `text.length > PLAN_MODE_ACK_ONLY_MAX_VISIBLE_TEXT (1500)` → SKIP (different failure mode, owned elsewhere). Plugin has no length cap. If the agent in plan mode writes a 5000-char essay without a tool call, plugin fires PLAN_ACK_ONLY. This is probably fine ("essay-instead-of-plan" is still a failure), but the detector tone is wrong — it's "you're chatting without a tool call" when actually "you wrote a plan inline instead of calling exit_plan_mode." No test covers this.

**P1-3. No escalation by retry attempt.**
In-host has STANDARD → FIRM → FINAL (PLANNING_RETRY) and STANDARD → FIRM (PLAN_ACK_ONLY, PLAN_YIELD). The plugin returns a **single fixed instruction** per detector. The SDK enforces `maxAttempts: 3` via `idempotencyKey`, but the instruction is identical on each attempt. After 3 retries the agent has seen the same 200-byte string 3 times — gain rapidly approaches zero. **No test covers what happens at attempt 1 vs attempt 2 vs attempt 3** — the instruction is the same.

**P1-4. No suppressor for `didSendDeterministicApprovalPrompt`.**
In-host suppresses all 3 detectors when this flag is true. Plugin doesn't model it. Risk: when the host injects a deterministic approval prompt (e.g., the `[PLAN_DECISION]:` synthetic injection) and the agent's response is brief, plugin fires a retry on top of the host's already-deterministic flow. Probably mitigated by `madeToolCall` happening to be `true`, but no test confirms.

**P1-5. No suppressor for `lastToolError`.**
If the previous tool errored, agent's text-only response is *appropriate* (explaining the error, asking the user). Plugin doesn't see this — will fire PLAN_ACK_ONLY / PLANNING_RETRY. No test.

**P1-6. No suppressor for `replayMetadata.hadPotentialSideEffects`.**
Same as P1-5 — the in-host bails on retry when there's been a side effect this turn (we don't want to double-execute). Plugin has no analog. Risk: replay-unsafe operations get retried.

**P1-7. `aborted` / `timedOut` not modeled.**
In-host bails on all 3 detectors when `aborted || timedOut`. Plugin doesn't read these from the event. If the SDK aborted the turn, the plugin still fires a retry on top — wasted cycle. No test.

**P1-8. Idempotency-key collisions across detectors.**
Plugin's `idempotencyKey(sessionKey, detector)` (escalating-retry.ts:176-182) is `smarter-claw:<DETECTOR>:<sessionKey>`. The test at line 224-234 verifies the format. **Gap:** if a session hits PLAN_ACK_ONLY 3 times (cap reached), then transitions to normal mode and hits PLANNING_RETRY — that's a *different* key, so PLANNING_RETRY gets a fresh budget of 3. Plausibly intended (different failure mode, different budget), but no test asserts this is the right behavior. **Worse:** if a session hits PLAN_ACK_ONLY 3 times, then enter_plan_mode → exit_plan_mode → re-enter, the key is *still* the same. Is the retry counter reset across plan-mode cycles, or carried? Untested.

**P1-9. No cross-session-leakage test (similar messages, different sessions).**
Test at line 252-266 verifies `sessionKey` participates in the key, but doesn't test that two different sessions with same content/state get **independent** retry budgets. Implicit in the key format, but worth pinning.

### P2 — cosmetic/log-only

**P2-1. No test for `event.stopHookActive === false` AND empty message AND post-approval.**
Combination: `madeToolCall=false`, empty text, isPostApproval=true — should fire PLAN_YIELD. Test #5 covers this but with `planMode: "normal"`. The plan-mode + post-approval + empty + no-tool-call case (matrix #5) is also intended to PLAN_YIELD per the precedence test. Confirmed but not directly tested in isolation.

**P2-2. No test for empty `sessionKey` (e.g., empty string).**
Test at line 270-278 covers `sessionKey === undefined`. The empty-string case (`sessionKey: ""`) is not tested — falsy but technically not `undefined`. The plugin's `if (!sessionKey)` would still bail (empty string is falsy), so behavior is correct, but the test gap is real.

**P2-3. `idempotencyKey` is collision-prone across plugin versions.**
Prefix `smarter-claw:` — if a future Smarter-Claw v2 changes detector names or adds new ones, retry counters in flight from v1 still match v2's keys (same sessionKey + same detector string). Probably benign; no test.

**P2-4. No test for instruction text format stability.**
Plugin tests assert `\[PLAN_YIELD\]:` etc. match. If the instruction text is later refactored, tests pass but downstream renderers (UI filters for `[PLAN_*]:` first-line tags per in-host comment at line 219-225) may break. Recommend tightening test to match the exact instruction string at byte level.

**P2-5. No load test on the idempotency-key path.**
SDK enforces the cap. But what if `idempotencyKey` collides with another plugin's key? Plugin's `smarter-claw:` prefix is a defense, but no test asserts the prefix.

**P2-6. Test for "PLAN_YIELD wins over PLAN_ACK_ONLY when both could fire" is technically wrong.**
Test at line 199-210 says "both conditions could fire" — but PLAN_YIELD requires empty text; PLAN_ACK_ONLY requires non-empty text. They're MUTUALLY EXCLUSIVE on the empty/non-empty axis. So they can't both fire. The test exercises "post-approval + plan + empty + no-tool-call" which is PLAN_YIELD's case — PLAN_ACK_ONLY explicitly excludes empty text (line 87-94 confirms). The "wins over" framing in the test description is misleading.

### Summary

|  | Count |
|---|---|
| P0 | 8 |
| P1 | 9 |
| P2 | 6 |
| **Total** | **23** |

---

## 5. Heuristic-edge gaps — planning-narration false positives/negatives

The plugin's `isPlanningNarration` is the **only place** narration is detected. The in-host has 3 separate regexes (`PLANNING_ONLY_PROMISE_RE`, `PLANNING_ONLY_HEADING_RE`, `PLANNING_ONLY_BULLET_RE`) PLUS `hasStructuredPlanningOnlyFormat` PLUS `isSingleActionThenNarrativePattern` PLUS `PLANNING_ONLY_ACTION_VERB_RE` PLUS suppressor regexes (`PLANNING_ONLY_COMPLETION_RE`, `SINGLE_ACTION_RESULT_STYLE_RE`).

### 5.1 Anchor vs. word-boundary patterns

| Plugin pattern | In-host counterpart | Gap |
|---|---|---|
| `^I'll ` | `\bi'll\|i will\b` | In-host fires on "OK, I'll …", "Sure, I'll …", "But I'll …" — plugin misses |
| `^I will ` | (same) | ditto |
| `^Let me ` | `\blet me\b` (not `(?!know\b)`) | In-host fires on "Maybe let me check first" — plugin misses |
| `^First[,\s]` | `\bfirst[, ]\b` | In-host fires on "OK, first, I'll …" — plugin misses (anchor pattern only) |
| `^Here's my plan` | (no exact analog) | This is plugin-specific; in-host detects via heading/bullet shape |
| `^My plan ` | (no exact analog) | ditto |
| `^The plan ` | (no exact analog) | ditto |

### 5.2 Patterns plugin DOESN'T detect

Plugin has NO patterns for these in-host detectors:
- `i'm going to` / `i am going to` (in-host PLANNING_ONLY_PROMISE_RE)
- `next[, ]i'll` / `next[, ]i will`
- `i can do that` (in-host PLANNING_ONLY_PROMISE_RE)
- Structured heading: `^(plan|steps?|next steps?)\s*:` (in-host PLANNING_ONLY_HEADING_RE)
- Bullet shape: `^([-*•]\s+|\d+[.)]\s+)` (in-host PLANNING_ONLY_BULLET_RE)
- Single-action-then-narrative pattern (in-host SINGLE_ACTION_EXPLICIT_CONTINUATION_RE)
- Multi-step-promise pattern (in-host SINGLE_ACTION_MULTI_STEP_PROMISE_RE)
- Action-verb requirement (in-host PLANNING_ONLY_ACTION_VERB_RE — narration without a verb like "inspect/check/run/etc." doesn't fire in-host)

### 5.3 Long-message handling

Plugin: `text.length > 2000 → suppress`. In-host: `text.length > 700 → suppress` (PLANNING_ONLY) and `> 1500 → suppress` (PLAN_MODE_ACK_ONLY). Plugin's 2000 threshold is 2.85× more permissive than in-host's PLANNING_ONLY. **Boundary test cases not covered:** 700, 701, 1500, 1501, 2000, 2001 — none tested at length boundaries.

### 5.4 Code-block handling

Plugin: `/```/` regex on text suppresses. In-host: same gate. ✓ parity.
**Gap:** test only at line 153-162 with the canonical ` ```sh ` ` ``` `. Doesn't cover:
- Single backticks ` `inline code` ` (NOT a code block; should fire — untested)
- Indented code blocks (no fences but 4-space indent — neither plugin nor in-host detects these)
- Code blocks at the very end after planning text ("I'll do X.\n```bash\nls\n```") — covered

### 5.5 Question-mark handling

Plugin: `endsWith("?")` → suppress. Untested edge cases:
- `?` followed by trailing whitespace ("Should I?\n") — `endsWith("?")` returns false because of `\n`. `t = text.trim()` runs first so trailing whitespace is stripped. ✓ but no test.
- Question in middle: "Should I do X? OK I'll proceed." — endsWith fails, retry FIRES. Whether this is right is unclear; if the agent is asking AND committing, retry on the commit seems wrong. Untested.
- Multiple questions: "What? Why? I'll figure it out." — endsWith "out." so retry fires (starts with "I'll" doesn't match anyway here). Untested.
- Unicode question marks: `；` (full-width semicolon), `？` (full-width question), `¿` (inverted) — Plugin's `endsWith("?")` is ASCII-only. Bilingual users typing CJK get false positives. Untested.

### 5.6 Capitalization variants

Plugin uses `i` flag on regexes — case-insensitive. ✓ parity with in-host.
**Gap:** test cases all use canonical capitalization ("I'll", "Let me"). No tests for lowercase ("i'll"), uppercase ("I'LL"), or title case ("I'Ll").

### 5.7 Non-English planning narration

The in-host `ACK_EXECUTION_NORMALIZED_SET` (incomplete-turn.ts:102-142) detects Arabic, German, Japanese, French, Spanish, Portuguese, Korean execution-acks ("تمام", "やって", "vas y", "hazlo", "해줘", etc.).

The plugin has **no non-English detection at all** for any of its 3 detectors. A non-English-speaking user's agent saying "Je vais commencer par lire le fichier" (French: "I'll start by reading the file") doesn't match `^I'll ` — plugin misses entirely. The same agent saying "やります" (Japanese: "I'll do it") doesn't match. **False-negative class:** all non-English narration.

This is a deliberate scope cut per the comment at escalating-retry.ts:9-12, but worth flagging — a non-English-locale user gets a strictly worse experience.

### 5.8 Mixed planning + execution

In-host: `isSingleActionThenNarrativePattern` (incomplete-turn.ts:698-717) — exactly 1 non-plan tool call + visible "I'll do X next" prose → treat as planning-only. The bypass `hasSingleRetrySafeNonPlanTool` allows read/search/find/grep/glob/ls to count as "real progress." Complex 3-way logic.

Plugin: NO equivalent. Plugin only sees `madeToolCall: boolean` — can't distinguish 0/1/2+ tool calls. If the agent called `read` AND said "Now I'll process this in steps:", plugin won't fire (madeToolCall=true) — in-host might fire depending on the single-action-bypass details. **Acceptable abstraction loss** but worth noting.

### 5.9 Question-vs-statement edge

In-host treats `prompt.includes("?")` as actionable (line 600); the agent's reply being a question is unrelated. Plugin treats agent's reply ending in `?` as "suppress" — different axis entirely. The semantics don't match.

---

## 6. In-host abstraction gaps — what the plugin port DROPPED

The in-host's incomplete-turn.ts has **~7 distinct detectors + 2 instruction-only fast-paths + 4 utility functions** wired through 3 different return slots. The plugin keeps 3. Below is what was dropped, with acceptability assessment.

### 6.1 Detectors dropped entirely

| In-host detector | Plugin replacement | Acceptable? |
|---|---|---|
| `resolveReasoningOnlyRetryInstruction` (lines 441-486) — fires when the assistant produced reasoning but no visible answer | NONE | **NO** — provider-side reasoning failures will silently produce empty turns; the SDK's empty-response handling owns this, per plugin comment, but if the SDK doesn't actually handle this (untested!), there's an outright gap |
| `resolveEmptyResponseRetryInstruction` (lines 488-532) — fires when the agent produced literally nothing (`payloadCount === 0`, no text, no tool, no error) | Subsumed under PLAN_YIELD (only) | **PARTIAL** — plugin fires PLAN_YIELD on empty + post-approval. For empty + NOT post-approval, nothing fires. Matrix #29 GAP |
| `resolveAckExecutionFastPathInstruction` (lines 606-624) — short user prompts like "OK" / "do it" get an injection telling the agent to skip recap | NONE | **NO** — the user-prompt-side optimization is gone. Agents will re-narrate after "OK" prompts. Not strictly a *correctness* gap but a UX regression |
| `resolveIncompleteTurnPayloadText` (lines 305-355) — surfaces a user-visible "⚠️ Agent couldn't generate a response" message when the agent abandoned | NONE | **PARTIAL** — the abandonment surface is now the SDK's responsibility; if it surfaces nothing, the user sees a silent stall |
| Single-action-then-narrative bypass | NONE | acceptable abstraction loss; see §5.8 |
| Multi-step-promise pattern | NONE | covered by `^I'll`/`^I will` anchor, partially |
| Structured planning-only format (headings + bullets) | NONE | partial — falls back to anchor patterns which miss bullet/heading-shaped plans |

### 6.2 Suppressors dropped entirely

The in-host conditions all 3 detectors on **8+ suppression flags**:
1. `aborted` — not modeled by plugin
2. `timedOut` — not modeled by plugin
3. `clientToolCall` — plugin's `madeToolCall` proxies this but inverts semantics
4. `yieldDetected` — partially modeled; plugin's PLAN_YIELD detects it via empty text + post-approval, but not "any yield"
5. `didSendDeterministicApprovalPrompt` — not modeled
6. `didSendViaMessagingTool` — not modeled
7. `lastToolError` — not modeled
8. `replayMetadata.hadPotentialSideEffects` — not modeled

**Acceptability:** Each missing suppressor is a *potential* false-positive. In aggregate, the plugin will fire retries in situations where the in-host explicitly bails. The risk is "noisy retries that waste model cycles + annoy the user."

### 6.3 Provider/contract gating dropped

In-host: only fires on `executionContract === "strict-agentic"` OR Gemini models (lines 534-575). Plugin: no provider gate. **All providers get the retry pressure.** Anthropic Claude on the default contract may regress — was previously NOT subject to PLANNING_RETRY pressure, now is.

### 6.4 Escalating instruction text dropped

In-host: `resolveEscalatingPlanningRetryInstruction(attemptIndex)` returns STANDARD / FIRM / FINAL per attempt (lines 731-739). Plugin returns the same text every attempt. Tests don't cover this.

### 6.5 Plan-details extraction dropped

In-host: `extractPlanningOnlyPlanDetails` (lines 658-668) extracts steps from the assistant's narration so they can be surfaced in the UI (probably for the auto-plan-write feature). Plugin: nothing.

### 6.6 Grace-window logic dropped

`POST_APPROVAL_YIELD_GRACE_MS` (2 min) and `POST_APPROVAL_ACK_ONLY_GRACE_MS` (5 min) are core in-host innovations to handle the post-approval transition window where the session's `planMode` is `"normal"` but the *behavior* should still get retry pressure. Plugin uses `snap.approval === "approved" || "edited"` as a stateful flag with **no time bound** — see P0-2.

### 6.7 Aggregate verdict

The plugin retains **roughly 30-35%** of the in-host's detection semantics. Big wins:
- Detector intent (the 3 named failure modes) ✓
- Idempotency-key shape ✓ (well-designed)
- Precedence ordering ✓
- Code-block anti-false-positive ✓
- Length cap ✓ (different threshold)
- Question-mark suppressor ✓ (semantics differ)
- Plan-mode awareness ✓
- Post-approval awareness — PARTIAL (no grace window)

Big losses:
- Multi-suppressor cascade (8 flags) → 1 proxy
- Escalation by attempt index
- Provider gating
- Non-English narration
- Structured-plan formats (heading/bullet)
- Mid-message narration (anchor vs. word-boundary)
- Completion-cue + blocker-text suppressors
- Empty-response detector outside post-approval
- Single-action-then-narrative
- User-prompt actionable-ness check

**Verdict on acceptability:** the **mode/approval framing is acceptable** (it's the *intent* layer). The **suppressor cascade and provider gate are NOT acceptable** because they change the false-positive rate from "intentional pressure on narrative-prone models" to "pressure on all models in many cases where the in-host would never fire." Risk: regression for Claude / GPT-5 users who weren't on `strict-agentic`.

---

## 7. Adversarial questions — turn shapes that could regress

These are concrete turn shapes that could produce surprising/regressing plugin output. Each is a candidate for a P0 test case.

1. **"After approval, agent says 'Starting now' + yields with no other action."** Plugin: PLAN_YIELD requires empty text → MISS. In-host: fires PLAN_YIELD. **Production failure mode** — this is THE canonical post-approval stall.

2. **"Plan mode, agent says 'Should I check the migrations folder?'"** Plugin: PLAN_ACK_ONLY fires (no `?` filter on PLAN_ACK_ONLY). In-host: clarifying questions are part of the plan-investigation phase — fires PLAN_ACK_ONLY too actually, but only because there's no tool call. Plugin and in-host *might* agree here, but plugin's reasoning is "no question filter" while in-host's is "no investigative tool." Different paths to same outcome — but if the user-facing instruction text differs, the UX drifts.

3. **"Normal mode, agent says 'Got it. I'll start by reading auth.ts.'"** Plugin: anchor `^I'll` fails (starts with "Got it."). PLANNING_RETRY MISS. In-host: word-boundary `\bi'll\b` matches — FIRES.

4. **"Normal mode, agent says 'I'll be brief: I've already fixed the bug.'"** Plugin: `^I'll` matches, no `?` ending, length OK → FIRES. In-host: `PLANNING_ONLY_COMPLETION_RE` matches `fixed` → SUPPRESSED. **False positive** — agent already executed.

5. **"Normal mode, French agent: 'Je vais commencer par lire le fichier.'"** Plugin: no `^I'll` → MISS. In-host: no French in `PLANNING_ONLY_PROMISE_RE` → MISS too. Parity, but both miss.

6. **"Normal mode, agent says 'Let me know if you need more info.'"** Plugin: `^Let me ` matches, no question, length OK → **FIRES** (false positive: this is a polite closing, not a plan). In-host: `let me` matches the word-boundary regex too — fires too. **Both buggy.** No `(?!know\b)` lookahead in either. Actually the in-host SINGLE_ACTION_EXPLICIT_CONTINUATION_RE has `let me (?!know\b)` (incomplete-turn.ts:76) but PLANNING_ONLY_PROMISE_RE (line 67) doesn't have the negative lookahead. So both fire on "Let me know …".

7. **"Plan mode, agent writes a 1700-char inline plan as markdown, no exit_plan_mode."** Plugin: PLAN_ACK_ONLY fires (no length cap). In-host: text > 1500 → SUPPRESSED ("out of scope for this detector"). **False positive** vs in-host, but the user is genuinely failing to call exit_plan_mode, so arguably plugin is right and in-host is too lenient. Disagreement; need policy decision.

8. **"Strict-agentic + 3rd PLANNING_RETRY attempt."** Plugin: same instruction (STANDARD) on every attempt. In-host: STANDARD → FIRM → FINAL. After 3 identical retries the agent has heard the same 200-char instruction 3 times; gain → 0. In-host's escalation is *also* not that strong (just stronger wording), but at least it varies.

9. **"Empty turn, normal mode, NOT post-approval."** Plugin: drops to the bottom of the cascade, nothing fires. In-host: `resolveEmptyResponseRetryInstruction` fires with `EMPTY_RESPONSE_RETRY_INSTRUCTION`. **Hole.** No retry happens — user sees a silent empty response.

10. **"Tool errored, agent says 'I'll try a different approach.'"** Plugin: `^I'll` matches, no tool call this turn → FIRES PLANNING_RETRY. In-host: `lastToolError` suppresses → no retry. **False positive** — agent is recovering, plugin pushes more pressure.

11. **"Approval granted 4 hours ago, session still in `approval: 'approved'`, agent yields on a new user message."** Plugin: PLAN_YIELD fires (no time bound). In-host: `recentlyApprovedAt` is > 2 min ago → grace window expired → no fire. **False positive** at scale — every session that lingers in `approved` state fires PLAN_YIELD on every yield.

12. **"Auto-approve mode, agent in 'normal' mode after approval, calls a read-only tool."** Plugin: `madeToolCall=true` → suppress. In-host: same. Parity ✓ — but if the read returned no result and agent yields, plugin fires PLAN_YIELD (no further tool call); in-host's grace window may have expired. Drift case.

13. **"Plan mode, agent says ONLY '```\nls -la\n```'."** Plugin: `^I'll` etc. all fail → PLAN_ACK_ONLY check (plan mode + no tool + non-empty text) → FIRES. In-host: text has code block but `PLAN_MODE_ACK_ONLY` doesn't gate on code blocks (it's `PLANNING_ONLY` that does). Both fire — parity ✓. But the agent's intent is "I'm showing a command, not narrating," so both are wrong.

14. **"Plan mode, agent's text is the user's literal prompt echoed back, no tool call."** Plugin: PLAN_ACK_ONLY fires regardless of content. In-host: same. Parity ✓. Both are right.

15. **"Cross-cycle counter exhaustion."** Session A hits PLAN_ACK_ONLY 3 times (cap reached). Then user starts a new plan cycle (enter_plan_mode → exit_plan_mode → enter_plan_mode again). Plugin's idempotency-key is the *same* (sessionKey + detector). The SDK's retry budget — is it persistent across cycles, or reset? **Test doesn't cover this.** If persistent, the new cycle starts with a 0-retry budget — broken behavior.

16. **"Plugin reads stale snapshot."** `ctx.sessionKey` was set, but the plugin's `store.readSnapshot()` returns an outdated `snap` (e.g., approval flipped from `approved` to `rejected` mid-flight). Plugin still fires PLAN_YIELD on a now-rejected plan. **No test.**

17. **"Concurrent retries."** Multiple `before_agent_finalize` events fire near-simultaneously for the same session (e.g., user double-clicked Send). Both attempt to fire a retry with the same idempotencyKey. Behavior: does the SDK serialize? Does the second see attempt=2 or attempt=1? Untested.

18. **"`stopHookActive` undefined or null."** `event.stopHookActive === true` strict-equality. If undefined, `madeToolCall` is `false`. Is that semantically right (no tool call)? Per index.ts:488 comment: "*The hook doesn't expose 'did the turn make a tool call?' directly. The SDK's `stopHookActive` IS true during turns that resolved via stop_hook*." So `undefined === false` means "not via stop_hook" → not a tool call → `madeToolCall = false`. Plausible but **unverified** assumption.

---

## 8. Confidence score

**Overall confidence in current S7 coverage: 38%.**

Rationale:
- The plugin port abstracts away ~65% of the in-host detection complexity.
- Tests exercise the 3 *named* detectors correctly but cover ~34% of the 2×2×4×2 state-space explicitly and miss 25% entirely.
- The biggest single risk is the **`madeToolCall` proxy** (P0-3): it's a single-bit collapse of 5+ orthogonal signals, with no test verifying SDK semantics.
- The **PLAN_YIELD empty-text requirement** (P0-1) means the canonical "Starting now" + yield case is unhandled.
- The **missing grace-window** (P0-2) means stale-approval sessions over-fire indefinitely.
- The **completion-cue suppressor absence** (P0-5/-6) plus **anchor-only narration regex** (P0-4) together produce both false-positive and false-negative risk on the only well-tested path.
- Test naming/intent is solid; coverage gaps are due to scope choice, not test discipline.

**Sub-scores:**

| Surface | Confidence |
|---|---|
| Intent/semantics of 3 detectors | **70%** — naming + plan-mode coupling is clear |
| State-space coverage | **35%** — 8 explicit holes, 13 implicit-only |
| Heuristic precision (false positives) | **30%** — multiple known FP classes untested |
| Heuristic recall (false negatives) | **25%** — anchor-only patterns + no completion suppressor |
| In-host parity | **30%** — 8 suppressors collapsed; escalation gone |
| Edge-case robustness (Unicode/locale) | **15%** — no non-English narration support |
| Idempotency-key correctness | **75%** — well-designed; format pinned |
| Cross-session isolation | **75%** — implicit via key construction |
| Cross-cycle counter behavior | **20%** — untested; could carry stale budget |
| `event.stopHookActive` semantics | **40%** — assumed; not verified empirically |
| Grace-window semantics | **10%** — no analog implemented |
| Adversarial robustness (17 scenarios) | **45%** — most fail or differ from in-host |

**Suggested next moves (priority order):**

1. **Add a test for "post-approval + non-empty text + no-tool-call + normal mode"** (matrix row #22) — pin the actual behavior. Likely shows PLAN_YIELD doesn't fire when it should.
2. **Add a `recentlyApprovedAt` field to the snap** and gate PLAN_YIELD / PLAN_ACK_ONLY on a grace window. Parity with in-host.
3. **Test `event.stopHookActive` semantics empirically** with a parity-harness fixture covering: (a) tool-call turn, (b) yield-only turn, (c) error turn, (d) clean-stop turn. Currently a guess.
4. **Add suppression for `lastToolError` / `replayMetadata.hadPotentialSideEffects`** in the plugin's signal extraction. Cheap addition; closes 2 P1 false-positive classes.
5. **Widen `isPlanningNarration`** to use `\b…\b` instead of `^…` to align with in-host. Cheap fix; closes P0-4.
6. **Add `PLANNING_ONLY_COMPLETION_RE`-equivalent suppressor.** Closes P0-5 and P0-6 together.
7. **Add escalation-by-attempt** (STANDARD/FIRM/FINAL). Cheap addition; aligns with in-host UX.
8. **Add a non-English smoke test** so the regression is at least visible (test that asserts plugin does NOT fire on French narration, as documentation that this is a known limitation).

---

## Appendix A — Files referenced

- `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-runner/run/incomplete-turn.ts` (1070 LOC)
- `/Users/lume/repos/Smarter-Claw/src/runtime/escalating-retry.ts` (183 LOC)
- `/Users/lume/repos/Smarter-Claw/tests/runtime/escalating-retry.test.ts` (279 LOC, 21 cases)
- `/Users/lume/repos/Smarter-Claw/src/index.ts` (esp. lines 479-510, hook wiring)
- `/Users/lume/repos/Smarter-Claw/src/types.ts` (PlanMode, PlanApprovalState)
- `/Users/lume/repos/Smarter-Claw/src/prompt/reference-card.ts` (PLANNING_RETRY appears as user-facing reference card entry; no behavior coupling)

## Appendix B — Test-case quick index (plugin tests)

| Test | Lines | Detector | Asserts |
|---|---|---|---|
| PLAN_YIELD: post-approval empty | 19-29 | PLAN_YIELD | fires; `maxAttempts=3` |
| PLAN_YIELD: post-approval + tool call | 31-39 | — | undefined |
| PLAN_YIELD: post-approval + text + tool | 41-49 | — | undefined |
| PLAN_YIELD: not post-approval | 51-59 | — | undefined |
| PLAN_ACK_ONLY: plan mode chat | 63-72 | PLAN_ACK_ONLY | fires |
| PLAN_ACK_ONLY: plan mode + tool | 74-82 | — | undefined |
| PLAN_ACK_ONLY: plan mode empty | 84-94 | — | undefined |
| PLAN_ACK_ONLY: normal mode + plain ack | 96-107 | — | undefined |
| PLANNING_RETRY: canonical | 111-122 | PLANNING_RETRY | fires |
| PLANNING_RETRY: 7 starter variants | 123-141 | PLANNING_RETRY | each fires |
| PLANNING_RETRY: with tool call | 143-151 | — | undefined |
| PLANNING_RETRY: with code block | 153-162 | — | undefined |
| PLANNING_RETRY: ends with `?` | 164-173 | — | undefined |
| PLANNING_RETRY: "Done!" | 175-183 | — | undefined |
| PLANNING_RETRY: >2000 chars | 185-195 | — | undefined |
| Precedence: PLAN_YIELD > PLAN_ACK_ONLY | 199-210 | PLAN_YIELD | wins |
| Precedence: PLAN_ACK_ONLY > PLANNING_RETRY | 212-220 | PLAN_ACK_ONLY | wins |
| Idempotency: key format | 224-234 | — | format `smarter-claw:X:sessionKey` |
| Idempotency: different detectors | 236-249 | — | keys differ |
| Idempotency: different sessions | 252-266 | — | keys differ |
| Defensive: no sessionKey | 270-278 | — | undefined |
