# S8 — Rejection UX + cycle tracking + deescalation hint at ≥3

Wave-1 audit agent A5 — read-only first-principles testing-gap analysis.

Sources:
- In-host: `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/approval.ts`,
  `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/types.ts:158-207`
- Plugin: `/Users/lume/repos/Smarter-Claw/src/prompt/plan-decision-injection.ts`,
  `/Users/lume/repos/Smarter-Claw/src/helpers/sanitize.ts`,
  `/Users/lume/repos/Smarter-Claw/src/state/store.ts`,
  `/Users/lume/repos/Smarter-Claw/src/runtime/injection-writer.ts`,
  `/Users/lume/repos/Smarter-Claw/src/ui/session-actions.ts`
- Plugin tests: `tests/prompt/plan-decision-injection.test.ts` (25 cases),
  `tests/state/store.test.ts` (recordRejection 14 cases + recordApproval 14 cases),
  `tests/runtime/injection-writer.test.ts` (23 cases),
  `tests/ui/session-actions.test.ts` (~25 cases),
  `tests/eva-live-smokes/smoke-3-rejection-cycle.test.ts` (4 cases)

---

## 1. Slice summary

Slice S8 covers three coupled concerns:

1. **Rejection UX** — when the user rejects a proposed plan, the session stays
   in plan mode and the agent receives a `[PLAN_DECISION]: rejected` synthetic
   message at the start of its next turn (with the user's feedback string
   embedded after JSON quoting and envelope sanitization).
2. **Cycle tracking** — `rejectionCount` is monotonically incremented per
   rejection, persisted on `PlanModeSessionState`, reset to 0 only on
   approve/edit (and freshly minted on `enterPlanMode`/`exitPlanMode`).
3. **Deescalation hint at ≥ 3** — when the count reaches 3 (or higher), the
   injection appends one additional sentence:
   `"Multiple revisions have been rejected. Consider asking the user to
   clarify their goal before proposing another plan."`

The slice spans state mutator (`recordRejection`), text builder
(`buildPlanDecisionInjection`), injection writer
(`enqueuePlanDecisionInjection`), session-action handler (`plan.reject`),
and end-to-end live smoke (`smoke-3-rejection-cycle.test.ts`).

---

## 2. Approval state machine (full transition diagram + invariants)

```
                                ┌──────────────────────────────┐
                                │                              │
                                │       (no payload)           │
                                │                              │
                                └────────────┬─────────────────┘
                                             │ enterPlanMode
                                             ▼
                          ┌───────────────────────────────────────┐
                          │   mode=plan, approval=none            │
                          │   rejectionCount=0 (or preserved)     │  ◄── auto-approve toggle allowed any time
                          └────────────┬──────────────────────────┘
                                       │ exit_plan_mode (persistApprovalRequest)
                                       ▼
                          ┌────────────────────────────────────────────────┐
                          │ mode=plan, approval=pending                    │
                          │ approvalId=<uuid>, lastPlanSteps=..., title=.. │  ◄── stale-event guard active
                          └─┬──────────────┬─────────────┬─────────────┬───┘
                            │              │             │             │
                            │ approve      │ edit        │ reject      │ timeout
                            │              │             │             │
                            │ resolvePlanApproval (in-host) /
                            │ recordApproval | recordRejection (plugin)
                            │              │             │             │
                            ▼              ▼             ▼             ▼
       ┌────────────────────┐ ┌──────────────────┐ ┌──────────────────────┐ ┌────────────────────┐
       │ mode=normal        │ │ mode=normal      │ │ mode=plan            │ │ mode=plan          │
       │ approval=approved  │ │ approval=edited  │ │ approval=rejected    │ │ approval=timed_out │
       │ feedback=undefined │ │ feedback=undef   │ │ feedback=(latest)    │ │ feedback=undefined │
       │ rejectionCount=0   │ │ rejectionCount=0 │ │ rejectionCount += 1  │ │ rejectionCount=same│
       │ confirmedAt=now    │ │ confirmedAt=now  │ │ confirmedAt=undefined│ │ confirmedAt=undef  │
       │                    │ │                  │ │ approvalId=cleared   │ │                    │
       │ TERMINAL           │ │ TERMINAL         │ │ NON-terminal (open   │ │ TERMINAL           │
       │                    │ │                  │ │  for re-approve OR   │ │                    │
       │                    │ │                  │ │  next exit_plan_mode)│ │                    │
       └────────────────────┘ └──────────────────┘ └─────────┬────────────┘ └────────────────────┘
                                                             │
                                                             │ exit_plan_mode (agent re-proposes)
                                                             ▼
                                                     (back to pending; rejectionCount carried)
```

### Documented invariants

