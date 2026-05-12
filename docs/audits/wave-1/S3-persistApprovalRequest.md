# Wave-1 Audit — S3 `persistApprovalRequest` 10-invariant typed mutator

**Auditor**: A1 (read-only)
**Date**: 2026-05-12
**Scope**: `PlanModeStore.persistApprovalRequest` in `src/state/store.ts` and the surrounding mutators that share its gateway-driven invariants
**In-host anchor**: `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237` (commit `ea04ea52c7`, race-fix anchor `1081067476`)
**Plugin port**: `/Users/lume/repos/Smarter-Claw/src/state/store.ts`
**Plugin tests**: `/Users/lume/repos/Smarter-Claw/tests/state/store.test.ts`
**Parity harness**: `/Users/lume/repos/Smarter-Claw/parity-harness/`

> **Note on the spec**: the architecture doc `architecture-v2/09-AMENDMENT_1_VERIFICATION.md` referenced in the brief is **not present in the working tree** — neither under `/Users/lume/repos/Smarter-Claw/architecture-v2/` nor anywhere reachable. This audit therefore derives the 10 invariants from the in-host source plus the plugin's own docstrings (which paraphrase the absent doc). **This is itself a P1 risk — the canonical spec is missing**, so any future drift between source-of-truth and plugin has no fixed reference to litigate against.

---

## 1. Slice summary

`PlanModeStore.persistApprovalRequest` is the security-critical typed mutator that arms the plan-approval gate: it transitions a session's plan-mode state to `approval: "pending"` with a fresh `approvalId`, and bundles three race-fix-critical adjacent fields (`title`, `lastPlanPayloadHash`, `lastPlanSteps`) into the SAME atomic write. The function encodes ten interlocking invariants — atomic lock-around-read+update (5+6), a 4-conjoined idempotency guard (3+7) preventing approvalId rotation when a duplicate `exit_plan_mode` fires with the same payload hash, deliberate audit-skip on the reuse path (9), and IO-error fail-soft (8) so callers always receive an `approvalId` they can bind UI to. The race fix at commit `1081067476` (the empty-plan-body race) made invariant 1 — sync bundle write — load-bearing for correctness, not just performance. Regressions on any single invariant can deliver wrong `approvalId` to a user (data corruption / security), silently degrade audit emission, or re-introduce the orphan-card / empty-injection bugs Eva surfaced.

---

## 2. Documented contracts

### From `pi-embedded-subscribe.handlers.tools.ts:106-237` (in-host source-of-truth)

1. **Race-fix bundle (invariant 1)**. `approvalId`, `title`, `lastPlanPayloadHash`, `lastPlanSteps` write **synchronously in a single update callback**, before any `agent_approval_event` broadcast.
2. **Precondition: mode==="plan" (invariant 2)**. If the session has no plan-mode payload OR `current.mode !== "plan"`, return `null` (no write, no transition, no audit).
3. **4-conjoined idempotency (invariants 3+7)**. ALL FOUR must hold to reuse the persisted `approvalId`:
   - `payloadHash` (the candidate input) is truthy
   - `current.lastPlanPayloadHash === payloadHash` (hash match)
   - `current.approval === "pending"` (cycle still live)
   - `typeof current.approvalId === "string" && current.approvalId.length > 0` (existing id present)
4. **Audit emission on persist (invariant 4)**. Calls `logPlanModeApprovalTransition(sessionKey, current, nextPlanMode, "pi-embedded-subscribe:persistPlanApprovalRequest")` on the persist branch.
5. **Atomic lock-around-read+update (invariant 5)**. Wrapped by `updateSessionStoreEntry` which acquires a per-session lock BEFORE invoking the `update(entry)` callback.
6. **Fresh-read inside the lock (invariant 6)**. The callback receives the latest entry from disk, not a cached projection.
7. **(Decomposed in 3) — the 4 sub-conditions are listed separately so a 3-of-4 partial match still falls through to the rotate path.**
8. **IO-error fail-soft (invariant 8)**. `try/catch` wraps the whole flow; failure logs at `warn`; returns the candidate `approvalId` so caller proceeds. Never throws.
9. **Audit-skip on reuse (invariant 9)**. Reuse branch returns `null` from the update callback AND deliberately omits the `logPlanModeApprovalTransition` call — "Skip the approval_transition event too since nothing transitioned" (in-host comment line 202-204).
10. **Lazy-imports (invariant 10)**. `Promise.all` imports the SDK modules on first call. Documented in plugin as "N/A — plugin is self-contained" — but the plugin's `SessionStoreGateway` DOES preserve this via `loadSdk()` lazy-init.

### Plugin extensions beyond the in-host (documented in `store.ts`)

- **Discriminated-union result (`PersistApprovalRequestResult`)**. 4 variants: `persisted` / `reused` / `skipped` / `failed`. Every variant carries an `approvalId` field so callers can bind UI regardless of branch.
- **`skipped.reason`** is `"not-plan-mode" | "missing-fields"` — but the implementation only ever sets `"not-plan-mode"`. The `"missing-fields"` discriminant is documented in the type but UNUSED in code (gap, see §4).
- **Schema-version stamping**. Every successful write passes through `stampSchemaVersion(next)`. Reuse + skipped + failed paths do NOT stamp (no write happens).
- **State preservation**. Spread `...current` preserves `feedback`, `rejectionCount`, `enteredAt`, `approvalRunId`, `confirmedAt`, `autoApprove` across the write.
- **Field-truthiness rules (Invariant 1 bundle)**.
  - `title` writes only if `title !== undefined && title !== ""` (in-host uses `?` truthy check only).
  - `payloadHash` writes only if `payloadHash !== undefined && payloadHash !== ""`.
  - `lastPlanSteps` writes only if `lastPlanSteps && lastPlanSteps.length > 0`.
