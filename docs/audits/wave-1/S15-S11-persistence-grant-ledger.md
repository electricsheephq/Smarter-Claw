# Wave-1 Audit A7 — S15 (Real persistence gateway) + S11 (Approval grant ledger + debug log)

**Agent**: A7
**Scope**: Read-only first-principles testing-gap analysis
**Date**: 2026-05-12
**Verdict**: Confidence 62/100 (medium-low — see Section 9). The
persistence gateway is the race-fix surface for S3, and the test
suite has a **structural gap**: every store test runs on `InMemoryGateway`,
not `SessionStoreGateway`. The behaviors the in-memory gateway can
exhibit are a strict superset of, and not equivalent to, the
behaviors the production gateway can exhibit (TS-ANY-shaped patch,
shallow merge semantics, JSON-serializability, cross-process visibility,
file I/O errors, mid-callback re-entry into `updateSessionStoreEntry`).
Eva live-smokes don't close this gap either — they force `SMARTER_CLAW_USE_INMEMORY=1`.

---

## 1. Slice summary

### S15 — Real persistence gateway (SessionStoreGateway via updateSessionStoreEntry)

The production state surface for plan-mode. Writes the
`PlanModeSessionState` to the host's session.json under
`entry.pluginExtensions["smarter-claw"]["plan-mode"]` via the host's
`updateSessionStoreEntry` helper. This is the **same function the
in-host race-fix uses** (anchor commit `1081067476`,
`pi-embedded-subscribe.handlers.tools.ts:172`). The gateway interface
abstracts invariants 5 (atomic lock) and 6 (fresh-read inside the lock)
from `PlanModeStore`'s 10-invariant contract.

- **In-host source**: `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/config/sessions/store.ts:644-669`
  (`updateSessionStoreEntry`) and `:610-642` (`withSessionStoreLock`).
  Note: the slice doc references `src/gateway/sessions-patch.ts` and
  `src/agents/store.ts` — those filenames don't exist in the working
  tree. The actual lock + update primitives live in
  `src/config/sessions/store.ts` (the canonical session-store
  module). `sessions-patch.ts` is a HIGHER-LAYER caller, not the lock
  primitive. **Audit finding G1**: the slice's source-of-truth pointer
  drifts from reality.
- **Plugin port**: `/Users/lume/repos/Smarter-Claw/src/state/session-store-gateway.ts`
- **In-memory dev gateway**: `/Users/lume/repos/Smarter-Claw/src/state/in-memory-gateway.ts`
- **Plugin tests**:
  - `/Users/lume/repos/Smarter-Claw/tests/state/session-store-gateway.test.ts` (6 cases, **all shape/no-throw** — zero behavioral coverage)
  - `/Users/lume/repos/Smarter-Claw/tests/state/store.test.ts` (84 it() — but all driven via `InMemoryGateway`)
- **Hook wiring**: `/Users/lume/repos/Smarter-Claw/src/index.ts:189-214`

### S11 — Approval grant ledger + approvalRunId/approvalId correlation + structured debug log

The cross-event correlation and operator-visibility surface for
plan-mode. `GrantLedger` is an in-memory `Map<approvalId, {approvalRunId,
sessionKey, recordedAt}>` with TTL; `debug-log.ts` exposes the
discriminated-union `PlanModeDebugEvent` type and `logPlanModeDebug` /
`logPlanModeApprovalTransition` emitters, gated by env-var OR
`pluginConfig.debug`.

- **In-host source**: `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/plan-mode-debug-log.ts`
- **Plugin ports**:
  - `/Users/lume/repos/Smarter-Claw/src/runtime/grant-ledger.ts`
  - `/Users/lume/repos/Smarter-Claw/src/runtime/debug-log.ts`
- **Plugin tests**:
  - `/Users/lume/repos/Smarter-Claw/tests/runtime/grant-ledger.test.ts` (14 it())
  - `/Users/lume/repos/Smarter-Claw/tests/runtime/debug-log.test.ts` (17 it())
- **Audit emitter wiring**: `/Users/lume/repos/Smarter-Claw/src/index.ts:226-271` (the
  `(event) => {...}` callback passed as the third arg to `new PlanModeStore(...)`).

---

## 2. Lock semantics contract (S15) — from in-host

Extracted from `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/config/sessions/store.ts`:

### Contract A: `withSessionStoreLock(storePath, fn, opts)` (lines 610-642)

- **Serialization key**: `storePath` (NOT sessionKey). All
  `updateSessionStoreEntry` calls against the same storePath serialize
  through a single FIFO queue (`LOCK_QUEUES.get(storePath)`).
  Per-sessionKey concurrency does NOT exist at this layer — every
  caller waits behind every other caller for the same store file.
- **Cross-process safety**: backed by `acquireSessionWriteLock` (from
  `agents/session-write-lock.js`), which is a filesystem-level lock
  (.lock file). This is what makes the in-host safe against multiple
  gateway processes (e.g. menubar Mac app + terminal `openclaw config`
  commands).
- **Timeout**: default `10_000 ms`. Lock-acquire failures throw
  `Error("timeout waiting for session store lock: <storePath>")`.
- **Stale-lock recovery**: `staleMs = 30_000 ms` by default; the
  underlying acquirer breaks locks held longer than this.
- **Max-hold derivation**: `resolveSessionStoreLockMaxHoldMs` ensures
  `maxHoldMs >= 5_000 ms` (the floor) and `<= timeoutMs + 5_000 ms`
  grace.
- **No-throw guarantee**: if `fn` throws, the lock is **still
  released** (`finally { await lock?.release().catch(() => undefined); }`)
  and the rejection propagates to the caller's `await`.
- **Queue-drain semantics**: `drainSessionStoreLockQueue` is the
  long-running consumer. After draining, if the queue is empty,
  `LOCK_QUEUES.delete(storePath)` so the keyed map doesn't grow
  unbounded with retired sessions.

### Contract B: `updateSessionStoreEntry({ storePath, sessionKey, update })` (lines 644-669)