| # | Invariant | Source |
|---|-----------|--------|
| I-1 | `approvalId` is a UUIDv4 mint, "plan-" prefix; ~122 bits entropy | `types.ts:114-146` |
| I-2 | Stale-event guard: when caller passes `expectedApprovalId`, current MUST have a matching `approvalId` (fail-CLOSED on missing token) | `approval.ts:54-66` |
| I-3 | Terminal-state guard: actions on `approved`/`edited`/`timed_out` → no-op | `approval.ts:82-84` |
| I-4 | `timeout` requires `approval === "pending"` (NOT `rejected`) — once rejected, the cycle has already resolved | `approval.ts:85-87` |
| I-5 | `approve`/`edit` reset `rejectionCount` to 0 AND clear `feedback` AND transition `mode → normal` | `approval.ts:92-113` |
| I-6 | `reject` increments `rejectionCount` via `(current.rejectionCount ?? 0) + 1` (defensive against undefined) | `approval.ts:123` |
| I-7 | `reject` preserves `mode === "plan"` (fail-closed; no exit until explicit re-approve / cancel) | `approval.ts:118` |
| I-8 | `reject` preserves prior `feedback` when caller passes `undefined` (no clobber) | `approval.ts:122` |
| I-9 | Deescalation hint fires at `rejectionCount >= 3` (inclusive boundary, falsy-guarded so `0` does not fire) | `types.ts:196` |
| I-10 | Sanitization: `[/PLAN_DECISION]` (case-insensitive, global) → `[ZWSP/PLAN_DECISION]` (U+200B prefix) BEFORE JSON.stringify | `types.ts:158-160` |
| I-11 | Feedback line is JSON.stringify'd (escapes embedded quotes + newlines as `\n`) | `types.ts:191-193` |
| I-12 | One-line opener `[PLAN_DECISION]: <decision>` (no multi-line block); the closing `[/PLAN_DECISION]` is NEVER emitted by the builder itself | `types.ts:190` |
| I-13 | "expired" alias accepted but both `expired` and `timed_out` produce the SAME resume guidance lines | `types.ts:201-205` |
| I-14 | Deescalation hint ONLY fires on `rejected` decision (NOT on `timed_out`/`expired` even at high count) | `types.ts:194-199` |
| I-15 | Empty-string feedback (falsy) → feedback line omitted | `types.ts:191` |

---

## 3. Test coverage matrix

Format: **Contract → test file:line(s)** (or **GAP**).

### 3.1 In-host approval.ts state-machine contracts

| Contract | In-host test | Plugin equivalent |
|---|---|---|
| C-1 approve transitions mode → normal | `approval.test.ts:19-25` | `store.test.ts:746-754` (sets `approval`, NOT mode — see Parity gap P1-A) |
| C-2 edit transitions mode → normal | `approval.test.ts:27-32` | `store.test.ts:765-776` (same gap) |
| C-3 reject stays in plan mode, increments count | `approval.test.ts:34-40` | `store.test.ts:557-572` |
| C-4 multi-cycle accumulator (3 rejections → count=3) | `approval.test.ts:42-50` | `store.test.ts:575-595` (only goes to 2; partial coverage) |
| C-5 timeout stays in plan mode | `approval.test.ts:52-56` | **GAP** (no plugin recordTimeout mutator at all) |
| C-6 stale-timeout (post-approval) is no-op | `approval.test.ts:58-67` | **GAP** (plugin has no timeout path) |
| C-7 enteredAt preserved across all transitions | `approval.test.ts:69-74` | **GAP** |
| C-8 approve clears feedback | `approval.test.ts:76-85` | **GAP — see Parity gap P1-B (plugin spread keeps feedback)** |
| C-9 transitions allowed from rejected (re-approve) | `approval.test.ts:87-96` | **GAP** (plugin recordApproval gates on `approval === "pending"` so rejected → approved is BLOCKED — see Parity gap P1-C) |
| C-10 terminal-state ignored | `approval.test.ts:98-106` | `store.test.ts:846-863` (covers ALL terminal kinds, double-approve+rejected; PASS) |
| C-11 stale-event guard happy + sad paths | `approval.test.ts:266-292` | `session-actions.test.ts:140-150` (handler-side); store layer does NOT check approvalId itself — see gap P2-D |
| C-12 fail-closed when state has no approvalId but caller passes one | `approval.test.ts:321-348` | `session-actions.test.ts:140-150` (via handler; missing snapshot guard tested obliquely) |
| C-13 reject does NOT reset count | `approval.test.ts:310-313` | **partial** (`store.test.ts:575-595`) |
| C-14 approve resets count to 0 | `approval.test.ts:300-303` | **GAP — see Parity gap P1-D (plugin does NOT reset)** |
| C-15 edit resets count to 0 | `approval.test.ts:305-308` | **GAP** (same) |
| C-16 timeout does NOT reset count | `approval.test.ts:315-318` | **GAP** |

### 3.2 buildPlanDecisionInjection wording-as-contract