- **`updatedAt: now`** is always written on persist.
- **`approval: "pending"`** is always set (even if `current.approval === "rejected"` — the rotation path resets to pending).
- **Logger contract**. On failure, the warning message format is `PlanModeStore.persistApprovalRequest: failed to persist (sessionKey=${sessionKey}): ${err.message}`.

### Caller contract (from `pi-embedded-subscribe.handlers.tools.ts:1862-1886`)

- Caller passes `details.title`, `details.payloadHash`, `details.plan` mapped to `lastPlanSteps`.
- Caller uses `persistResult.approvalId` (NOT the candidate) for the downstream `agent_approval_event`. **This is the security boundary**: emitting the candidate when reuse fired would orphan the existing card.
- Caller emits a `log.warn` "exit_plan_mode duplicate detected" when `reused === true`.

---

## 3. Test coverage matrix

| # | Contract / behavior | Test file:line(s) | Status |
|---|---------------------|-------------------|--------|
| C1 | Persist when in plan mode | `store.test.ts:75-83` | COVERED |
| C2 | Skip when no plan-mode payload | `store.test.ts:53-62` | COVERED |
| C3 | Skip when in normal mode | `store.test.ts:64-73` | COVERED |
| C4 | Skip when mode is some other string | — | **GAP** (mode field defined `"plan"|"normal"` but spread-from-disk could land any value) |
| C5 | approvalId persisted in single write | `store.test.ts:96-104` | COVERED |
| C6 | title persisted in same write | `store.test.ts:106-116` | COVERED |
| C7 | lastPlanSteps persisted in same write | `store.test.ts:118-132` | COVERED |
| C8 | payloadHash persisted in same write | `store.test.ts:134-144` | COVERED |
| C9 | ALL FOUR race-fix fields in ONE write | `store.test.ts:146-162` | COVERED |
| C10 | Pre-existing fields preserved (feedback/rejectionCount/enteredAt) | `store.test.ts:164-182` | COVERED |
| C11 | approval reset to "pending" from any prior state | `store.test.ts:184-191` (rejected only) | **PARTIAL** — tests rejected→pending; missing approved→pending, edited→pending, timed_out→pending |
| C12 | Reuse when all 4 conjuncts hold | `store.test.ts:213-223` | COVERED |
| C13 | Rotate when payloadHash absent (conj 1) | `store.test.ts:225-235` | COVERED |
| C14 | Rotate when payloadHash mismatched (conj 1) | `store.test.ts:237-246` | COVERED |
| C15 | Rotate when state not pending — approved (conj 2) | `store.test.ts:248-257` | COVERED |
| C16 | Rotate when state rejected (conj 2) | `store.test.ts:259-267` | COVERED |
| C17 | Rotate when state is "none" (conj 2) | — | **GAP** (likely the most common race — agent calls exit_plan_mode immediately after enter_plan_mode) |
| C18 | Rotate when state is "edited" (conj 2) | — | **GAP** |
| C19 | Rotate when state is "timed_out" (conj 2) | — | **GAP** |
| C20 | Rotate when persisted approvalId is undefined (conj 3) | `store.test.ts:269-277` | COVERED |
| C21 | Rotate when persisted approvalId is empty string (conj 4) | `store.test.ts:279-287` | COVERED |
| C22 | Rotate when persisted approvalId is non-string type (conj 4) | — | **GAP** — `typeof current.approvalId === "string"` is the actual guard; coverage relies on TS prevent it but the persisted state comes from disk JSON, which could legally contain anything (e.g. null, number) under schema drift |
| C23 | Rotate when payloadHash is empty string (conj 1) | — | **GAP** — the code uses `payloadHash !== undefined` for the conjunct (truthy check). Empty string would short-circuit to falsy → rotate. Tests don't pin this. |
| C24 | Reuse returns the EXISTING approvalId (not candidate) | `store.test.ts:213-223` (asserts equality) | COVERED |
| C25 | Reuse: NO write happens (writeCount stays 0) | `store.test.ts:222` | COVERED |
| C26 | Audit emitted on persist | `store.test.ts:301-312` | COVERED |
| C27 | Audit SKIPPED on reuse | `store.test.ts:314-329` | COVERED |
| C28 | Audit SKIPPED on skipped path | `store.test.ts:331-339` | COVERED |
| C29 | Audit payload has prev + next | `store.test.ts:341-350` | COVERED |
| C30 | Audit SKIPPED on failed path | — | **GAP** — there's no test asserting that when the gateway throws, audit is NOT emitted. The catch block runs after the gateway returns, but if the audit emit path itself throws, the result is undefined — there's no negative-disclosure test |
| C31 | IO-error returns kind:"failed" + candidate approvalId | `store.test.ts:354-377` | COVERED |
| C32 | IO-error never throws | `store.test.ts:379-399` | COVERED |
| C33 | IO-error logs warning message | `store.test.ts:375-376` | COVERED |
| C34 | All 4 result kinds carry approvalId | `store.test.ts:411-445` (missing `failed`) | **PARTIAL** — comment says "failed — covered in the IO-error suite" but the contract that the `failed` variant carries the **candidate** approvalId (not undefined, not the persisted one) is asserted only in C31 inside the IO suite. Acceptable, but cross-suite. |
| C35 | __schemaVersion stamped on persist | `store.test.ts:458-467` | COVERED |
| C36 | __schemaVersion NOT stamped on reuse (no write) | `store.test.ts:469-490` | COVERED |
| C37 | __schemaVersion NOT stamped on skipped path | — | **GAP** — covered indirectly by writeCount==0 but no positive assertion |
| C38 | __schemaVersion NOT stamped on failed path | — | **GAP** — gateway throws so no write reaches state, but no positive assertion |
| C39 | Forward-compat: future __schemaVersion not stamped over | — | **GAP** — what happens if disk says `__schemaVersion: 99`? Code stamps it back down to 1 via `stampSchemaVersion(next)`. This is a SILENT DOWNGRADE on every successful write. Defense-in-depth needed. |
| C40 | readSnapshot returns undefined when schemaVersion > current | `store.test.ts:516-527` | COVERED |
| C41 | persistApprovalRequest does NOT honor forward-compat schemaVersion gate | — | **GAP** — `readSnapshot` refuses to return future-version states, but `persistApprovalRequest` happily reads them via `withLock` and writes them back stamped to current. A future-stamped session is silently downgraded on first persist. |
| C42 | Lock acquires BEFORE read (invariant 5) | — | **GAP — encapsulated in gateway, no direct test in the plugin suite** |
| C43 | Fresh read inside lock (invariant 6) | — | **GAP — same, gateway internal** |
| C44 | Two concurrent persistApprovalRequest serialize | — | **GAP** — no concurrency test |
| C45 | InMemoryGateway serializes correctly under interleaved withLock | — | **GAP** — gateway code uses a promise-chain lock but has no test asserting serialization (`tests/state/in-memory-gateway.ts` is just a re-export shim) |
| C46 | Concurrent persistApprovalRequest with same payloadHash: reuse fires consistently | — | **GAP** |
| C47 | Concurrent persist + recordRejection: deterministic ordering | — | **GAP** — race between user rejecting and agent re-proposing |
| C48 | Concurrent persistApprovalRequest with DIFFERENT payloadHashes: last-write-wins is correct | — | **GAP** |
| C49 | enterPlanMode→exitPlanMode→persistApprovalRequest within same session is correct | — | **GAP** — multi-mutator interleaving not tested |
| C50 | Caller-contract: reused result returns EXISTING approvalId for UI binding | `store.test.ts:421-433` | COVERED |
| C51 | Caller-contract: failed result returns CANDIDATE approvalId | `store.test.ts:354-377` | COVERED |
| C52 | Caller-contract: skipped result returns CANDIDATE approvalId | `store.test.ts:436-443` | COVERED |
| C53 | Title-truthiness: empty string falls through (no write of title) | — | **GAP** — code uses `title !== undefined && title !== ""`; in-host uses `details.title ? {...} : {}` (just truthy). Plugin and host AGREE on rejecting empty string. No test pins this. |
| C54 | Title-truthiness: whitespace-only string DOES persist | — | **GAP** — `"   "` passes the truthy check. Is that intended? In-host has no docstring on it. |
| C55 | PayloadHash-truthiness: empty string falls through (no write of hash) | — | **GAP** |
| C56 | LastPlanSteps: empty array short-circuits the write of the field | — | **GAP** — code uses `.length > 0`. Pinned via Inv1 bundle test but not as a negative-disclosure. |
| C57 | LastPlanSteps: array with steps containing missing/empty `step` field | — | **GAP** — sanitization is not done in store; if upstream is broken the bad data persists |
| C58 | Spread-clobber: caller-provided field reaches disk with original key (no aliasing) | — | **GAP** |
| C59 | sessionKey is propagated through to gateway + audit | `store.test.ts:308` + `347` | COVERED (assertion via `.sessionKey`) |
| C60 | audit source string matches "smarter-claw:PlanModeStore.persistApprovalRequest" | `store.test.ts:311` (regex `.toContain("persistApprovalRequest")`) | **PARTIAL** — doesn't assert full source string, future-rename-safe but doesn't pin the contract |
| C61 | Bundle write: title with special characters (quotes, newlines, unicode) | — | **GAP** — security: title is user-controlled via exit_plan_mode args. Persistence + later read-back should preserve bytes exactly. |
| C62 | Bundle write: very long title (e.g. >10KB) doesn't truncate | — | **GAP** |
| C63 | Bundle write: lastPlanSteps with >100 steps doesn't truncate | — | **GAP** |
| C64 | Bundle write: lastPlanSteps with activeForm field is preserved | — | **GAP** — `PlanStep.activeForm` is optional; bundle spread preserves it but no test pins this |
| C65 | Idempotency: hash match but `approval === "pending"` AND `current.approvalId === ""` → ROTATE (4th conjunct fails) | `store.test.ts:279-287` | COVERED (this IS test C21) |
| C66 | Reuse: candidate's snapshot fields (title, lastPlanSteps) are IGNORED on reuse path | — | **GAP** — if reuse fires but the candidate brought a new `title` (perhaps the user edited title mid-flight), the old title remains. Tests don't assert this. Could be wrong behavior worth pinning. |
| C67 | Reuse: candidate approvalId is NOT logged or leaked anywhere | — | **GAP** — the warn log on duplicate could include candidate; not asserted |
| C68 | sessionKey is treated as opaque string (no parsing assumptions) | — | **GAP** — gateway uses it as map key only; safe by code-inspection but no test |
| C69 | Default-deny for malformed `current` (e.g. shape from a future version) | `store.test.ts:516-527` (covers readSnapshot only) | **PARTIAL** — persistApprovalRequest does NOT default-deny; it proceeds and overwrites with current schemaVersion (silent downgrade) |
| C70 | persistResult.approvalId is the value the caller MUST emit on the event (host_ref:1881) | — | **GAP** — there's no contract-test asserting "callers reading r.approvalId after reuse get the persisted, not the candidate." The discriminated-union shape implies it; no integration test pins it. |
| C71 | Audit emitter throwing does not propagate | — | **GAP** — if `audit({...})` throws synchronously, the exception propagates to the catch block, which then returns `failed`. But the persist has already happened (write went through). This silently turns a successful persist into a `failed` result, leaking state inconsistency. |
| C72 | Audit emitter throwing async (returns rejecting Promise) | — | **GAP** — audit is typed as void return; async throws are uncovered |
| C73 | Logger throwing does not propagate | — | **GAP** — failure path calls `this.logger?.warn?.(...)` inside the catch block; if logger throws, the failed-result path itself throws |
| C74 | State transition matrix: 5 approval × 5 approval = 25 transitions; not 16 as brief says | See § "State-transition matrix gap" below | **GAP** |
| C75 | Parity harness has cases for: skipped, reuse-all-match, rotate-all-four-conjuncts, persist-fresh, persist-bundle | `parity-harness/inputs/persistApprovalRequest.json` | COVERED |
| C76 | Parity harness has cases for: rotate-from-edited, rotate-from-timed_out, rotate-from-none | — | **GAP** — parity inputs cover `approved`, `rejected`, missing-approvalId, empty-approvalId. Don't cover `none`, `edited`, `timed_out` |
| C77 | Parity harness has cases for: title=empty-string, payloadHash=empty-string, lastPlanSteps=empty-array | — | **GAP** |
| C78 | Parity harness reference fails parity when host implementation changes | — | **STRUCTURAL GAP** — the reference is a hand-rolled port in `host-reference.ts`. It's NOT the actual in-host code. If the in-host changes (e.g. adds a 5th conjunct) and `host-reference.ts` isn't manually updated, the harness passes spuriously. README warns about this but there's no automated check. |
| C79 | Parity harness covers the `failed` (IO-error) branch | `plugin-under-test.ts:53-63` (maps to skipped) | **PARTIAL** — comment notes "P-3.5's inputs.json doesn't include failure cases" — failures are unmodeled in parity |
| C80 | Caller-contract enforcement test (someone consuming PlanModeStore actually reads r.approvalId correctly per kind) | — | **GAP — outside this slice, but worth flagging** |