The S3-race-fix gold-standard pattern. Five load-bearing properties:

1. **Lock-around-the-whole-thing**: `withSessionStoreLock(storePath, async () => { ... })`
   wraps the read + update + write. There is NO window between read
   and write where another writer can interleave.
2. **Fresh read with `skipCache: true`**: line 651 — `loadSessionStore(storePath, { skipCache: true })`.
   This **bypasses the in-memory mtime cache** (`store-cache.ts`'s
   `readSessionStoreCache`). Why: another process (or the same
   process via a different code path) may have written the file
   between when our cache was populated and now. Reading the cache
   inside a lock is a race-fix REGRESSION — the cache snapshots a
   pre-write state and we'd clobber the fresh data when we save.
3. **Resolve-then-existence-check**: `resolveSessionStoreEntry({ store, sessionKey })`
   handles sessionKey normalization (legacy keys, alias keys). If
   `resolved.existing` is null, the caller's `update` is NOT invoked
   and the function returns `null`. **Plugin port consequence**:
   if the host has never seen this session before, the plugin's
   `PlanModeStore.persistApprovalRequest` will succeed at the
   `withLock` level but write nothing — and the plugin port has NO
   path to surface this back to the caller (silent skip).
4. **Conditional patch via `mergeSessionEntry`**: line 661. The
   `update` callback returns a `Partial<SessionEntry>`. The merge is
   SHALLOW (top-level keys) — `pluginExtensions` is a top-level key,
   so the plugin's patch fully replaces the entire pluginExtensions
   object UNLESS the plugin first reads the existing one and merges
   itself. (The plugin DOES do this on line 219-229 of
   session-store-gateway.ts, but there's no test that proves the
   merge survives interleaved patches from other plugins or the host
   itself.)
5. **Update side effects**:
   - `mergeSessionEntry` always **bumps `updatedAt`** to
     `Math.max(existing.updatedAt, patch.updatedAt, now)`. The plugin
     does NOT pass `updatedAt`; the host stamps `Date.now()`.
   - If `patch.model` is set but `patch.modelProvider` is not, the
     merge clears `modelProvider` (stale-provider guard at types.ts:726-732).
     The plugin's patch never sets `model`, so this is a no-op — but
     a future plugin extension that does would be silently
     surprised.
   - The host runs `saveSessionStoreUnlocked` with `activeSessionKey:
     resolved.normalizedKey`, which triggers the maintenance/rotate
     pipeline. Errors here propagate; the plugin's `update` callback
     has already run. **Audit gap**: there's no test for "what
     happens when `saveSessionStoreUnlocked` throws after the plugin
     callback's idempotent-skip vs persist decision was already made"
     — the plugin will report `kind: "persisted"` even though the
     write failed.

### Contract C: nesting / re-entrancy