| Contract | In-host test | Plugin test |
|---|---|---|
| W-1 One-line opener `[PLAN_DECISION]: rejected` | `approval.test.ts:191-202` | `plan-decision-injection.test.ts:23-27` |
| W-2 One-line opener `[PLAN_DECISION]: timed_out` | `approval.test.ts:221-223` | `plan-decision-injection.test.ts:28-31` |
| W-3 One-line opener `[PLAN_DECISION]: expired` (alias) | `approval.test.ts:214-219` | `plan-decision-injection.test.ts:33-38` |
| W-4 Revise-and-retry instruction emitted | implicit `:191-202` | `plan-decision-injection.test.ts:43-46` |
| W-5 Deescalation hint AT count===3 (boundary) | `approval.test.ts:204-207` (only "3+") | `plan-decision-injection.test.ts:53-57` |
| W-6 Deescalation hint AT count===2 NOT fired | `approval.test.ts:209-212` | `plan-decision-injection.test.ts:48-51` |
| W-7 Deescalation hint at count===0 NOT fired (falsy guard) | **GAP in-host** | `plan-decision-injection.test.ts:69-73` |
| W-8 Deescalation hint at undefined NOT fired | **GAP in-host** | `plan-decision-injection.test.ts:64-67` |
| W-9 Deescalation hint NEVER fires on timed_out/expired | **GAP in-host** | `plan-decision-injection.test.ts:146-150` |
| W-10 Adversarial closing-tag sanitization (case-sensitive) | `approval.test.ts:226-239` | `plan-decision-injection.test.ts:112-122` |
| W-11 Case-insensitive sanitization | `approval.test.ts:241-244` | **GAP** (plugin tests do not cover lower-case `[/plan_decision]`) |
| W-12 JSON-quoting of embedded quotes | **GAP in-host** | `plan-decision-injection.test.ts:94-99` |
| W-13 JSON-quoting of embedded newlines | **GAP in-host** | `plan-decision-injection.test.ts:101-110` |
| W-14 Empty-string feedback omits feedback line | **GAP in-host** | `plan-decision-injection.test.ts:82-87` |
| W-15 Stable line ordering (opener / feedback / revise / hint) | **GAP in-host** | `plan-decision-injection.test.ts:154-167` |
| W-16 timed_out + feedback (uncommon but legal) ordering | **GAP in-host** | `plan-decision-injection.test.ts:178-187` |
| W-17 Approved/edited openers share prefix shape with rejected | **GAP in-host** | `plan-decision-injection.test.ts:199-207` |

### 3.3 Sanitization (helpers/sanitize.ts)

| Contract | Plugin test |
|---|---|
| S-1 ASCII closing-tag literal → ZWSP-prefixed | covered via `plan-decision-injection.test.ts:112-122` |
| S-2 Mixed-case variants (`[/plan_DECISION]`) | **GAP** (plugin does not exercise this) |
| S-3 Multiple occurrences | **GAP** (in-host uses `/g` flag — replace_all — never directly tested) |
| S-4 ZWSP byte identity matches in-host | **GAP** (no byte-equality test ensures plugin and in-host produce the SAME bytes for the SAME input) |
| S-5 No double-rewrite of already-sanitized text (idempotency) | **GAP** |

### 3.4 Injection-writer (runtime/injection-writer.ts)

| Contract | Plugin test |
|---|---|
| IW-1 sends `[PLAN_DECISION]: rejected` text | `injection-writer.test.ts:41-56` |
| IW-2 includes feedback in text | `injection-writer.test.ts:42-56` |
| IW-3 deescalation hint at count ≥ 3 | `injection-writer.test.ts:58-68` |
| IW-4 idempotency-key format `smarter-claw:plan_decision:<approvalId>:<decision>` | `injection-writer.test.ts:70-81` |
| IW-5 placement === `prepend_context` | `injection-writer.test.ts:83-92` |
| IW-6 metadata carries kind+decision+approvalId+rejectionCount | `injection-writer.test.ts:94-109` |
| IW-7 metadata omits rejectionCount when undefined | `injection-writer.test.ts:111-119` |
| IW-8 TTL passthrough | `injection-writer.test.ts:122-132` |
| IW-9 sessionKey isolation | `injection-writer.test.ts:336-356` |
| IW-10 Idempotency-key for timed_out vs expired DIFFER | `injection-writer.test.ts:147-174` |
| IW-11 Back-to-back rejects of SAME approvalId → same idempotency key | **GAP** (test asserts distinct approvalIds yield distinct keys but never the same-approvalId double-fire dedup case) |
| IW-12 Reject-then-approve race produces distinct keys | only covered for `approved`-vs-`edited` (line 237-253); **GAP** for reject↔approve crossing |

### 3.5 session-action (`plan.reject`)

| Contract | Plugin test |
|---|---|
| SA-1 Happy path: transitions to rejected, increments count, persists feedback | `session-actions.test.ts:261-277` |
| SA-2 Enqueues rejected injection with feedback + count metadata | `session-actions.test.ts:279-297` |
| SA-3 Deescalation hint fires at count=3 | `session-actions.test.ts:299-309` |
| SA-4 Works without feedback | `session-actions.test.ts:311-320` |
| SA-5 STALE_APPROVAL_ID on approvalId mismatch | `session-actions.test.ts:322-332` |
| SA-6 NOT_IN_PLAN_MODE | only via `plan.accept` path (`:161-170`); **GAP** for `plan.reject` |
| SA-7 NO_PENDING_APPROVAL | only via `plan.accept` path (`:172-181`); **GAP** for `plan.reject` |
| SA-8 MISSING_SESSION_KEY | only via `plan.accept` (`:152-159`); **GAP** for `plan.reject` |
| SA-9 Non-object payload → INVALID_PAYLOAD | only via `plan.accept` (`:466-483`); **GAP** for `plan.reject` |
| SA-10 Non-string feedback in payload → ignored gracefully | **GAP** (no test covers `feedback: 42` or `feedback: { nested: true }`) |
| SA-11 Whitespace-only feedback trimmed to undefined | **GAP** (readStringField trims but no test asserts behavior on `feedback: "   "`) |
| SA-12 STORE_ERROR propagates from gateway failure | **GAP** (`recordRejection` failure path is tested for `recordApproval` analog only) |

