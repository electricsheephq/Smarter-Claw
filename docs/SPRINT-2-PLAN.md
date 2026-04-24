# Sprint 2 — Structural plan-state migration (Alternative I)

**Status**: design proposal, not started
**Closes**: #44, #45, #46, #47
**Unblocks**: Phase D Eva beta cutover (priority/blocker bucket → empty)
**Depends on**: Sprint 1 PRs #65 + #66 + hotfix #67 already merged

## The bug class Sprint 2 retires

Sprint 1 fixed the symptoms of `mergeSessionEntry`'s shallow-spread clobbering `pluginMetadata['smarter-claw']` (BUG #1). The fix worked by adding a top-level mirror that survives the clobber + reading the mirror as fallback when the slot is empty. PR #67 then patched the fallback to accept both `kind: "approval"` (slot shape) and `kind: "plan"` (mirror shape after kind-translation).

Each layer of workaround added a new ambiguity:
- Source-of-truth ambiguity: slot vs mirror
- Vocabulary ambiguity: `awaiting-approval` vs `pending`, `approval` vs `plan`
- Approval-ID ambiguity: minted in plugin, projected into mirror, validated in handler — three places to drift
- Lifecycle ambiguity: `ask_user_question` does not produce a first-class `planApproval` event

Sprint 2 removes the bug class structurally: **plan state moves out of the session entry entirely.**

## Architecture target

```
┌─────────────────────────────────────────────────────────────┐
│ Plugin-owned file state (source of truth)                   │
│ ~/.openclaw/state/smarter-claw/<sessionKeyHash>.json        │
│   { planMode, approvalId, planApproval, autoApprove,        │
│     pendingInteraction, lastPlanSteps, injectionQueue,      │
│     blockingSubagentRunIds, ... }                           │
└────────────┬────────────────────────────────────────────────┘
             │ projection (host vocabulary)
             ▼
┌─────────────────────────────────────────────────────────────┐
│ Session entry top-level fields (UI hydration surface)       │
│   planMode: { mode, approval, approvalId, ... }             │
│   pendingInteraction: { kind: "plan"|"question", ... }      │
│   pendingQuestionApprovalId                                 │
│ NOT WRITTEN: pluginMetadata['smarter-claw']                 │
└─────────────────────────────────────────────────────────────┘
```

`mergeSessionEntry`'s shallow-spread cannot clobber file state. Top-level mirror writes are idempotent — the projection re-derives them on every persist. UI hydration code is unchanged (still reads top-level fields).

## PR slicing

### PR a — file-state store + projection adapter (closes #44 + #45)

**Surface area** (~400 LOC + tests):

1. NEW `src/plugin-state-store.ts`:
   - `loadPluginState(sessionKey, opts) → SmarterClawSessionState | undefined`
   - `withPluginState(sessionKey, update, opts) → result` — atomic read-update-write under file lock (lockfile sibling, mtime-pinned)
   - Path: `${api.paths.stateDir ?? ~/.openclaw}/state/smarter-claw/${sha256(sessionKey).slice(0,16)}.json`
   - Tests: concurrent-write isolation, ENOENT graceful, EACCES surfaces actionable error

2. NEW `src/plan-state-adapter.ts`:
   - `projectToSessionEntry(state) → top-level mirror only` (no pluginMetadata)
   - Vocabulary translation: `awaiting-approval` → `pending`, `approval` → `plan` (kind), `timed_out` stays `timed_out`
   - Single approval-ID source: `state.approvalId`. Projection stamps it into both `planMode.approvalId` and `pendingInteraction.approvalId`.

3. REFACTOR `runtime-api.ts:persistSmarterClawState`:
   - Step 1: `withPluginState(sessionKey, update)` — file-state mutation under lock
   - Step 2: project the new state, return `{ ...mirror }` (NOT `pluginMetadata`) to `updateSessionStoreEntry`
   - The session entry surfaces still get the new mirror on every persist (idempotent), so even if `mergeSessionEntry` clobbers, the next persist restores them

4. REFACTOR `runtime-api.ts:readSmarterClawState`:
   - Reads from file state via `loadPluginState(sessionKey)` (requires sessionKey arg — caller already has it)
   - Migration: if file missing AND session entry has `pluginMetadata['smarter-claw']`, copy slot → file once, then return file state. Log migration event.

5. CONTRACT TESTS:
   - Plan approval projection round-trip (file ↔ session entry)
   - Question approval projection round-trip
   - Stale-field clearing (cancel a question → both file and projection clear)
   - Refresh hydration shape matches PR #70071 spec exactly