The in-host has explicit comments at `injections.ts:21` and `:175`
("inside an existing `updateSessionStoreEntry` callback where the
store ..."). The pattern is: **NO re-entry into `updateSessionStoreEntry`
from within an `update` callback**. The queue would deadlock — the
inner call would wait behind the outer call (same storePath, same
queue). The plugin port has no test for re-entrancy (and no
guardrail/warn).

---

## 3. Gateway behavioral equivalence — in-memory vs session-store; how is it tested?

**Headline: It is NOT tested. The two gateways are NOT behaviorally
equivalent, and no test enforces equivalence.**

### What the in-memory gateway does (in-memory-gateway.ts:59-97)

- Lock key: `sessionKey` (per-session). Promise-chain lock, NOT
  filesystem.
- Fresh read: `this.state.get(sessionKey)` inside the lock; deep
  cloned via `structuredClone` so callers can't mutate-by-reference.
- Write: replaces the entry; deep clones before storing.
- `writeCount`: bumped on every write (load-bearing for "did we write
  or not" assertions in store.test.ts).

### What the session-store gateway does (session-store-gateway.ts:179-237)

- Lock key: **`storePath`** (per-store, not per-session — see Contract A).
  Every plan-mode write across every session in the same storePath
  serializes through the same queue.
- Fresh read: routes through `updateSessionStoreEntry` which reads
  with `skipCache: true`. The `entry.pluginExtensions["smarter-claw"]["plan-mode"]`
  slot is read OUT (line 202-204) and the typed shape is cast back
  with `as PlanModeSessionState | undefined`.
- Write: returns a `Partial<SessionEntry>` with only `pluginExtensions`
  set (line 230-232). The host shallow-merges this with the existing
  entry. Other top-level fields (mode, msgIdsForUndo, etc.) are
  preserved by the host merge.
- No `writeCount` equivalent. There is **no diagnostic counter** on
  SessionStoreGateway, which means `store.test.ts`'s many
  `expect(gw.writeCount).toBe(N)` assertions cannot be run against
  the real gateway.

### Key divergences (the matrix tests don't catch)

| Property | InMemoryGateway | SessionStoreGateway | Test coverage? |
|---|---|---|---|
| Lock granularity | per-sessionKey | per-storePath | **NONE** |
| State serialization | `structuredClone` (Map types preserved, Date preserved, etc.) | JSON via host save/load (functions dropped, Map → object, Date → string, undefined → omitted) | **NONE** |
| Cross-process visibility | none (process-local Map) | yes (filesystem lock + atomic write) | **NONE** |
| `writeCount` diagnostic | yes | no | n/a |
| Behavior when session is unknown to host | gateway always proceeds (creates new entry on write) | `updateSessionStoreEntry` returns `null`, plugin's update callback is **never invoked**, store sees no transition → no audit, no grant-ledger entry, but `PlanModeStore.persistApprovalRequest` returns `kind: "persisted"` from inside the callback that DID run before the host short-circuited | **NONE** |
| Patch shape | direct state replacement | shallow-merge over `pluginExtensions`; other plugin namespaces preserved by manual `{ ...otherPluginExtensions }` spread | **NONE** |
| Schema-version stamping carries through serialization | yes (object literal) | yes if number; FRAGILE if becomes a Symbol or BigInt | not tested |
| Top-level `updatedAt` bumped on write | NO | YES (host's `mergeSessionEntry`) | **NONE** |
| Re-entry into `withLock` from inside callback | deadlocks (same Map of locks, same key) | **deadlocks** (same lock queue, same storePath) | **NONE** |
| Concurrent writes to DIFFERENT sessions | parallel (different keys) | **serialized** (same storePath queue) | **NONE** |
| Concurrent writes to SAME session | serialized | serialized | **NONE — no test** |
| `entry.pluginExtensions === undefined` (fresh row) | n/a | gateway does `?.[PLUGIN_ID]?.[namespace]` → undefined → first write creates the slot | **NONE** |

### Why this matters

`session-store-gateway.test.ts` is **shape-only**: it asserts the
class exists, the constant matches, methods are present. The first
real behavioral check happens at "Eva live-smoke #2" — which is
itself **forced to in-memory mode** (`forceInMemory: true` by default
in `harness.ts:84-86`). So today, **the production gateway has zero
runtime coverage anywhere in the test suite**.

---

## 4. Event taxonomy (S11) — 8 kinds + activation

### In-host (plan-mode-debug-log.ts:63-152) — 9 kinds (matches the slice doc's "8" + approval_transition)

1. `state_transition` — sessionKey, from, to, trigger, [approvalRunId], [approvalId]
2. `gate_decision` — sessionKey, tool, allowed, planMode, [reason], [approvalRunId], [approvalId]
3. `tool_call` — sessionKey, tool ∈ {enter_plan_mode|exit_plan_mode|update_plan|ask_user_question}, runId, [details]
4. `synthetic_injection` — sessionKey, tag, preview, [approvalRunId], [approvalId]
5. `nudge_event` — sessionKey, nudgeId, phase ∈ {scheduled|fired|cleaned}, [approvalRunId]
6. `subagent_event` — sessionKey, parentRunId, childRunId, event ∈ {spawn|return}, [approvalRunId]
7. `approval_event` — sessionKey, action, openSubagentCount, result ∈ {accepted|rejected_by_subagent_gate|other}, [approvalRunId], [approvalId]
8. `toast_event` — sessionKey, toast, phase ∈ {fired|dismissed}, [approvalRunId], [approvalId]
9. `approval_transition` — sessionKey, from, to, trigger, [approvalIdBefore], [approvalIdAfter]

### Plugin port (debug-log.ts:60-131) — also 8 kinds, but **NOT byte-equivalent**

The plugin port reshapes events:
- `tool_call`: in-host has `runId` + `details?`; plugin has `tool: string` (open-typed, lost the union constraint), `mode: string`, `meta?` — **completely different shape**.
- `synthetic_injection`: in-host has `tag` + `preview`; plugin has `injectionKind` + `idempotencyKey`.
- `nudge_event` → `nudge_phase`: in-host has `nudgeId` + `phase ∈ literal union`; plugin has `phase: string` (any string) + `details?`.
- `subagent_event`: in-host has `parentRunId` + `childRunId` + `event ∈ literal union`; plugin has `event: string` + `details?`.
- `approval_event`: in-host has `action` + `openSubagentCount` + `result`; **plugin DROPS the `approval_event` kind ENTIRELY** — the discriminator has no such case.
- `toast_event` → `ui_toast`: rename + reshape (severity field added).

**Audit gap G2**: the plugin port's debug-log event union is NOT a
port of the in-host's taxonomy — it's a **divergent rewrite**. The
event-kinds that in-host operators grep for (`[plan-mode/approval_event]`,
`[plan-mode/nudge_event]`, `[plan-mode/toast_event]`) **do not exist**
in the plugin's log output. Any operator runbook keyed off
`[plan-mode/<kind>]` patterns will silently fail to find events.

### Activation predicate (debug-log.ts:166-181)

- `process.env.OPENCLAW_DEBUG_PLAN_MODE === "1"` wins (any other
  value, including `"true"`, is OFF). Matches in-host.
- Else `pluginConfig.debug === true`. **DRIFT from in-host**: the
  in-host reads `agents.defaults.planMode.debug` (config-level path),
  but the plugin port reads `pluginConfig.debug` (plugin-level path).
  An operator following the in-host runbook (`openclaw config set
  agents.defaults.planMode.debug true`) will toggle the host's debug
  log but **not the plugin's** — the two flags are different keys.
- Cache: plugin port has a 30 s TTL on the config-flag value, matching
  in-host. Cache reset helper `_resetDebugFlagCacheForTests` is
  exported, matching the in-host's helper.

### approval_transition skip-on-noop (debug-log.ts:222-228)

Both in-host and plugin skip emission when `prev.approval === next.approval` AND `prev.approvalId === next.approvalId`. Plugin
preserves this — tested at debug-log.test.ts:222-233.

---

## 5. Test coverage matrix

### S15 SessionStoreGateway

| Behavior | Unit test | Eva smoke | Real-host integration |
|---|---|---|---|
| Class exports + shape | ✅ session-store-gateway.test.ts | n/a | n/a |
| `withLock` method present on instance | ✅ | n/a | n/a |
| PLUGIN_ID matches manifest id | ✅ | n/a | n/a |
| **Lazy-imports resolve at first call** | ❌ | ❌ | ❌ |
| **storePath resolution** (`resolveStorePath` + `parseAgentSessionKey`) | ❌ | ❌ | ❌ |
| **Agent-suffix session keys** (`agent:foo:bar` → agentId="foo") | ❌ | ❌ | ❌ |
| Fallback for routing-module import failure | ❌ | ❌ | ❌ |
| **Round-trip: write then read sees the same state** | ❌ | ❌ | ❌ |
| **`pluginExtensions` is created when entry has none** | ❌ | ❌ | ❌ |
| **Other plugin namespaces preserved when writing** | ❌ | ❌ | ❌ |
| **Other smarter-claw slots preserved** (multi-namespace) | ❌ | ❌ | ❌ |
| **Sequential writes serialize correctly** | ❌ | ❌ | ❌ |
| **Concurrent writes from different sessions same storePath** | ❌ | ❌ | ❌ |
| **Concurrent writes to same session** | ❌ | ❌ | ❌ |
| **`updateSessionStoreEntry` returns null (unknown session)** — transition handling? | ❌ | ❌ | ❌ |
| **`updateSessionStoreEntry` throws → propagation** | ❌ | ❌ | ❌ |
| **storePath unresolvable (config missing)** | ❌ | ❌ | ❌ |
| **`next === null` skip path** (idempotency) | ❌ | ❌ | ❌ |
| **transition is captured even on skip** | ❌ | ❌ | ❌ |
| **Date / Map / undefined survives JSON serialization** | ❌ | ❌ | ❌ |
| **`updatedAt` is bumped by host merge** | ❌ | ❌ | ❌ |
| **Schema-version stamping survives JSON round-trip** | ❌ | ❌ | ❌ |
| **Re-entry into updateSessionStoreEntry from inside update callback** (deadlock?) | ❌ | ❌ | ❌ |
| **Stale-lock recovery** (lock file `staleMs` semantics) | ❌ | ❌ | ❌ |
| **Lock timeout error propagates as `kind: "failed"`** | ❌ | ❌ | ❌ |

Result: **6/30 behaviors covered, all shape-level. 0% real-host integration.**

### S11 GrantLedger

| Behavior | Unit test | Integration |
|---|---|---|
| record + get | ✅ | ❌ |
| overwrite-on-same-id (latest wins) | ✅ | ❌ |
| approvalRunId optional | ✅ | ❌ |
| prune existing returns true | ✅ | ❌ |
| prune unknown returns false | ✅ | ❌ |
| TTL: expired entry returns undefined (lazy delete) | ✅ | ❌ |
| TTL: within-window returns the entry | ✅ | ❌ |
| TTL: 1-hour default | ✅ | ❌ |
| TTL: zero/negative ttlMs falls through to default | ✅ | ❌ |
| sweepExpired removes only expired | ✅ | ❌ |
| sweepExpired returns count | ✅ | ❌ |
| sweepExpired with nothing to expire returns 0 | ✅ | ❌ |
| size() / approvalIds() diagnostics | ✅ | ❌ |
| **TTL boundary: exactly at ttlMs (strict-greater-than vs ≥)** | ❌ | ❌ |
| **TTL boundary: -1 ms before TTL** | ❌ | ❌ |
| **TTL boundary: +1 ms after TTL** | ❌ | ❌ |
| **Memory bound under abuse** (record 1M unique approvalIds, no get/prune) | ❌ | ❌ |
| **Clock-skew / system clock rollback** | ❌ | ❌ |
| **Concurrent record + get + prune** (race) | ❌ | ❌ |
| **Integration: audit emitter populates ledger on persist path** | ❌ | ❌ |
| **Integration: prune fires on recordRejection/recordApproval audit** | ❌ | ❌ |
| **Integration: PlanModeStore writes approvalRunId so ledger entry has it** | ❌ (BLOCKED — see Section 6 P0-G6) | ❌ |

### S11 debug-log

| Behavior | Unit test |
|---|---|
| Env path returns true | ✅ |
| Env path wins over config | ✅ |
| Config path returns true | ✅ |
| Env unset + config undefined → false | ✅ |
| Env unset + config.debug === false → false | ✅ |
| Env unset + config.debug non-boolean → false | ✅ |
| Env var must be literal "1" | ✅ |
| No-op when disabled | ✅ |
| Emits with `[plan-mode/<kind>]` tag (env) | ✅ |
| Emits all listed event kinds | ✅ (6 of 8 — `state_transition` and `approval_transition` covered separately) |
| Sorted-key meta string | ✅ (one case: tool_call) |
| Drops undefined meta values | ✅ |
| approval_transition: emits on change | ✅ |
| approval_transition: emits on approvalId change | ✅ |
| approval_transition: skips on noop | ✅ |
| approval_transition: undefined prev/next | ✅ |
| approval_transition: correlation.approvalRunId threaded | ✅ |
| approval_transition: no-op when disabled | ✅ |
| **Sorted-key meta for EVERY event kind** | ❌ |
| **Cache TTL: env-var change visible immediately (not cached)** | ❌ |
| **Cache TTL: 30s expiry behavior** | ❌ |
| **Config-key drift smoke test** (plugin reads `pluginConfig.debug`, in-host reads `agents.defaults.planMode.debug` — same flag?) | ❌ |
| **Event-kind taxonomy parity with in-host** | ❌ |
| **JSON.stringify of nested object meta** (details / meta payloads) | ❌ |
| **Stringify of values containing quotes / unicode / newlines** | ❌ |
| **Stringify with circular refs** | ❌ |
| **Logger-throws fallback** (what if api.logger.info throws?) | ❌ |

---

## 6. Testing gaps

### P0 — potential data corruption or race-fix regression

**P0-G1. SessionStoreGateway has zero runtime/integration coverage.**
All 84 invariant tests in store.test.ts run on `InMemoryGateway`, which
has different lock granularity (per-sessionKey vs per-storePath),
different serialization semantics (structuredClone vs JSON), and a
different patch shape (state replacement vs `Partial<SessionEntry>`
merge). The race-fix invariants 1+5+6 are validated against a gateway
that **doesn't have the production race surface**.
*Fix*: add `tests/integration/session-store-gateway.test.ts` driven by
a real temp-file storePath + real `updateSessionStoreEntry` via the SDK
side-load. Re-run the relevant store.test.ts cases as
parameterized matrix tests against both gateways.

**P0-G2. Lock-around-the-read-AND-write is not verified for the
production gateway.** Without a concurrency test, an accidental
refactor of `session-store-gateway.ts` that read the slot OUTSIDE the
`updateSessionStoreEntry` callback (e.g. by calling
`loadSessionStore` separately) would silently re-introduce the S3
race. There's no test that would fail.
*Fix*: concurrency property test — N parallel `persistApprovalRequest`
calls with overlapping payloads, assert "exactly one persisted, all
others reused; the persisted state's `lastPlanSteps` is whichever
one's payload won" without any null/empty intermediate state.

**P0-G3. `skipCache: true` semantics are invisible to the plugin
port.** The plugin uses the SDK's `updateSessionStoreEntry`, which
internally passes `skipCache: true` (in-host store.ts:651). If a
future SDK refactor drops that flag (e.g. for "perf" reasons), the
race returns and no plugin-side test detects it.
*Fix*: integration test that pre-populates the store-cache with stale
data, performs a `withLock` write, and asserts the read inside the
callback saw the on-disk value (not the cache).

**P0-G4. The session-unknown path is silently mis-reported.** When
the host has no entry for `sessionKey`, `updateSessionStoreEntry`
returns `null` and **the plugin's update callback is never invoked**.
This means `persistApprovalRequest`'s `txResult` assignment (inside
the callback at store.ts:213, 237, 263) never happens — and the
runtime guard at store.ts:289 (`if (!txResult!) throw …`) WOULD fire
… EXCEPT the gateway swallows the null and returns `{ transition:
undefined }` cleanly. The store's `catch` block at store.ts:295
catches the throw and returns `{ kind: "failed" }` — but the
**operator-visible message says "failed to persist" when in reality
the row simply didn't exist**.
*Fix*: SessionStoreGateway should distinguish "host returned null"
from "callback ran but returned null" and surface the former as a
dedicated `kind: "session-not-found"` outcome. Add a test.

**P0-G5. Re-entrant `withLock` calls deadlock silently.** The
plugin's `PlanModeStore.readSnapshot` already routes through
`gateway.withLock` (store.ts:714). If any future caller invokes
`readSnapshot` from inside another mutator's audit callback (e.g.
`(event) => { store.readSnapshot(sessionKey); }` in index.ts:226-271),
the FIFO queue for that storePath will deadlock — the inner `withLock`
waits behind the outer that's still draining its callback. There's
no test that asserts "re-entry throws / warns / has a timeout".
Today's index.ts audit callback is synchronous and doesn't call
back into the store, but the type system doesn't prevent it.
*Fix*: add a TS-API constraint (`store` shouldn't be in scope of the
audit emitter) or a runtime guard.

**P0-G6. `approvalRunId` is never persisted by any PlanModeStore
mutator.** Grep confirms: `src/state/store.ts:420` is the only
mention, and it's a *deliberate omit* in `exitPlanMode`. The
`PersistApprovalRequestInput` type (store.ts:112-125) accepts only
{sessionKey, approvalId, title?, payloadHash?, lastPlanSteps?} — there
is **no `approvalRunId` field**. So:
1. The audit emitter's `event.next.approvalRunId` (index.ts:255) is
   ALWAYS undefined.
2. `grantLedger.record({...,approvalRunId: undefined})` always
   omits the field (guarded by `event.next.approvalRunId ? ... : {}`).
3. The grant ledger therefore exists but is correlation-disabled —
   `get(approvalId)` returns entries with no `approvalRunId`, so the
   debug log's "thread approvalRunId across events" goal is
   un-achieved.
4. `logPlanModeApprovalTransition` in the audit callback (index.ts:237-244)
   doesn't pass the `correlation` argument either, so emitted
   approval_transition events also lack `approvalRunId`.

The in-host stores `approvalRunId` on `planMode.approvalRunId` at
exit_plan_mode time. The plugin **drops this entirely**. The grant
ledger is functionally a memory leak / dead code: its only correlation
field is never populated.
*Fix*: extend `PersistApprovalRequestInput` with `approvalRunId?:
string`; persist on the state; thread through audit emitter.
Add a test that fails when this regresses.

**P0-G7. `setAutoApprove` always writes (no idempotent skip on
fresh-row creation), and emits an audit on the lazy-init path even
when `enabled === current.autoApprove` semantically.** When a session
has no plan-mode payload yet, `setAutoApprove({enabled: false})`
will CREATE a payload with `autoApprove: false` and `mode: "normal"`
— and the transition (prev=undefined, next={mode:normal,
autoApprove:false}) gets audit-emitted as if the operator toggled
on something. This will pollute the debug log + grant-ledger
("approval changes from absent → none with approvalId=undefined").
*Fix*: add an early-return when `current === undefined && !enabled`
(no-op lazy init).

### P1 — gaps that hide bugs but not corruption

**P1-G8. Event-kind taxonomy mismatch with in-host (G2 above).**
Operator runbooks keyed off `[plan-mode/approval_event]`,
`[plan-mode/nudge_event]`, `[plan-mode/toast_event]` will not find
plugin events of those names — the plugin renamed to `ui_toast`,
`nudge_phase`, and **dropped `approval_event` entirely**. Confidence
that "operators can debug plan-mode by tailing the log" drops to
near-zero in production.

**P1-G9. Activation-predicate config key drifts from in-host.**
Plugin reads `pluginConfig.debug` (plugin-level entry config).
In-host reads `agents.defaults.planMode.debug` (host-level
agents config). Operators following the in-host comment header
(plan-mode-debug-log.ts:18-25) will toggle the wrong key and see
nothing.

**P1-G10. Cache TTL drift between in-host (30s) and plugin (30s but
implemented differently).** Plugin's `cachedFlag` is set with
`setAt: Date.now()` and check is `Date.now() - cachedFlag.setAt <
30_000`. In-host uses `expiresAt: now + 30_000` and check is
`cachedFlag.expiresAt > now`. The semantics are equivalent BUT the
in-host caches **only the config-flag path** (env is checked every
call), whereas the plugin's check at debug-log.ts:170 short-circuits
on env first, then caches — equivalent in practice but the cache
hit/miss behavior under a late-toggled env-var is not tested.

**P1-G11. Sorted-key meta-string output verified ONLY for `tool_call`.**
The other 7 (or 6 — `approval_event` missing in plugin) event kinds
are not asserted to produce deterministic key order. A
JavaScript-implementation change to `Object.keys()` order would
silently break log-parsing of the un-tested kinds.

**P1-G12. Undefined-value drop verified only for `approvalRunId` +
`approvalId`.** Other optional fields (`reason` on gate_decision,
`details` on tool_call, `severity` on ui_toast, `idempotencyKey` on
synthetic_injection, `feedback` on (none — plugin doesn't have it),
`meta` on tool_call) are not asserted to be dropped when undefined.

**P1-G13. `nudge_phase` event kind has a `string` phase (any
value), not the in-host's `{scheduled|fired|cleaned}` literal union.**
A typo (`"schduled"`) at a call-site compiles cleanly. No test
detects the lost type narrowing. Same for `subagent_event.event` and
`tool_call.tool`.

**P1-G14. `ui_toast` allows `sessionKey?: string` (optional) where
the in-host requires it.** The two are not equivalent — a UI-side
toast without sessionKey can't be correlated to its plan cycle. No
test asserts sessionKey presence.

**P1-G15. Audit-emitter wiring is untested end-to-end.** index.ts:226-271
is the wiring point — the (event) => {...} callback that fires the
debug log + grant ledger + base audit. There's no test that
constructs a real `PlanModeStore` with a real `audit` callback shaped
like index.ts's and asserts: (a) `logPlanModeApprovalTransition` is
called with the right args, (b) `grantLedger.record` fires when
approval transitions to pending with a new approvalId, (c)
`grantLedger.prune` fires on approve/edit/reject terminals.
*Fix*: integration test in tests/runtime/audit-wiring.test.ts.

**P1-G16. Grant ledger TTL boundary conditions untested.** The
boundary (`Date.now() - entry.recordedAt > this.ttlMs`) uses strict
`>`, so exactly-at-TTL returns the entry. A change to `>=` would
break that — no test catches.

**P1-G17. Grant ledger has no upper bound on size.** An attacker (or
a buggy approvalId-rotation loop) that records 100 K unique
approvalIds without ever resolving would consume O(N) memory until
TTL sweeps. No bound, no test.

**P1-G18. Clock-skew on grant ledger.** If `Date.now()` jumps
backward (NTP sync after a clock-drift incident), recently-recorded
entries appear to be in the future and `Date.now() - recordedAt < 0`
will never trigger expiry. Then a forward jump expires
"future-dated" entries that should be live. No test.

**P1-G19. PlanModeStore.persistApprovalRequest's `kind: "persisted"`
includes a fresh write path where `lastPlanSteps` is empty**
(input.lastPlanSteps is `undefined` or `[]` → `lastPlanSteps` is
NOT included in the spread at store.ts:259-261 because of the `&&
lastPlanSteps.length > 0` guard). The PERSISTED state has no
`lastPlanSteps`. **This is the empty-plan-body race** in a different
form: the row got written without steps, and a subsequent fast
approve would see an absent `lastPlanSteps`. The in-host race-fix
anchor (`1081067476`) explicitly writes steps + title in the bundle.
The plugin's idempotency guard (invariant 3+7) requires
`payloadHash !== undefined && current.lastPlanPayloadHash ===
payloadHash`, so a re-emit with the same hash would reuse — but a
re-emit with a DIFFERENT or MISSING hash falls through to rotate and
writes an empty-steps row. **No test exists that asserts persistApprovalRequest
NEVER persists with empty/absent lastPlanSteps when input.lastPlanSteps
is empty/absent.**
*Fix*: add a precondition: if `lastPlanSteps` is empty or absent,
return `kind: "skipped", reason: "missing-fields"` (the type
already declares this option but is never returned).

**P1-G20. PlanModeStore guard at store.ts:213** (`if (!current || current.mode !== "plan")`)
treats `mode === undefined` and `mode === "normal"` the same. But a
session with `current === undefined` (no plan-mode payload yet) is
LEGITIMATELY a fresh-row case; `current.mode === "normal"` is an
explicit normal-mode session. Both currently report `kind:
"skipped", reason: "not-plan-mode"`. The operator sees the same
error for two very different states. No test distinguishes.

### P2 — defensive depth

**P2-G21. Sequential write ordering test (FIFO drain).** When 5
calls queue, do they resolve in submission order? The in-host's
`drainSessionStoreLockQueue` is FIFO; the plugin inherits this via
the SDK, but the plugin has no test that asserts the queue order.

**P2-G22. `entry.pluginExtensions === null` (vs undefined) handling.**
The in-host's loaded entry may have `pluginExtensions` as
`undefined`, `{}`, or — if a future plugin or external editor sets
it to `null` — could be null. The plugin's read at
session-store-gateway.ts:202 (`entry.pluginExtensions?.[PLUGIN_ID]?.[this.namespace]`)
handles `undefined` and `null` via optional chaining, but the write
path at line 219 (`entry.pluginExtensions ? { ...entry.pluginExtensions } : {}`)
treats `null` as truthy and would spread `null` (`{...null}` is `{}`,
so this happens to work — but it's defensive-coding by accident).

**P2-G23. PLUGIN_ID hardcoded twice.** session-store-gateway.ts:88
hardcodes `"smarter-claw"`; the manifest also declares it elsewhere.
A test asserts the constant matches the manifest id — but only
indirectly via `_testing.PLUGIN_ID === "smarter-claw"` (literal
string, not a manifest-load).

**P2-G24. Routing fallback parser is regex-based and untested.** If
the SDK doesn't expose `parseAgentSessionKey`, the gateway falls
back to a regex (session-store-gateway.ts:170-173). This parser
**only handles `agent:foo:bar` shape**. Sessions like
`agent:foo:bar:baz` map agentId="foo" and suffix="bar:baz" —
matches the in-host's parser behavior, but never tested.

**P2-G25. `loadConfig` and `resolveStorePath` SDK imports are
optional but error path swallows.** If the SDK import fails, the
gateway's `loadSdk` promise rejects, and EVERY subsequent
`withLock` call awaits that rejected promise and throws — but the
caller (PlanModeStore) catches and returns `kind: "failed"`. No
test for "SDK import fails at first call" or "SDK module exists but
exports are absent/renamed."

**P2-G26. Debug-log emission timing under high concurrency.** If 50
plan-mode events fire in 10 ms and each does `loadConfig`, do we
exceed file-handle limits? The 30s TTL cache mitigates but isn't
asserted under stress.

**P2-G27. `_resetIsPlanModeDebugEnabledCacheForTests` is exported.**
A production caller could call it. There's no guard. The in-host
has a docstring warning ("Production code should never call this").
Plugin has the same warning. Neither has a runtime guard or lint.

**P2-G28. `logger.info` is called with a single string in the
plugin (debug-log.ts:202), but with `("[plan-mode/<kind>]", meta)`
in the in-host (debug-log.ts:246).** The in-host's logger accepts
the meta as a second arg (structured-logger pattern). The plugin's
PluginLogger only takes a string, so the meta is stringified
inline. Logs are not bit-compatible between in-host and plugin — a
script that scrapes `{...metaObject}` shape from gateway.err.log
will fail on plugin output.

### Additional minor (P2-G29 — G31)

**P2-G29. `setSerializedSessionStore(storePath, undefined)` after
read-failure at store-load.ts:124-127** is an in-host behavior the
plugin can't observe (no access to the cache layer). If the SDK
swallows this in a future release, the plugin's reads could see
stale post-failure data. Untestable from the plugin side; flag for
SDK-side coverage.

**P2-G30. Patch returns `null` from gateway callback** at
session-store-gateway.ts:213. Plugin asserts "matches in-host
contract" via comment, but no test verifies — would the SDK's
`updateSessionStoreEntry` correctly skip the write when the inner
callback returns null? In-host code says yes (store.ts:658-660),
but the SDK could in principle do differently.

**P2-G31. Plugin's audit callback synchronously calls
`api.logger.info` THREE times** (base audit + debug-log + grant-ledger
trace if it logs). If `api.logger.info` is async-buffered with
backpressure, the audit callback's "synchronous" contract is leaky.
The audit emitter signature is sync (`(event) => void`), so any
caller assuming it's done after return is hoping. Untestable from
the plugin side without instrumenting the logger.

---

## 7. Cross-slice integration gaps — audit emitter → grant ledger → debug log

The audit-emitter wiring at index.ts:226-271 is the **integration
seam** between PlanModeStore (slices S3 + S15) and debug-log + grant
ledger (slice S11). Today, NO TEST exercises this seam end-to-end.

### Documented assumptions that aren't enforced by a test

1. **All 6 PlanModeStore mutators wire to the same audit emitter.**
   Confirmed by `grep -c "this.audit({" src/state/store.ts` → 6.
   But no integration test that triggers all 6 in sequence and
   verifies the emitter fires 6 times.

2. **Audit-skip on reuse path (invariant 9).** Tested in store.test.ts
   (the "SKIPS audit on the reuse path" case). But the SAME test
   doesn't assert "and therefore the grant ledger is NOT updated"
   — because the grant ledger is wired ONLY in index.ts and the
   unit test doesn't go through index.ts.

3. **Grant-ledger record fires only when approvalId rotates.** The
   index.ts wiring checks `event.next.approvalId !== event.prev?.approvalId`.
   The test doesn't cover: (a) recordRejection clears approvalId →
   prev has it, next doesn't, so the "rotate" check is false →
   record doesn't fire → but **prune does fire** because
   `event.prev?.approvalId && event.next.approval === "rejected"`.
   Order of operations isn't asserted.

4. **Grant-ledger prune fires on `approved | edited | rejected`** —
   but the check uses `event.prev?.approvalId`. For
   `recordRejection`, prev IS the pending state with an approvalId →
   prune fires. For `recordApproval`, prev is pending → prune fires.
   For `persistApprovalRequest`'s reuse path, NO audit fires →
   prune doesn't fire (correct). For `enterPlanMode` from a stuck
   `rejected` state, `prev.approvalId` is **undefined** (because
   recordRejection cleared it) → prune doesn't fire. Net: rejected
   approvalIds with cleared prev.approvalId never get explicitly
   pruned. They expire via TTL only.

5. **debug-log emitter called for every audit, with `event.source`
   as `trigger`.** `event.source` is `"smarter-claw:PlanModeStore.<mutator>"`
   — semantically the call-site label. In-host's trigger labels are
   things like `"sessions-patch:lastPlanSteps-materialize"` — much
   richer. The plugin's labels are coarser; an operator can grep
   `[plan-mode/approval_transition]` and see WHICH mutator fired
   but not WHERE WITHIN it (because there's only one audit-emit per
   mutator).

6. **debug-log emitter passes NO correlation.** The
   `logPlanModeApprovalTransition(api.logger, api.pluginConfig,
   event.sessionKey, event.prev, event.next, event.source)` call at
   index.ts:237-244 has no 7th arg, so `correlation.approvalRunId`
   is never threaded into approval_transition events. Combined with
   G6 (approvalRunId never persisted on state), the **correlation
   field is dead across the entire plugin**.

### Recommended integration test

A single file `tests/integration/audit-wiring.test.ts` that:
- Constructs a real `PlanModeStore` with `InMemoryGateway` (for
  determinism) + real `GrantLedger` + a captured-logger.
- Runs the full happy-path lifecycle: setAutoApprove(false),
  enterPlanMode, persistApprovalRequest (twice with same hash →
  reused), recordApproval, exitPlanMode.
- Asserts the captured-logger calls: 5 base audits + N debug-log
  approval_transition events + ledger has 1 entry → pruned → 0.
- Asserts NO audit on the reuse path AND no ledger record.
- Asserts persistApprovalRequest writes approvalRunId (BLOCKED by G6
  until that fix lands).

---

## 8. In-host parity — concurrency primitives same?

**Headline: NO. The plugin uses different primitives at a different
granularity.**

### In-host

- `withSessionStoreLock` (store.ts:610) — per-storePath FIFO queue
  with filesystem .lock backing, timeout 10 s, staleMs 30 s, maxHold
  5–15 s.
- `updateSessionStoreEntry` (store.ts:644) — wraps `withSessionStoreLock`
  with the "fresh read via `loadSessionStore(storePath, { skipCache:
  true })`" + `resolveSessionStoreEntry` + `mergeSessionEntry` +
  `persistResolvedSessionEntry` pattern.

### Plugin

- `SessionStoreGateway.withLock` (session-store-gateway.ts:179) —
  delegates to the SDK's `updateSessionStoreEntry` (lazy import,
  same function as in-host). So the **filesystem-lock + fresh-read
  semantics are inherited verbatim** ONLY IF the SDK actually
  exports the same function. There is no test that asserts the SDK
  import resolves to a function with the in-host's semantics.
- `InMemoryGateway.withLock` (in-memory-gateway.ts:59) — promise-chain
  per-sessionKey, no filesystem, no timeout, no stale recovery.
  Behaviorally a **subset** of the production semantics; correctness
  of plan-mode invariants on InMemoryGateway does NOT imply
  correctness on SessionStoreGateway.

### Specific parity properties

| Property | In-host | Plugin SessionStoreGateway | Plugin InMemoryGateway |
|---|---|---|---|
| Lock granularity | storePath | storePath (via SDK) | sessionKey |
| Fresh read | yes (`skipCache: true`) | yes (via SDK) | yes (Map.get) |
| Cross-process | yes (filesystem) | yes (via SDK) | NO |
| Timeout | 10 s default | inherited | NONE |
| Stale-lock recovery | 30 s | inherited | n/a |
| Reentry | deadlocks | deadlocks | deadlocks |
| Fairness | FIFO | FIFO (inherited) | FIFO |
| `skipCache: true` | hard-coded | inherited (NOT pluggable) | n/a |
| Patch merge | `mergeSessionEntry` (shallow + `updatedAt` bump + provider-clear) | inherited | direct replacement (no shallow merge) |
| Audit-on-read-failure | logs | inherited | n/a |

### Specific in-host edge cases the plugin can't observe

- **Windows retry on transient empty file** (store-load.ts:98-121).
  If the SDK ever degrades to a single-attempt read, the plugin would
  see intermittent missing rows on Windows. No plugin test.
- **`saveSessionStoreUnlocked` triggers archive/rotate** (store.ts:411-419
  → calls `archiveRemovedSessionTranscripts` for pruned sessions).
  The plugin's write could trigger an archive of an unrelated
  session in the same store. Probably fine, but untested.
- **`preserveExistingAcpMetadata`** (store.ts:204) — the host
  preserves ACP metadata across writes. The plugin's patch doesn't
  touch ACP fields, so this preserves correctly — but a future
  plugin extension that does set ACP fields would be silently
  overridden.

---

## 9. Confidence score

**62 / 100 (medium-low).**

### Why not higher

The core race-fix property is invariants 5 + 6 (lock-around-the-read,
fresh-read inside the lock). The plugin port delegates to
`updateSessionStoreEntry` for both — so structurally, the invariants
are inherited correctly. The 10-invariant logic at the
`PlanModeStore` layer is thoroughly tested (84 unit cases), albeit
all on the in-memory gateway.

### Why not lower

The structural seam between PlanModeStore and the real gateway is the
shallow line at session-store-gateway.ts:197 (`await runtime.updateSessionStoreEntry`).
If that one call's contract holds, the race-fix holds. The plugin
doesn't reimplement the lock; it borrows it. A regression would have
to come from:
1. The SDK re-implementing `updateSessionStoreEntry` with weaker
   semantics (G3) — very unlikely without intent.
2. The plugin doing pre-call reads outside the callback (would be a
   bad refactor, would show up in PR review).
3. The audit emitter assuming sync-flush of side effects (G31) —
   not a race-fix risk, but a debugging-clarity risk.

The bulk of the risk surface is **operator visibility** (S11): the
debug log's event-kind taxonomy diverged from in-host (G2 + P1-G8),
the activation config-key drifted (G9 + P1-G9), the correlation
field is dead (G6), and the in-host-style runbook commands won't
work against the plugin.

### What would lift the score to 85+

1. Real-host integration test for SessionStoreGateway (closes G1+G2+G3+G4).
2. Persist `approvalRunId` on PlanModeStore state, thread through
   audit emitter + grant ledger + debug-log correlation (closes G6).
3. Re-align debug-log event-kind taxonomy with in-host (closes G2 + P1-G8).
4. Cross-slice integration test for audit-emitter → debug-log →
   grant-ledger wiring (closes most P1 gaps).
5. Concurrency property test (parallel persistApprovalRequest with
   overlapping payloads) running against BOTH gateways (closes G2 +
   G5).

### What would drop the score to 30-

If any of the following surface: (a) the SDK's
`updateSessionStoreEntry` is found to NOT pass `skipCache: true`;
(b) the plugin is reachable via a `loadSessionStore` call OUTSIDE a
`withLock`; (c) the audit-callback is invoked async in a way that
re-orders relative to the write completion; (d) the grant-ledger is
hot-pathed (read on every gate decision) where its memory growth
becomes load-bearing.

### Cross-references to S3 invariants

S3 invariants 5+6 (atomic lock + fresh-read) are the literal race
surface. The plugin inherits both via the SDK. The audit chain
(invariants 4 + 9 — emit-on-persist, skip-on-reuse) is tested at
the unit level on InMemoryGateway. The race-fix anchor commit
(`1081067476`) is referenced in store.ts:7 docstring but not in any
test name; rename a test to mention the anchor for traceability.

---

**End A7 report.**