### 3.6 Live smoke (`smoke-3-rejection-cycle.test.ts`)

| Contract | Test |
|---|---|
| LS-1 Three cycles → 3rd injection carries deescalation text | `smoke-3-rejection-cycle.test.ts:67-121` |
| LS-2 Each cycle has distinct idempotencyKey | `:123-139` |
| LS-3 Adversarial feedback sanitized in injection text | `:141-154` |
| LS-4 rejectionCount persists across enter/exit/reject cycles | `:156-170` |
| LS-5 4th reject still emits deescalation hint | **GAP** |
| LS-6 Approve mid-cycle (cycle 2) resets count to 0 | **GAP** |
| LS-7 Cancel mid-cycle resets the session | **GAP** |

---

## 4. Testing gaps (P0 / P1 / P2)

### P0 (load-bearing, blocks merge)

**G-P0-1. `recordApproval` does NOT reset `rejectionCount` to 0** — PARITY DIVERGENCE.
- In-host `approval.ts:99-100, 111-112` explicitly resets `rejectionCount: 0` on
  both `approve` and `edit`.
- Plugin `store.ts:567-573` spreads `...current` — keeps the prior count.
- Behavioral impact: an approved-then-re-entered-plan-mode session retains its
  rejection history, so the next single rejection triggers the deescalation hint
  even though the prior plan was approved cleanly. The hint becomes noise.
- No test catches this — `store.test.ts:746-754` only asserts `approval ===
  "approved"`, not the count reset.

**G-P0-2. `recordApproval` does NOT clear `feedback`** — PARITY DIVERGENCE.
- In-host `approval.ts:99` sets `feedback: undefined` on approve.
- Plugin spreads `...current`, preserving `feedback`.
- Behavioral impact: stale rejection feedback survives into the approved state
  and could pollute downstream UI projection. Plugin's `recordApproval` test
  (line 778-789) only checks `confirmedAt`/`approval`/`mode`.

**G-P0-3. `recordApproval` does NOT transition `mode → "normal"`** — PARITY DIVERGENCE.
- In-host `approval.ts:95, 107` explicitly sets `mode: "normal"`.
- Plugin spreads `...current`, keeping `mode: "plan"`.
- The plugin's docstring at `store.ts:534-537` says "session stays in mode=plan
  until the runtime processes the [PLAN_DECISION]: approved injection on the
  next turn" — but the in-host transitions IMMEDIATELY on the state mutator.
  This is a load-bearing semantic split that **no parity test asserts**.
  Plugin test `store.test.ts:792-795` LOCKS IN the divergent behavior. If
  the plugin and in-host both wire into the same gateway's mutation-gate logic
  (S6) the session.mode read decides whether mutation tools are allowed —
  divergence here can let mutation tools fire post-approval but pre-injection-drain.

**G-P0-4. recordApproval blocks `rejected → approved` (user changes mind)** — PARITY DIVERGENCE.
- In-host `approval.ts:82-83` allows transitions FROM `rejected` (the comment
  on line 82-84 says "Rejected stays open for re-approval or re-rejection").
  In-host test `approval.test.ts:87-96` verifies this.
- Plugin `store.ts:562-565` rejects `approval !== "pending"` outright →
  `kind: "skipped"`. Plugin test `store.test.ts:856-862` LOCKS IN the
  divergent behavior.
- Impact: legitimate UI flows where the user clicks Reject then changes their
  mind and clicks Approve before the agent re-proposes get blocked.

**G-P0-5. No byte-equality test ensures the plugin and in-host
`buildPlanDecisionInjection` produce IDENTICAL output for the same input.**
- The plugin's docstring on `plan-decision-injection.ts:4-7` says
  "byte-identical port" but no test imports the in-host function and compares
  outputs. The wording IS the contract per the in-host docstring; a single
  parity test (table-driven across the input matrix) is the obvious safety
  net and is absent.

### P1 (high-value, should fix before next port-cycle)

**G-P1-1. Deescalation hint wording is split across two assertion sites.**
- Plugin tests assert `/Multiple revisions have been rejected/` and
  `/asking the user to clarify their goal/` as TWO separate regexes.
- The full canonical sentence is: `"Multiple revisions have been rejected.
  Consider asking the user to clarify their goal before proposing another
  plan."` — a regex like `/Multiple revisions have been rejected\. Consider asking the user to clarify their goal before proposing another plan\./`
  would catch any paraphrase regression. No such full-string assertion exists.

**G-P1-2. Stale-event guard NOT enforced at the store-mutator layer.**
- In-host `resolvePlanApproval` accepts `expectedApprovalId` directly and
  no-ops on mismatch (the guard is **in** the state machine).
- Plugin pushes this check OUT to `session-actions.ts:checkApprovalId`. Any
  caller that goes around the session-action layer (e.g. future
  channel-handler or a CLI tool) bypasses the guard entirely.
- No test covers "if the store is invoked directly with stale state, does it
  detect?" — the answer is "no, the store does not even accept the param".