### State-transition matrix gap

The brief says "16 cases for 4 approval states." There are actually 5 approval values (none, pending, approved, edited, rejected) plus `timed_out` makes 6. Cases are 6×6=36 transitions. The actual test coverage of `prev.approval → next.approval` transitions for `persistApprovalRequest`:

| prev.approval | candidate behavior | next.approval | covered? |
|---|---|---|---|
| `none` (rotate, hash-mismatch) | persist | pending | **GAP** (only "default" tested via `planModeSession({mode:"plan"})` which has `approval: "none"` — implicitly covered) |
| `pending` (hash match all 4) | reuse | (unchanged) | C12 |
| `pending` (hash mismatch) | persist (rotate) | pending | C14 |
| `pending` (no candidate hash) | persist (rotate) | pending | C13 |
| `approved` | persist (rotate, conj 2 fail) | pending | C15 |
| `rejected` | persist (rotate, conj 2 fail) | pending | C16, also tested at C11 |
| `edited` | persist | pending | **GAP C18** |
| `timed_out` | persist | pending | **GAP C19** |

So 6 of the 36 prev→next transitions are tested (with one assertion of `approval=pending` post-write that's been verified for two states only). The brief's "16 cases" undercounts; the actual gap is larger.

---

## 4. Testing gaps — severity-ranked

### P0 — wrong approvalId / security / data corruption

**G-P0-1 (C66) — Reuse path silently discards updated `title` / `lastPlanSteps` / `payloadHash`-input**
- *What's missing*: a test pinning that the reuse path's IGNORE of the candidate's bundle fields is documented behavior, not a bug.
- *Why it matters*: if a user inline-edits a title (mid-flight; agent retries with same payload but new title), the old title remains. UI would render stale data. The in-host comment line 202-204 says "No write — entry already has the right state" — this is correct IF the contract is "same payload hash = same display state." But if the host caller stripped title from the hash computation (e.g. in `helpers/payload-hash.ts`, title IS in the hash → no problem; but a future refactor that strips title from hash would silently regress UI consistency).
- *Suggested test shape*:
  ```
  it("reuse path ignores candidate title/steps even when they differ from persisted")
  // Seed: state with title="OLD", payloadHash="h"
  // Call: persistApprovalRequest({approvalId: <new>, title: "NEW", payloadHash: "h", ...})
  // Assert: kind=reused, peek().title === "OLD" (deliberately stale)
  ```

**G-P0-2 (C22) — Persisted `approvalId` of unexpected type bypasses idempotency**
- *What's missing*: test where `current.approvalId` is `null`, `42`, `{}`, or another non-string.
- *Why it matters*: the disk source is JSON. `typeof "string" && length > 0` is the guard, but TS's static typing doesn't reach the disk read. A malicious or corrupted session.json with `approvalId: { evil: "object" }` would: (a) `typeof === "object"` → conj 4 fails → ROTATE → the persisted weird object gets overwritten with a clean string. That's actually the SAFE path. BUT if `approvalId: 0` (number) → `typeof === "number"` → conj 4 fails → ROTATE → safe. **The actual security concern**: what if `approvalId: "valid-uuid"` but `approval` was tampered to `"approved"` while the agent is mid-flight? Conj 2 fails → ROTATE — but during ROTATE the spread `...current` preserves the tampered fields. No defensive `if (!isPlanApprovalId(current.approvalId))` exists.
- *Suggested test shape*:
  ```
  it("rejects malformed persisted approvalId types")
  // Seed: { mode: "plan", approval: "pending", approvalId: 42, lastPlanPayloadHash: "h" }
  // Call: persistApprovalRequest({approvalId: <new>, payloadHash: "h"})
  // Assert: kind=persisted (NOT reused; the 4th conjunct caught the bad type)
  // Assert: peek().approvalId === <new candidate> (new, valid string)
  ```

**G-P0-3 (C39, C41) — Forward-compat: silent schemaVersion downgrade on write**
- *What's missing*: test for "session was written by a v2 plugin (schemaVersion=2), v1 plugin then calls persistApprovalRequest."
- *Why it matters*: `persistApprovalRequest` reads current via `withLock`, computes next, calls `stampSchemaVersion(next)` which writes `__schemaVersion: 1` over the disk's `2`. The session now claims to be v1, but may have v2-only fields in the spread. This is the OPPOSITE of `readSnapshot`'s defense (which refuses to read future-version states). Mixed-version plugin fleets would silently downgrade each other's writes.
- *Suggested test shape*:
  ```
  it("persistApprovalRequest refuses to write when persisted __schemaVersion > CURRENT")
  // Seed: state with __schemaVersion = CURRENT + 99
  // Call: persistApprovalRequest(...)
  // Assert: kind=failed (or kind=skipped reason="schema-mismatch")
  // Assert: peek().__schemaVersion === CURRENT + 99 (unchanged)
  ```
  **NOTE**: this is currently NOT implemented — the test would FAIL today. The audit-report's recommendation is to GAP the test AND the behavior. (Adding the test alone would surface the wrong behavior.)

**G-P0-4 (C44, C46, C47, C48) — No concurrency tests at all**
- *What's missing*: every concurrency-related invariant is encapsulated in the gateway with NO test exercising it. The in-memory gateway uses a promise-chain lock but the chain depth, race-window, and serialization ordering are uncovered.
- *Why it matters*: the WHOLE POINT of invariant 5+6 is to prevent races. A buggy gateway impl that races without locking is the exact failure mode of the empty-plan-body race that motivated this slice.
- *Suggested test shape*:
  ```
  it("two concurrent persistApprovalRequest with SAME payloadHash both observe reuse")
  // Setup: gateway with artificially slow update (microtask boundary inside update)
  // Seed: state in pending with valid approvalId, hash="h"
  // Race: Promise.all([store.persistApprovalRequest({hash:"h", id:"a"}), store.persistApprovalRequest({hash:"h", id:"b"})])
  // Assert: BOTH return kind=reused with EXISTING approvalId
  // Assert: writeCount === 0
  ```
  ```
  it("concurrent persistApprovalRequest with different hashes serialize, last-writer wins")
  // Race: two persists with different hashes
  // Assert: gateway.writeCount === 2
  // Assert: peek().approvalId is one of the two candidates (deterministic from chain order)
  // Assert: peek().lastPlanPayloadHash matches the winner
  ```

**G-P0-5 (C45) — In-memory gateway itself has zero tests**
- *What's missing*: `tests/state/in-memory-gateway.ts` is a re-export shim. The real implementation at `src/state/in-memory-gateway.ts` has NO dedicated test file. The promise-chain lock semantics, structured-clone defense, writeCount accuracy under failure paths, are all untested.
- *Why it matters*: the gateway IS the security boundary (invariants 5+6). The Plan Mode Store's correctness is contingent on the gateway being correct. Untested = unverified.
- *Suggested test shape*: a dedicated `tests/state/in-memory-gateway.test.ts` with:
  - `withLock serializes two interleaved callbacks for same sessionKey`
  - `withLock does NOT serialize callbacks for different sessionKeys`
  - `Fresh-read inside lock: update callback observes mutations from prior withLock call`
  - `update callback throwing releases the lock (next withLock proceeds)`
  - `Update callback returning {next: null} does NOT increment writeCount`
  - `Update callback returning non-null clones the next state (mutation-by-reference defense)`

**G-P0-6 (C76, C77, C78, C79) — Parity harness has structural gaps**
- *What's missing*: parity inputs don't cover (a) the `none`/`edited`/`timed_out` approval states, (b) empty-string snapshot fields, (c) the IO-error / failed branch, (d) no test detects when `host-reference.ts` drifts from the actual in-host code.
- *Why it matters*: this slice is BUILT on the parity-harness gate. If the harness has blind spots, plugin-vs-host drift is undetected.
- *Suggested test shape*: add 8+ cases to `parity-harness/inputs/persistApprovalRequest.json`:
  - `rotate-from-none` (the most common state after `enter_plan_mode`)
  - `rotate-from-edited`
  - `rotate-from-timed_out`
  - `persist-with-empty-string-title` (negative — title NOT written)
  - `persist-with-empty-string-payloadHash` (negative — hash NOT written)
  - `persist-with-empty-steps-array` (negative — steps NOT written)
  - `reuse-with-additional-candidate-title` (test C66 above)
  - Add a comment/README requiring host-reference.ts to be audited every commit that touches the in-host persistPlanApprovalRequest.

### P1 — silent behavior degradation

**G-P1-1 (C11, C17-C19) — Incomplete prev→next state-transition matrix**
- *What's missing*: tests pinning persist behavior from `approval: "none"`, `"edited"`, `"timed_out"`. Three of the six valid prev states are uncovered for the persist branch.
- *Why it matters*: a regression making `approval: "edited"` falsely match the `approval === "pending"` conjunct (e.g. a string-comparison bug or enum widening) would let the reuse path fire on edited-then-resubmitted plans, silently keeping the OLD approvalId active when the user expected the new edited version.
- *Suggested test shape*:
  ```
  describe("prev→next transitions on persistApprovalRequest")
    .each(["none", "pending", "approved", "edited", "rejected", "timed_out"])
    .it("transitions from %s to pending on rotate", ...)
  ```

**G-P1-2 (C30) — Failed path doesn't assert audit-NOT-emitted**
- *What's missing*: a test asserting `audit` mock has zero calls when gateway throws.
- *Why it matters*: invariant 9 in spirit (no audit when no real transition) should extend to the failed branch. A future refactor that moves audit emission INSIDE the try block (correct) vs OUTSIDE (would emit on failed) would silently fire audits for non-events.
- *Suggested test shape*:
  ```
  it("does NOT emit audit on the failed path")
  // brokenGw + audit mock
  // Call persistApprovalRequest
  // Assert: r.kind === "failed" AND audit.mock.calls.length === 0
  ```

**G-P1-3 (C71, C72, C73) — Emitter / logger failure modes**
- *What's missing*: tests for `audit` throwing (sync + async), `logger.warn` throwing.
- *Why it matters*: if `audit({...})` throws — e.g. event-bus disconnected — the exception escapes the inner try (audit is called OUTSIDE `gateway.withLock`'s try). Result: the persist already happened, the write is on disk, but the function returns `kind: "failed"` (caught by the outer catch). The caller sees `failed`, the disk has new state, the audit log doesn't have the event. State + audit inconsistency.
- *Suggested test shape*:
  ```
  it("propagates audit-throw to the outer catch, leaking state-audit-inconsistency")
  // audit = vi.fn(() => { throw new Error("event bus down") })
  // Seed plan mode
  // Call persistApprovalRequest
  // Assert: r.kind === "failed"
  // Assert: gw.peek() has the new approvalId (WRITE HAPPENED)
  // Mark this as a documented behavior (or fix the code to swallow audit errors).
  ```

**G-P1-4 (C60) — Audit source string is a contract, not just a substring**
- *What's missing*: assertions pinning the EXACT source string (`"smarter-claw:PlanModeStore.persistApprovalRequest"`).
- *Why it matters*: downstream consumers (log analytics, parity-harness, debugging) may grep on this string. A rename would silently break those consumers.
- *Suggested test shape*:
  ```
  it("audit event source is the documented constant")
  // ... call ...
  // Assert: call.source === "smarter-claw:PlanModeStore.persistApprovalRequest"
  // (use === not toContain)
  ```

**G-P1-5 (C53, C54, C55, C56) — Field-truthiness rules not pinned**
- *What's missing*: tests asserting that empty-string `title`, empty-string `payloadHash`, empty `lastPlanSteps` array DO NOT write the corresponding field but DO still write approvalId + approval=pending + updatedAt.
- *Why it matters*: the in-host uses `details.title ? {title} : {}` (truthy) and the plugin uses `title !== undefined && title !== ""` (explicit). Both reject empty string. A future refactor relaxing to `title != null` would persist `""`, blanking out prior title (since spread before override). Tests don't pin which "absent" semantic is intended.
- *Suggested test shape*:
  ```
  it("empty-string title does NOT override prior title (truthy-check defense)")
  // Seed: state with title="Existing"
  // Call: persistApprovalRequest({approvalId, title: ""})
  // Assert: peek().title === "Existing" (preserved)
  // Same for "   " (whitespace-only)
  ```

**G-P1-6 (C58, C64) — activeForm field of PlanStep not pinned for preservation**
- *What's missing*: a test confirming `lastPlanSteps[i].activeForm` survives the persist.
- *Why it matters*: `activeForm` is a UI hint (present-continuous form like "Bumping eslint"). If a refactor switches to `pick("step", "status")`, activeForm silently disappears.
- *Suggested test shape*:
  ```
  it("preserves lastPlanSteps activeForm through persist")
  // Seed plan-mode
  // Call: persistApprovalRequest(..., lastPlanSteps: [{step, status, activeForm: "Doing X"}])
  // Assert: peek().lastPlanSteps[0].activeForm === "Doing X"
  ```

**G-P1-7 (C69) — `skipped.reason: "missing-fields"` is dead code in the discriminated union**
- *What's missing*: the `PersistApprovalRequestResult` type declares `skipped.reason: "not-plan-mode" | "missing-fields"`, but the implementation never emits `"missing-fields"`. Either the implementation should default-deny on missing inputs (and emit `"missing-fields"`), or the type should remove the variant.
- *Why it matters*: a caller doing exhaustiveness checking handles a path that never fires. Or — worse — the contract claims a defense the code doesn't provide. Today: pass `approvalId: ""` (empty candidate) → no validation in store → empty approvalId persists to disk. Downstream consumers (UI binding, sessions-patch matcher) treat empty as no-id.
- *Suggested test shape*:
  ```
  it("rejects empty-string candidate approvalId with kind=skipped reason=missing-fields")
  // Seed plan mode
  // Call: persistApprovalRequest({approvalId: ""})
  // Assert: kind === "skipped" && reason === "missing-fields"
  // Assert: peek().approvalId is NOT "" (unchanged)
  ```
  Note: today this test would FAIL (the code currently lets `""` through).

**G-P1-8 (C61, C62, C63) — Adversarial payload sizes / characters**
- *What's missing*: tests for very long title, special characters, unicode, control chars.
- *Why it matters*: title is rendered downstream. If the persistence path corrupts/truncates, UI breaks. JSON.stringify defensiveness is implicit but unpinned. Also: an attacker-controlled `title: "valid'><script>"` should round-trip byte-identically (sanitization happens at render time, not persistence time).
- *Suggested test shape*:
  ```
  it("preserves long titles + special characters byte-identically")
  // Seed plan mode
  // Call: persistApprovalRequest({title: "a".repeat(10_000) + "\n\"<>"})
  // Assert: peek().title === input title
  ```

**G-P1-9 (C42-C49) — Cross-mutator integration**
- *What's missing*: tests that exercise `enterPlanMode → recordRejection → persistApprovalRequest` flows in sequence.
- *Why it matters*: each mutator is unit-tested in isolation. The PR-9 adversarial review comment ("nudges grow unbounded on repeated enter_plan_mode") suggests cross-mutator interactions are a known risk area.
- *Suggested test shape*:
  ```
  describe("multi-mutator flows")
    it("enter→reject→persist preserves rejectionCount")
    it("persist→reject→persist increments rejectionCount, rotates approvalId")
    it("persist→approve has no double-fire if approval event re-fires (idempotency on recordApproval)")
    it("setAutoApprove(true) followed by persist immediately auto-approves on next exit")
  ```

### P2 — robustness / defense-in-depth

**G-P2-1 (C37, C38) — Negative __schemaVersion stamping assertions**
- *What's missing*: positive assertions that skipped+failed paths leave __schemaVersion untouched.
- *Why it matters*: defense in depth; pins the invariant 8 + 9 (no-write paths) at the level of schema metadata too.

**G-P2-2 (C57) — Sanitization of malformed PlanStep elements**
- *What's missing*: passing `lastPlanSteps: [{step: "", status: "pending"}]` or `[{step: "x", status: 42 as any}]`.
- *Why it matters*: the bundle persists garbage. UI breaks downstream.

**G-P2-3 (C50, C51, C52, C70) — Caller-contract integration test**
- *What's missing*: a downstream test that simulates the in-host caller pattern (read `r.approvalId`, emit `approval_event`, log on `reused`).
- *Why it matters*: the contract that "callers MUST use r.approvalId, not the candidate, especially on reuse" is the security property. No test wires the caller pattern; the only proof is reading the in-host code.

**G-P2-4 (C68) — sessionKey opacity assumption**
- *What's missing*: a test passing sessionKey with `:`, `/`, unicode, very long, empty string.
- *Why it matters*: the gateway stores it as map key. Edge cases may break the SessionStoreGateway's `parseAgentSessionKey` path (which currently falls back to a regex).

**G-P2-5 (C67) — Log redaction of secrets**
- *What's missing*: assertion that the failure-warn log does NOT include the candidate approvalId (or any plan-mode payload that could be sensitive). Today, no asserts on log content; the format string includes sessionKey but not approvalId. A future refactor that adds approvalId to the log would leak it.

**G-P2-6 (C40) — readSnapshot bypass via withLock**
- *What's missing*: assertion that `readSnapshot` is the ONLY public read API. Today, anyone with a gateway reference can call `gateway.withLock(...)` with a no-op update and read state without going through schemaVersion check.
- *Why it matters*: `gateway` is private but architectural-level. If a future feature exposes the gateway, the schemaVersion forward-compat guard is bypassable.

**G-P2-7 (C75 caveat) — Parity harness uses an in-line port instead of importing the in-host code**
- *What's missing*: a build-step (or CI gate) that diffs `host-reference.ts` against the actual in-host source.
- *Why it matters*: today the parity harness compares two implementations BOTH owned by the plugin team. The "in-host reference" is itself a port. Drift between the real in-host and `host-reference.ts` is undetected. A symlink + manual review process isn't a hard guarantee.

**G-P2-8 — Missing canonical-spec doc**
- *What's missing*: `architecture-v2/09-AMENDMENT_1_VERIFICATION.md` is referenced in the docstring + plan but does not exist on disk.
- *Why it matters*: future maintainers have no normative source-of-truth. The docstring at `store.ts:9-21` lists the 10 invariants but is itself code-comment-source — losable on a careless refactor.

---

## 5. Adversarial questions

A hostile reviewer would ask these, and the current tests CAN'T answer:

1. **"Show me the test that proves two concurrent `exit_plan_mode` invocations with the same payload don't double-mint approvalIds."** Answer: no such test exists. The in-memory gateway has a lock but no test of the lock under concurrent load.

2. **"What happens if disk holds a session written by a future plugin version that has `approval: 'new_state_we_haven_t_invented_yet'`?"** Answer: `current.mode !== "plan"` MIGHT be false (mode is "plan"), and the 4-conjunct guard reads `current.approval === "pending"` — the unknown state isn't "pending", so it ROTATES (overwrites with "pending"). The future-state data point is destroyed. No test pins this behavior.

3. **"Prove that the audit event is NEVER emitted when no write happens."** Answer: tested for the reuse path (C27), the skipped path (C28), but NOT for the failed path. A future refactor might emit on failed.

4. **"What does the candidate approvalId look like when reuse fires? Could it leak into the audit event by accident?"** Answer: audit is skipped on reuse (C27), so it can't leak into audit. But there's no assertion that the candidate isn't logged elsewhere (e.g. via a stray `console.log` left in). Trust-but-not-verified.

5. **"What's the behavior if the gateway is correct but `audit` throws AFTER the write committed?"** Answer (by reading code, not tests): the write is persisted, the function returns `kind: "failed"`. The caller reads `failed` and treats it as no-write. Reality: state is corrupted, agent doesn't know. **This is a real bug, exposed by analysis, not by tests.**

6. **"Why does `persistApprovalRequest` lower the `__schemaVersion` on every write, but `readSnapshot` refuses to read future versions?"** Answer: asymmetric. The intent is unclear from code — is the policy "always downgrade to current" or "refuse to touch future versions"? Both have plausible-sounding justifications. The lack of test pins either way.

7. **"Show me the test asserting `gateway.withLock` is reentrancy-safe (same sessionKey called inside the callback)."** Answer: no test. The in-memory gateway would deadlock (the inner `withLock` waits for `prior` which is the current call). Untested = unknown contract.

8. **"What's the worst-case write amplification under retry storms?"** Answer: each call writes ONCE, OR reuses ONCE (no write). But under a rotate path the spread `...current` writes all 8 fields every time. Unbounded retries with mismatched hashes mean unbounded writes. Tests don't model rate-limiting or backoff.

9. **"What's the rejectionCount monotonicity guarantee across persistApprovalRequest cycles? Does a fresh persist reset it?"** Answer: it does NOT reset (preserved via spread). Tests cover this for `feedback` (C10) and indirectly for `rejectionCount` (C10 expects it preserved). But no test pins the monotonicity contract — "rejectionCount only INCREASES until exitPlanMode."

10. **"Walk me through what happens if `current.lastPlanPayloadHash` is the literal string `'undefined'` (not the value undefined)."** Answer: `current.lastPlanPayloadHash === payloadHash` — if payloadHash is the string "undefined", they're equal. Idempotency fires spuriously. No test pins this — the hash format is undocumented in the type. Source `helpers/payload-hash.ts` always returns 12-char hex, so this can't happen via the standard path. But if disk is hand-edited, or a different module writes the field, the trap exists.

11. **"Where's the test for the title-stripping case (passes `title: ""` after a non-empty title was persisted)?"** Answer: doesn't exist. The truthy guard preserves the old title. Is that intended? Not documented.

12. **"What happens if `gateway.withLock` resolves but `update` was never called (broken gateway impl)?"** Answer: outcome variables are `undefined`. The non-null assertion `outcome!` would crash. No test for broken gateways beyond "throws" — partial implementations are uncovered.

13. **"Does the implementation match the docstring claim that invariant 10 is 'N/A — plugin is self-contained'?"** Answer: kinda. `SessionStoreGateway.loadSdk()` IS lazy. But `store.ts` itself imports `schema-version.js` synchronously. The "self-contained" claim is true; the "preserved as discipline" claim isn't tested (no eager-load detection).

14. **"What if the disk has a session with `mode: 'plan'` but EVERY field optional is missing (just the required ones)? Does persist still work?"** Answer: probably yes (the spread + bundle handles undefined gracefully). But no test seeds this minimal shape.

15. **"Show me the byte-identical parity proof against the actual in-host source."** Answer: `host-reference.ts` IS the port; the test compares plugin against port, not plugin against in-host. README warns about this — it's an attestation, not a guarantee.

---

## 6. Confidence score

**P(no critical gap remains) = 0.55**

Reasoning:
- **Strong**: per-branch coverage of invariants 1-4, 7, 8, 9 is robust (~30 tests, each pinning a documented contract). The parity harness is a real second-line defense. The `discriminated-union result + always-an-approvalId` contract is well-pinned.
- **Weak**: invariants 5+6 (atomic lock + fresh read) have zero direct tests in the plugin suite; they're encapsulated in a gateway whose test file is a re-export shim. The whole concurrency surface is unverified.
- **Weak**: the canonical spec doc is MISSING from the working tree. The docstring at `store.ts:9-21` is the de-facto source-of-truth, but it lives in code and could be edited away without anyone noticing.
- **Weak**: the audit-throw / logger-throw path leaks state-audit-inconsistency (G-P1-3); discovered by inspection, not by test.
- **Weak**: forward-compat schemaVersion handling is asymmetric (G-P0-3) — `readSnapshot` rejects future versions, `persistApprovalRequest` silently downgrades them. Either is defensible; the inconsistency is not.
- **Weak**: state-transition matrix has 3 of 6 prev-states uncovered for the persist branch; parity inputs share the same blind spots.
- **Weak**: caller-contract enforcement (the upstream pattern at host_ref:1881 — "use r.approvalId, not candidate, on reuse") has no integration test in this slice.

Bringing confidence to >0.95 would require: (1) a dedicated in-memory-gateway test file covering serialization + reentrancy + clone defense, (2) concurrency tests exercising 2-4 simultaneous persists with same/different hashes, (3) state-transition matrix completion (all 6 prev-states), (4) the audit/logger throw cases pinned (with a fix to swallow), (5) forward-compat schemaVersion behavior pinned at both ends, (6) caller-contract integration test demonstrating r.approvalId vs candidate selection across all 4 result kinds, and (7) recovery of the canonical-spec doc OR promotion of the docstring to a tracked, reviewed file.