**Acceptance** (#44 + #45):
- [x] One adapter (`projectToSessionEntry`) owns plugin → host translation
- [x] UI/gateway-visible approval values are only `pending`/`approved`/`edited`/`rejected`/`timed_out`
- [x] No `awaiting-approval` in projected output (file may keep internal name temporarily for back-compat; converted on every projection)
- [x] One approval ID source: `state.approvalId`; persisted, emitted, rendered, validated all read same value
- [x] Session row forwarding includes `planMode`, `pendingInteraction`, pending question fields, `lastPlanSteps`
- [x] Contract tests cover all four shapes

### PR b — question-approval first-class lifecycle (closes #46)

**Surface area** (~150 LOC + tests):

1. `src/tools/ask-user-question-tool.ts` emits a host approval event with the same approvalId stored in file state (currently emits via `pendingQuestionApprovalId` field only)
2. State carries question metadata: `prompt`, `title`, `options[]`, `allowFreetext`, `createdAt`, `status`
3. Host-side patch addition: `sessions-patch-handler-plan-mode.diff` accepts `planApproval.action: "answer"` (route through to plugin)
4. Answer handler validates: approvalId match + (optional) questionId + option membership + free-text policy
5. Sanitize answer text before `[QUESTION_ANSWER]` injection envelope (similar to `sanitizeFeedbackForInjection`)
6. `/plan answer` command + UI card both surface state from same projection — verified post-refresh

**Acceptance** (#46):
- [x] All criteria met by combining file-state plumbing (PR a) + answer-action wiring (PR b)

### PR c — turn-boundary inject delivery (closes #47)

**Surface area** (~200 LOC + tests):

1. Wire injection drain to `api.on("before_prompt_build")` semantics that match the host-runner turn-boundary semantics
2. Atomic deliver-then-clear: drain reads queue, builds prompt fragment, persist clears those entries with same approvalId/cycleId — single `withPluginState` round-trip
3. Approved/edited `[PLAN_DECISION]` injection includes `lastPlanSteps` payload (per PR #70071 — currently sends only the decision marker)
4. Rejection feedback already sanitized via existing `sanitizeFeedbackForInjection`; question answers get the same treatment (PR b)
5. Tests:
   - Clear-failure preserves entries for next turn (no missing delivery)
   - Successful clear ensures no duplicate next turn (no double delivery)
   - Approved injection round-trip carries plan steps

**Acceptance** (#47):
- [x] Atomic drain via single persist
- [x] Full plan steps in approved injection
- [x] Sanitized feedback + answers
- [x] No duplicate / no missing under failure injection

### PR d — observability parity (closes #48)

**Surface area** (~100 LOC of helper + ~60 call-site updates):

1. NEW `src/debug-log.ts` extension: `logEvent(family, event, fields)` with bounded value previews
2. Add correlation IDs to every log: `sessionKey`, `agentId`, `runId`, `cycleId`, `approvalId`, `questionId`, `toolCallId`, `injectionId`, `childRunId`, `nudgeJobId` when in scope
3. Define log families: `register`, `state`, `persist`, `gate`, `queue`, `hook`, `snapshot`, `retry`, `ui-bridge`, `timing`
4. Audit every lifecycle hook: replace silent returns with `logEvent("hook", "skipped", { reason })`
5. Bounded preview helper: truncates strings > N chars with `… (truncated)`; never logs full plans by default

**Acceptance** (#48):
- [x] All 10 correlation IDs in scope where available
- [x] All 10 log families present
- [x] Zero silent skips
- [x] Approval traceable proposal → decision → next-turn delivery

## Order of operations

PRs a → b → c → d. Each merges only after CI green + 1 review. PR a is the foundation; PRs b/c/d build on it without rework.

After all 4 land:
1. Confirm Eva approval flow under live load for 24h (interim soak)
2. Close issues #44–#48
3. Tag `v0.2.0-beta.1` per RELEASING.md
4. Phase D cutover (Eva to vanilla v2026.4.22 + this beta)
5. 48–72h soak per Phase D
6. If clean → Phase E npm publish

## Risks and mitigations

**Risk 1 — file-lock cross-process safety.** Lockfile sibling + mtime-pinned won't survive cross-process if multiple gateways run on same host. Mitigation: today's deploy is single-process gateway (per existing comment in runtime-api.ts:217). Multi-process safety is upstream work; out of scope here.

**Risk 2 — migration data loss.** First read after upgrade copies slot → file then deletes slot. If that operation crashes mid-way, slot may be dropped before file write completes. Mitigation: write file FIRST under exclusive lock (`wx`), only then clear slot in next persist cycle. Migration is one-way and the slot becomes garbage from session entry's perspective once file exists.

**Risk 3 — installer patch surface grows.** PR b adds a `planApproval.action: "answer"` route in `sessions-patch-handler-plan-mode.diff`. The patch is already large; one more case is incremental. Diff churn risk for future host-version bumps.

**Risk 4 — test coverage regression.** 563 tests today; each PR adds ~30 contract tests + updates ~10 existing. Net +120 tests. Vitest CI time goes from ~28s to ~50s — still well under the 10-min CI timeout.

## Adversarial review findings (2026-04-25 sub-agent pass)

A general-purpose research agent ran a structural attack against this design before implementation. Five issues found; three are **PR-a-blocking** and require design changes here. The recommendation was "PROCEED WITH MODIFICATIONS" — direction is right, scope of PR a needs to grow.

### Blocker #1 — host-patch is a continuing slot writer (CRITICAL, agent confidence 90%)

The Sprint 1 host patch `installer/patches/core/sessions-patch-handler-plan-mode.diff` (lines 25-50, 74, 168-178, 220-235) writes `pluginMetadata['smarter-claw']` directly when an inline-button approval lands. After PR a, that's an out-of-band writer to the legacy slot — the file state still says `awaiting-approval` while the slot says `approved`. The "migration is one-way" claim in Risk 2 is false because the host patch is a continuing writer, not a one-time migration source.

**Required PR-a-scope addition**: Amend `sessions-patch-handler-plan-mode.diff` so the patch handler STOPS writing the slot once file state exists. Two options:
- **(a)** Patch handler writes to a "host-mutation queue" file at `~/.openclaw/state/smarter-claw/host-mutations.jsonl`; plugin drains in `before_prompt_build`. Decouples paths cleanly.
- **(b)** Patch handler becomes a thin event emitter via `publishUiHint` or equivalent; plugin's hook reconciles. Cleaner but requires SDK seam audit.

PR-a now: ~400 → ~600 LOC.

### Blocker #2 — read-path becomes async file I/O on every hot path (CRITICAL, agent confidence 95%)

`readSmarterClawState(entry)` is called synchronously from at least 6 hot paths: `archetype-hook.ts:84`, `injection-drain-hook.ts:74`, `slash-commands.ts:326`, `plan-mode-status-tool.ts`, `lifecycle-hooks.ts:19`, `runtime-api.ts:181`. PR a §4 changes signature to `loadPluginState(sessionKey)` (async). Several call sites only have the entry in scope (inside `update: (entry) => …` callbacks) — `sessionKey` is not always plumbed. Even where it is, every read becomes a syscall, including `before_tool_call` on the latency-critical loop.

**Required PR-a-scope additions**:
1. Audit every `readSmarterClawState` call site; explicitly enumerate which receive `sessionKey`. For ones that don't, plumb it through.
2. Keep an in-process per-`sessionKey` LRU cache invalidated on every `withPluginState` write. Cache hit → no syscall. Cache miss → file read.
3. Keep a **synchronous** `readSmarterClawStateFromEntry(entry)` fast-path that reads the projection from the entry's top-level mirror. Only fall through to file if projection is incomplete (during migration window). This means the `before_prompt_build` and `before_tool_call` hot paths stay synchronous.

### Blocker #3 — Lock ordering between file lock + store lock is undefined (HIGH, agent confidence 80%)

`withPluginState` takes a file lock; `updateSessionStoreEntry` is already wrapped in `withSessionStoreLock(storePath)` (per runtime-api.ts:200-210). After Sprint 2, an Approve click takes BOTH locks sequentially. Worse, the acquire order isn't pinned: host-patch path takes store lock first then plugin code may want file lock; plugin-persist path takes file lock first then enters store lock via `updateSessionStoreEntry`'s callback. Classic AB/BA deadlock if both directions race.

**Required PR-a-scope addition**: Pin global lock order — file lock MUST always be acquired BEFORE store lock, never the reverse. This forces Blocker #1's resolution to be option (a) (host-patch writes to queue file) rather than option (b) (host-patch enters plugin code reentrantly while holding store lock — that path can't safely acquire the file lock).

### Non-blockers (defer to follow-up)

- **#4 Vocabulary translation is one-way.** Host upgrades that add new approval states would round-trip through projection but file-state writer doesn't accept them back. **Fix**: bidirectional projection schema with exhaustive `assertNever` switch + "rejected unknown vocabulary" log family. **Defer** to PR d (observability) — the silent-drop becomes visible there.

- **#5 Test coverage gaps.** (a) Session-delete cleanup: orphaned files in state dir accumulate; need GC pass or `on:session_deleted` SDK hook. (b) Read-only filesystem fallback: `withPluginState` should degrade to in-memory ephemeral with warning, not crash. (c) `sha256(sessionKey).slice(0,16)` is 64-bit truncation; collision probability nontrivial across multi-tenant deploys. **Fix**: GC test in PR a, RO-FS test in PR a, full-hash + length suffix in PR a.

### Updated PR-a scope after these findings

Original: ~400 LOC + tests
Updated: ~600 LOC + tests (added: host-mutation queue, LRU read cache, fast-path sync read, lock-order assertion, GC + RO-FS handling, full-hash filenames)
Estimated: 4-6 hr of focused work, not 2-4 hr.

## Upstream RFC parallel track

While Sprint 2 ships these workarounds in our plugin, file an upstream RFC against `openclaw/openclaw` for `mergeSessionEntryWithPolicy` — a non-shallow-merge variant that preserves unknown plugin slots. Once upstream lands (estimated post-v2026.5.x), Smarter-Claw can drop the file-state migration and write directly to `pluginMetadata['smarter-claw']` again with safety. The file-state path stays as the multi-process-safe option for hosts that opt in.

RFC tracking issue lives in this repo until upstream PR exists.