**G-P1-3. No "reject then reject again (without re-proposing)" test.**
- In-host approval.ts:82-83 ALLOWS this: `approval === "rejected"` does not
  short-circuit. The state machine increments count again.
- Plugin `recordRejection` gates on `approval === "pending"` (line 486-489)
  — second reject is SKIPPED with `kind: "no-pending-approval"`. PARITY
  DIVERGENCE.
- No test covers either direction.

**G-P1-4. `recordRejection` clears `approvalId` on rejection (line 501) —
the in-host does NOT.**
- In-host `approval.ts:115-124` spreads `...current` keeping the approvalId
  intact (rejected state still references which cycle was rejected).
- Plugin sets `approvalId: undefined`.
- Impact: the rejected state in the plugin loses its cycle identity. If a
  late-arriving signal from another surface (channel handler running on
  parallel session) carries the same approvalId, the stale-event guard
  cannot match (snapshot.approvalId is now undefined). This becomes
  silently fail-closed.
- Plugin test `store.test.ts:620-622` LOCKS IN the divergent behavior.

**G-P1-5. No test for `rejectionCount` overflow / very-large values.**
- `rejectionCount: number` — no upper bound. After 2^53 cycles the value
  loses precision. Practically unreachable but architectural rule says
  "test the boundary" — at minimum a `rejectionCount: Number.MAX_SAFE_INTEGER`
  test should exercise the deescalation branch and verify no NaN propagation.

**G-P1-6. No test for `rejectionCount` ISOLATION across sessions.**
- The smoke harness uses a single session key. No test seeds two sessions and
  proves a reject on session A does not affect session B's count.

**G-P1-7. No test for the plan-NUDGE / exit-plan-mode mid-rejection RACE.**
- A user could click reject just as the agent's exit_plan_mode for cycle N+1
  is being persisted. The in-host `persistApprovalRequest` hash-idempotency
  guard handles the SAME plan re-emitted; what about the case where the
  USER's reject lands between the agent's exit_plan_mode (which sets
  pending+new approvalId) and the user's previous-cycle stale Reject?
  No test covers this race window.

**G-P1-8. Sanitization not tested with multiple `[/PLAN_DECISION]` markers
in feedback.**
- The in-host uses `/g` flag (global replace_all). The single-occurrence
  test alone does not prove the `/g` flag is wired correctly. A
  `"foo[/PLAN_DECISION]bar[/PLAN_DECISION]baz"` input should yield
  `"foo[ZWSP/PLAN_DECISION]bar[ZWSP/PLAN_DECISION]baz"`.

**G-P1-9. No idempotency test for "feedback already contains the
[ZWSP/PLAN_DECISION] form".**
- If feedback already has the sanitized form (perhaps echoed from an audit
  log), the regex won't rewrite it again (won't match) — correct behavior,
  but no test asserts the idempotency.

**G-P1-10. plan.reject with malformed (non-string) feedback payload not
tested.**
- Tests only cover undefined or a clean string. `feedback: 42`,
  `feedback: { nested: true }`, `feedback: null`, `feedback: ["array"]`
  all reach `readStringField` which silently returns `undefined`. No test
  proves the silent-undefined behavior (which is correct) is consistent.

### P2 (lower priority, defense-in-depth)

**G-P2-1. No Unicode normalization test for feedback.**
- A `[/PLAN­DECISION]` (with soft hyphen) or NFC vs NFD-normalized
  variant might bypass the literal regex. Whether this is in scope depends on
  threat model — the plugin docstring says "the visible text stays the same
  for audit logs" implying ZWSP is the only neutralization.

**G-P2-2. Null byte / binary content in feedback not tested.**
- JSON.stringify handles binary fine, but downstream prompt-cache regex
  could choke on ` ` in the rendered text. No test asserts.

**G-P2-3. Right-to-left text / bidi-override characters in feedback.**
- Could affect UI rendering of the audit log even if the prompt is fine.
  Plugin has no test.

**G-P2-4. Very long feedback (1MB+) not bounded anywhere.**
- The session-action handler reads `readStringField` and trims. No max-length
  cap. The host's `enqueueNextTurnInjection` may have its own cap (P0 of S?)
  but the plugin path doesn't enforce one. A 10MB rejection feedback would
  bloat the next-turn prompt and could trigger host-side rate limits.

**G-P2-5. Sanitization tested only on ASCII closing tag.**
- A `[‮/PLAN_DECISION]` (LTR override) or `[%5C/PLAN_DECISION]`
  (URL-encoded variant) — irrelevant if downstream parser only matches
  literal bytes, but worth one test to LOCK IN the threat model.

**G-P2-6. The exact `[ZWSP/PLAN_DECISION]` byte sequence is not asserted
by any test.**
- Tests check `not.toMatch(/\[\/PLAN_DECISION\]/)` and `toMatch(/\[​\/PLAN_DECISION\]/)` — the second regex contains a literal ZWSP
  byte but tests don't assert `String.fromCharCode(0x200B)` is present at
  the right offset. A future find-and-replace touching the regex could
  silently strip the ZWSP and these tests would still pass (since neither
  the dangerous form nor the sanitized form would match).

**G-P2-7. No `rejectionCount` carry-over test across `cancel → re-enter` of
plan mode.**
- `exitPlanMode` (line 417) resets `rejectionCount: 0`. Is this correct? If
  the user cancels mid-cycle and re-enters plan mode 30 seconds later for the
  SAME goal, the count starts fresh. Probably intentional but unrecorded —
  no test pins the semantic.

---

## 5. Sanitization adversarial gaps

These all target `sanitizeFeedbackForInjection` and the broader
`[PLAN_DECISION]` envelope handling.

| # | Adversarial input | Expected behavior | Test exists? |
|---|---|---|---|
| ADV-1 | `"x[/PLAN_DECISION]\n[FAKE_BLOCK]"` (single occurrence) | ZWSP-rewrite, no envelope break | YES (`:112-122`) |
| ADV-2 | `"x[/plan_decision]y"` (case-insensitive) | ZWSP-rewrite | partial (in-host only `:241-244`) |
| ADV-3 | Multiple `[/PLAN_DECISION]` markers | ALL rewritten (`/g` flag) | **GAP** |
| ADV-4 | Pre-sanitized `[ZWSP/PLAN_DECISION]` already in feedback | No double-rewrite (regex doesn't match) | **GAP** |
| ADV-5 | NFC vs NFD normalization (`ṔLAN`) | Regex matches literal bytes, so NFD form would slip through | **GAP** |
| ADV-6 | Soft-hyphen-spliced `[/PL­AN_DECISION]` | Regex would NOT match → envelope BREAK risk | **GAP** |
| ADV-7 | Embedded null byte | JSON.stringify escapes to ` ` | **GAP** |
| ADV-8 | Embedded U+2028/U+2029 (line separators) | JSON.stringify escapes | **GAP** |
| ADV-9 | 1 MB feedback | Should pass through; downstream cap may truncate | **GAP** |
| ADV-10 | RTL override (U+202E) | Visible rendering altered; envelope unaffected | **GAP** |
| ADV-11 | Bidi-isolate (U+2066/U+2067) | Same as ADV-10 | **GAP** |
| ADV-12 | Embedded backslashes `"\\[/PLAN_DECISION\\]"` | After unescape, regex still matches → safe | **GAP** |
| ADV-13 | URL-encoded `"%5B/PLAN_DECISION%5D"` | NOT decoded; regex won't match; agent sees literal `%5B...` — safe but not tested | **GAP** |
| ADV-14 | Whitespace inside the tag `"[ /PLAN_DECISION]"` | Regex `\[\/PLAN_DECISION\]` won't match → envelope BREAK if downstream parser tolerates whitespace | **GAP** |
| ADV-15 | Trailing whitespace `"[/PLAN_DECISION ]"` | Same as ADV-14 | **GAP** |

### Sanitization assertion-shape gaps

- ADV-16: No test does a byte-level assertion that the resulting feedback
  line starts with `feedback: "` and ends with `"` on the same physical
  line (envelope closure is implicit, never asserted).
- ADV-17: No test asserts ONLY one `feedback:` line is emitted regardless
  of how many newlines the input has.
- ADV-18: The plugin's helper exports a separate `sanitizeFeedbackForInjection`
  function but **the test file `tests/prompt/plan-decision-injection.test.ts`
  does not import it directly** — sanitization is tested transitively via
  `buildPlanDecisionInjection`. A unit test on the bare sanitizer with the
  full ADV-1..ADV-15 table would surface most gaps with one new file.

---

## 6. Counter mechanics gaps

| # | Scenario | Test exists? |
|---|---|---|
| CM-1 | `rejectionCount` increments exactly +1 per reject | YES |
| CM-2 | `rejectionCount` reaches exactly 3 (hint boundary) | YES (`smoke-3:67-121`) |
| CM-3 | `rejectionCount === 4` still emits hint | **GAP** (only `rejectionCount === 7` in injection-builder test; smoke does not cover) |
| CM-4 | `rejectionCount === 100` still emits hint | **GAP** |
| CM-5 | `rejectionCount === Number.MAX_SAFE_INTEGER` | **GAP** |
| CM-6 | `rejectionCount === 0` no hint (falsy guard) | YES (`plan-decision-injection.test.ts:69-73`) |
| CM-7 | `rejectionCount === -1` (negative pathological) — what happens? | **GAP** (`>= 3` would be false; safe but unsanitized) |
| CM-8 | `rejectionCount === NaN` | **GAP** (`>= 3` is false for NaN; safe) |
| CM-9 | `rejectionCount === Infinity` | **GAP** (`>= 3` is true; hint fires — probably correct) |
| CM-10 | Approve mid-cycle resets count to 0 | **GAP — PARITY P0** |
| CM-11 | Edit mid-cycle resets count to 0 | **GAP — PARITY P0** |
| CM-12 | Timeout does NOT reset count | **GAP** (no plugin timeout path) |
| CM-13 | Cancel resets count (or doesn't?) — `exitPlanMode` resets to 0 in the plugin (line 417); is this in spec? | **GAP** (no test pins this semantic) |
| CM-14 | rejectionCount across multiple sessions — isolation | **GAP** |
| CM-15 | rejectionCount carry-over across enter/exit cycle | partial smoke `:156-170` |
| CM-16 | rejectionCount persists across plugin reload | **GAP** (would require InMemory→Persistent gateway test) |
| CM-17 | rejectionCount when state is read with a NEWER schemaVersion | **GAP** (readSnapshot returns undefined per `:516-527`, but no test verifies rejection-flow after that returns) |

---

## 7. Cross-module integration gaps

`store ↔ injection-writer ↔ session-action ↔ live-smoke`

| # | Cross-module flow | Test exists? |
|---|---|---|
| X-1 | `plan.reject` → `recordRejection` → `enqueuePlanDecisionInjection` (happy chain) | YES (session-actions + smoke) |
| X-2 | `recordRejection` returns rejectionCount; handler passes it to injection-writer; writer threads it to `buildPlanDecisionInjection` | partial — `session-actions.test.ts:299-309` checks injection text but not the count VALUE chain |
| X-3 | `STORE_ERROR` from recordRejection propagates to the handler | **GAP** (test only covers recordApproval failure analog) |
| X-4 | Double-click on Reject button: same `expectedApprovalId`, second hits stale guard (because `recordRejection` clears `approvalId` per line 501) → second click is REJECTED with NO_PENDING_APPROVAL | **GAP** (matches the plugin's behavior but UX deserves a regression test — UI would need to re-fetch approvalId before retry) |
| X-5 | User reject + agent re-propose race: agent calls exit_plan_mode while user is mid-reject. Persist hits with new approvalId mid-flight | **GAP** |
| X-6 | Reject → injection drained on next turn → agent re-proposes → rejectionCount=1 carried into pending state | implicit smoke `:156-170` |
| X-7 | Injection queue drain order: if a rejection injection and a question_answer injection both pending, priority/order is correct | **GAP** (in-host injections.ts:52-59 sets priority 10 vs 8; plugin tests do not cover order at all because plugin writes via SDK seam and doesn't manage queue itself) |
| X-8 | Audit emission on the recordRejection path carries `prev.approval === "pending"` and `next.approval === "rejected"` | YES (`store.test.ts:630-641`) |
| X-9 | Audit emission on recordApproval after a series of rejects: count delta visible in prev/next | **GAP** (audit doesn't carry rejection-count delta) |
| X-10 | UI banner state: when plan.reject lands, does the UI receive a notification? — `continueAgent: true` is returned but no test confirms the runtime drains the injection and re-engages the agent | **GAP** (live smoke uses stubbed enqueue; never observes the post-drain prompt) |
| X-11 | Multi-channel race: web client + Telegram bot both have a Reject button. Both click in quick succession — what happens? | **GAP** |
| X-12 | session-action layer's `checkApprovalId` reads via `readSnapshot` (non-locking, line 706-727). If a reject is mid-write the snapshot may be stale | **GAP** (theoretical race; non-trivial to test but architecturally relevant) |

---

## 8. In-host vs plugin parity

### Wording-as-contract: byte-identity check

I diffed the **bytes** of `buildPlanDecisionInjection` between in-host and
plugin.

**Result: BYTE-IDENTICAL for all observed inputs.**

The plugin's port at `src/prompt/plan-decision-injection.ts:47-73` is a
mechanical translation:
- Same opener template `[PLAN_DECISION]: ${decision}`
- Same JSON.stringify(sanitize(feedback)) for feedback line
- Same "Revise your plan based on the feedback and call update_plan again."
  literal
- Same "Multiple revisions have been rejected. Consider asking the user to
  clarify their goal before proposing another plan." literal
- Same timed_out/expired guidance literal
- Same `if (rejectionCount && rejectionCount >= 3)` falsy-guard

**Sanitization byte-identity check:**

The plugin's `sanitize.ts:46` uses `"[​/PLAN_DECISION]"` (escape form);
the in-host at `types.ts:159` uses a literal `"[​/PLAN_DECISION]"` (raw
ZWSP byte). Both produce the same on-wire bytes — but **no test guarantees
this byte-identity**. A regression that re-encodes the source file or strips
the ZWSP would survive all current tests.

**No automated parity oracle exists.** The README-level claim is "byte-
identical port" but the closest thing to a check is a comment.

### Semantic divergences (from G-P0-1..4 above)

| Behavior | In-host (`approval.ts`) | Plugin (`store.ts:recordApproval`) | Severity |
|---|---|---|---|
| Approve resets `rejectionCount` to 0 | YES | NO (spread keeps prior count) | **P0** |
| Approve clears `feedback` | YES (sets `undefined`) | NO (spread keeps prior feedback) | **P0** |
| Approve transitions `mode → "normal"` | YES | NO (mode stays "plan") | **P0** |
| Approve allowed from `rejected` (user re-approves) | YES | NO (skipped with no-pending-approval) | **P0** |
| Edit shares all approve semantics | YES | Same divergences | **P0** |

| Behavior | In-host | Plugin (`recordRejection`) | Severity |
|---|---|---|---|
| Reject clears `approvalId` | NO (kept) | YES (cleared at line 501) | **P1** |
| Reject allowed from `rejected` (re-reject) | YES | NO (skipped with no-pending-approval) | **P1** |
| Reject preserves prior feedback when caller passes `undefined` | YES | YES (spread) | parity |
| Reject increments `(current.rejectionCount ?? 0) + 1` | YES | YES (`current.rejectionCount + 1` — NO `??` guard; would NaN if undefined sneaks in) | **P2** (current state always has count per `DEFAULT_PLAN_MODE_STATE`, but defensive `??` is missing) |

| Behavior | In-host | Plugin | Severity |
|---|---|---|---|
| `timeout` handled at all | YES (state machine case) | **MISSING ENTIRELY** | **P0 for S?** (out of this slice's read-only scope; timeout writer is presumably a separate mutator that A5 did not find) |

---

## 9. Confidence score

**Test coverage confidence: 6.5 / 10**

Breakdown:
- **Sanitization (helpers/sanitize.ts) + buildPlanDecisionInjection (prompt/):
  8/10.** Solid line-ordering + boundary tests. Missing only adversarial
  edge cases (multi-occurrence, Unicode normalization, idempotency on
  already-sanitized input) and the byte-identity oracle to in-host. The
  ADV-1..ADV-18 table above is the gap.
- **rejection-count state machine (store.recordRejection): 7/10.**
  Happy path + skip-paths well-covered; multi-cycle carry-over partial.
  Missing: 4th+ cycle, overflow, isolation, the rejected→rejected
  re-rejection sequence.
- **recordApproval: 4/10.** PARITY DIVERGENCES (G-P0-1..4) are all
  silently locked in by passing tests. The plugin's `recordApproval` is
  observably DIFFERENT from the in-host's approve semantics on FOUR
  load-bearing dimensions, and tests cement the divergence.
- **session-action (`plan.reject`): 7/10.** Happy path + stale-guard +
  count-progression covered. Missing: most error paths reused from
  `plan.accept` tests; non-string feedback; whitespace feedback;
  store-error propagation.
- **injection-writer: 8/10.** Idempotency-key namespacing + metadata
  shape + TTL well-covered. Missing: back-to-back-reject of SAME
  approvalId, and the reject↔approve race-key test.
- **Live smoke: 7/10.** The critical "3rd rejection emits the
  deescalation" assertion is good; the byte-level sanitization check is
  good. Missing: 4th-cycle continuation, approve-mid-cycle reset (the
  semantic the plugin breaks per P0-1), multi-session isolation.
- **Cross-module integration: 5/10.** The happy chain is exercised; the
  store→handler→writer count delta chain is partial; double-click,
  reject↔approve race, multi-channel race, drain-order all unexercised.
- **In-host parity oracle: 2/10.** Plugin claims "byte-identical port"
  in docstrings but no test compares plugin output to the in-host's
  output on a shared input table. The only safety net is human review.

### Top-3 recommendations

1. **Land a parity-oracle test.** Import the in-host
   `buildPlanDecisionInjection` and `sanitizeFeedbackForInjection` into a
   new `tests/parity/plan-decision-injection.parity.test.ts` and run a
   table of ~30 input rows through both, asserting byte-equality of the
   output. This eliminates G-P0-5 and most ADV-* gaps in one shot.
2. **Fix the four `recordApproval` parity divergences (G-P0-1..4) BEFORE
   landing more tests** — otherwise tests cement broken behavior. The
   plugin's `recordApproval` should mirror in-host `approve`/`edit`:
   reset count, clear feedback, transition mode, allow re-approve from
   rejected.
3. **Add the ADV-1..ADV-18 sanitization table and the CM-1..CM-17 counter
   table as two table-driven test files** — the framework already
   supports `it.each` (no new infra needed) and the input universe is
   small enough that 30 + 17 new rows pay for themselves the first time
   a paraphrase regression hits.

---

## Appendix: file-path quick-reference

- `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/approval.ts` (state machine, in-host)
- `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/types.ts:158-207` (buildPlanDecisionInjection + sanitize, in-host)
- `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/approval.test.ts` (in-host tests — useful parity oracle source)
- `/Users/lume/repos/Smarter-Claw/src/prompt/plan-decision-injection.ts:47-98` (plugin builder)
- `/Users/lume/repos/Smarter-Claw/src/helpers/sanitize.ts:42-47` (plugin sanitizer)
- `/Users/lume/repos/Smarter-Claw/src/state/store.ts:465-529` (recordRejection)
- `/Users/lume/repos/Smarter-Claw/src/state/store.ts:541-600` (recordApproval — DIVERGENCES live here)
- `/Users/lume/repos/Smarter-Claw/src/runtime/injection-writer.ts:61-97` (enqueuePlanDecisionInjection)
- `/Users/lume/repos/Smarter-Claw/src/ui/session-actions.ts:310-359` (plan.reject handler)
- `/Users/lume/repos/Smarter-Claw/tests/prompt/plan-decision-injection.test.ts` (25 cases)
- `/Users/lume/repos/Smarter-Claw/tests/state/store.test.ts` (recordRejection + recordApproval cases)
- `/Users/lume/repos/Smarter-Claw/tests/runtime/injection-writer.test.ts` (23 cases)
- `/Users/lume/repos/Smarter-Claw/tests/ui/session-actions.test.ts` (~25 cases)
- `/Users/lume/repos/Smarter-Claw/tests/eva-live-smokes/smoke-3-rejection-cycle.test.ts` (4 cases)
- `/Users/lume/repos/Smarter-Claw/tests/eva-live-smokes/harness.ts` (stub gateway for live smokes)
