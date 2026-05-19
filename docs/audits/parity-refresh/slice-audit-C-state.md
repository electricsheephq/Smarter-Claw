# Parity Audit C — State Cluster (S3 + S15)

**Auditor**: parity-refresh slice C (adversarial, read-only diff)
**Date**: 2026-05-19
**Cluster**: `src/state/{store.ts, session-store-gateway.ts, in-memory-gateway.ts, schema-version.ts}`
**Parity slices**: S3 (`persistApprovalRequest` 10-invariant race-fix mutator), S15 (real persistence gateway)
**In-host source-of-truth**: branch `rebase/pr70071-onto-main-2026-04-25` @ `ea04ea52c7` in `/Volumes/LEXAR/repos/openclaw-pr70071-rebase`
**In-host anchors**:
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237` — `persistPlanApprovalRequest` (race-fix anchor `1081067476`)
- `src/config/sessions/store.ts:610-668` — `withSessionStoreLock` + `updateSessionStoreEntry`
- `src/agents/plan-mode/approval.ts:45-150` — `resolvePlanApproval`
- `src/gateway/sessions-patch.ts:940` — `resolvePlanApproval` callsite (passes `expectedApprovalId`)

---

## 1. Per-file verdict

| File | Verdict | Notes |
|------|---------|-------|
| `src/state/store.ts` | **PASS with 2 parity-gaps** | All 10 invariants of `persistApprovalRequest` present + correct. `applyApprovalAction` drops the `expectedApprovalId` stale-event guard (C-1, P1). `persistApprovalRequest` writes `updatedAt` but in-host's lock writes nothing extra — minor (C-5). |
| `src/state/session-store-gateway.ts` | **PASS** | Faithfully wraps `updateSessionStoreEntry`; inherits invariants 5+6 (atomic lock + fresh `skipCache` read) from the SAME in-host SDK function. `null`-return-skips-write contract matched. SDK import-path guesses are fragile but fallback-guarded (C-6, P2). |
| `src/state/in-memory-gateway.ts` | **PASS** | Promise-chain per-key lock + `structuredClone` fresh-read correctly models invariants 5+6 for the test tier. Test-only; not a parity risk. |
| `src/state/schema-version.ts` | **PASS** | Stamp/read are correct and defensive. Invariant beyond in-host scope (in-host has no `__schemaVersion`); additive, not a drift. |

**Overall**: the load-bearing S3 slice is **structurally faithful**. No dropped invariant, no re-introduced race. The findings are one real P1 (stale-event guard not wired through the approval mutators) and several P2 polish items.

---

## 2. The 10 invariants — per-invariant parity table

In-host enumeration per `architecture-v2/09-AMENDMENT_1_VERIFICATION.md` and the in-host function body `pi-embedded-subscribe.handlers.tools.ts:130-237`.

| # | Invariant | In-host `file:line` | Plugin `file:line` | Present? | Correct? | Tested? |
|---|-----------|---------------------|--------------------|----------|----------|---------|
| 1 | **Sync bundle write** — `approvalId`+`title`+`payloadHash`+`lastPlanSteps`+`approval`+`updatedAt` in ONE write | tools.ts:206-223 | store.ts:250-272 | YES | YES — single `next` object literal returned to `withLock`; `stampSchemaVersion` wraps it; one write only | YES — store.test.ts:86-192 (7 cases incl. "ALL FOUR race-fix fields land atomically", asserts `writeCount===1`) |
| 2 | **Mode precondition guard** — `!current \|\| mode!=="plan"` → no write | tools.ts:180-182 | store.ts:214-221 | YES | YES — identical 2-clause guard; returns `{next:null}`; sets `kind:"skipped" reason:"not-plan-mode"` | YES — store.test.ts:42-84 (no-payload + normal-mode + plan-mode positive) |
| 3 | **Payload-hash idempotency** — hash-match cycle reuses `approvalId` | tools.ts:193-205 | store.ts:229-243 | YES | YES — sets `kind:"reused"`, returns existing `approvalId`, `{next:null}` (no write) | YES — store.test.ts:194-288 (REUSE happy case + writeCount===0) |
| 4 | **Audit-event emission** — `logPlanModeApprovalTransition` on persist path | tools.ts:224-229 | store.ts:275-284 | YES | YES — `audit()` fires only when `transition` is set (persist path only); see C-3 note re: emit-after-write ordering | YES — store.test.ts:290-351 ("emits audit event on the persist path") |
| 5 | **Atomic lock around read+update** | tools.ts:175 → store.ts:650 (`withSessionStoreLock`) | store.ts:209-273 via `gateway.withLock`; gateway impl: session-store-gateway.ts:225-262 → in-host `updateSessionStoreEntry` | YES | YES — production gateway delegates to the *same* in-host `updateSessionStoreEntry`, inheriting `withSessionStoreLock`. InMemoryGateway models it with a promise-chain lock | PARTIAL — in-memory chain only; real-gateway lock untested (store.test.ts:11-17 explicitly defers; C-4) |
| 6 | **Fresh-read inside the lock** (`skipCache:true`) | tools.ts:176 (`entry.planMode` from the locked, `skipCache` store at store.ts:651) | session-store-gateway.ts:230-232 reads `entry.pluginExtensions[...]` from the entry handed by `updateSessionStoreEntry` (which did `loadSessionStore(...,{skipCache:true})`) | YES | YES — fresh-read is inherited from in-host `updateSessionStoreEntry`; InMemoryGateway clones a fresh `Map` read | PARTIAL — same as #5 |
| 7 | **4-conjoined-condition idempotency decomposition** — ALL FOUR of: `payloadHash` truthy / hash-match / `approval==="pending"` / `approvalId` non-empty string | tools.ts:194-199 | store.ts:229-235 | YES | YES — exact 4-clause conjunction (`hashMatch && stillPending && hasApprovalId`, where `hashMatch` itself folds in the `payloadHash!==undefined` clause) | YES — store.test.ts:225-287 — one ROTATE test per failing condition (6 tests covering all 4 fail-axes incl. empty-string + rejected-state) |
| 8 | **IO-error fail-soft** — try/catch swallows, returns candidate `approvalId`, never throws | tools.ts:153-235 (catch at 233-235) | store.ts:208 / 296-305 | YES | YES — outer try/catch; `kind:"failed"` carries `error` + candidate `approvalId`; `logger.warn`; never re-throws | YES — store.test.ts:353-400 ("returns failed + candidate approvalId", "NEVER throws") |
| 9 | **Deliberate audit-skip on reuse** | tools.ts:202-204 (comment + early `return null` before `logPlanModeApprovalTransition`) | store.ts:236-243 (returns `{next:null}` with NO `transition` → audit branch at 277 not taken) | YES | YES — reuse path returns no `transition`; `if (transition && this.audit)` therefore skips | YES — store.test.ts:314-329 ("SKIPS audit on the reuse path — invariant 9") |
| 10 | **Lazy-imports discipline** | tools.ts:154-164 (`Promise.all` of dynamic imports) | session-store-gateway.ts:156-205 (`loadSdk()` dynamic `import()` behind a memoized promise) | YES | YES — store.ts is self-contained (N/A, per its docstring); the *gateway* preserves lazy-import discipline for the SDK surface — closer parity than the docstring claims | YES (shape) — session-store-gateway.test.ts:25-88 covers routing fallback; full lazy-resolution deferred to Eva-live |

**10-invariant pass/fail line: 10 / 10 PRESENT, 10 / 10 CORRECT, 8 / 10 fully unit-tested (#5 + #6 are integration-deferred — `test-gap`, not a bug).**

---

## 3. Lock semantics — `withLock` vs in-host `withSessionStoreLock`

- **Production path (`SessionStoreGateway`)**: `withLock` resolves the store path, then calls in-host `updateSessionStoreEntry` (`session-store-gateway.ts:225`). That function IS the in-host one — `withSessionStoreLock(storePath, …)` + `loadSessionStore(storePath, {skipCache:true})` (in-host `store.ts:650-651`). So invariants 5 (atomic lock) and 6 (fresh `skipCache` read) are not *re-implemented* — they are *inherited from the identical SDK function*. This is the strongest possible parity for S15. ✔
- **`null`-skips-write contract**: in-host `updateSessionStoreEntry` treats a `null` return from the `update` callback as "no patch" (`store.ts:658-660`). The plugin gateway returns `null` from its inner callback whenever `update()` yields `{next:null}` (`session-store-gateway.ts:235-241`). Matched exactly. ✔
- **In-memory path**: promise-chain lock keyed per `sessionKey` + `structuredClone` on both read and write. Correctly serializes and prevents mutate-by-reference. Adequate for the test tier. ✔
- **Gap (C-2, P2)**: the in-host lock keys on **`storePath`** (one mutex per store file — *all* sessions in a store serialize). The plugin's `InMemoryGateway` keys on **`sessionKey`** (finer-grained). For the in-memory test gateway this is harmless (tests are single-session). The *production* gateway inherits the in-host `storePath`-keyed lock, so production parity is intact — but the InMemoryGateway's finer lock could mask a cross-session ordering bug that only the real gateway exposes. Documentation-level risk, not a runtime bug.

---

## 4. The race-fix (commit `1081067476`)

The race fix made `persistPlanApprovalRequest` write `lastPlanSteps` + `title` **synchronously, in the same write as `approvalId`**, so `sessions-patch.ts` reads populated steps on a fast Approve click.

- **In-host**: `tools.ts:206-223` — single `nextPlanMode` literal; caller `tools.ts:1863-1876` passes `title`, `payloadHash`, and a mapped `lastPlanSteps` array into the SAME call.
- **Plugin**: `store.ts:250-272` — single `next` literal carrying `approval`, `approvalId`, `updatedAt`, and conditionally `title` / `lastPlanPayloadHash` / `lastPlanSteps`; returned once to `gateway.withLock`. **One write.** ✔
- **Verified synchronous**: `store.test.ts:146-162` ("ALL FOUR race-fix fields land atomically in one write") asserts every field is present AND `gw.writeCount === 1`. The race cannot re-appear through this mutator. ✔

**Race-fix verdict: faithfully ported.** No P0.

---

## 5. `host_ref:` citations

- `store.ts` carries `host_ref:` tags at lines 89, 111, 135, 315, 388, 456, 492, 525 — and a module-level anchor at lines 5-7. **Present and accurate** against `ea04ea52c7`. ✔
- One citation drift (C-7, P2): `store.ts:6` cites the anchor commit as "`1081067476`, the empty-plan-body race-fix anchor" — correct — but the file lines `130-237` are quoted against `ea04ea52c7` (current tip). Both are stated; harmless but the doc-comment conflates the two SHAs without saying `1081067476` is an *ancestor* of `ea04ea52c7`. Cosmetic.
- `store.ts:135` cites the caller-contract at `pi-embedded-subscribe.handlers.tools.ts:1881-1886` — verified, the in-host caller reads `persistResult.reused` at `tools.ts:1882`. ✔
- `session-store-gateway.ts:14` cites `pi-embedded-subscribe.handlers.tools.ts:156` for `updateSessionStoreEntry` — verified (in-host line 156 is inside the `Promise.all` import block). ✔

---

## 6. Schema-version stamping

- `stampSchemaVersion` is applied on **every** successful-write return path in `store.ts`: persist (272), enterPlanMode (357), exitPlanMode (425), applyApprovalAction (581), setAutoApprove lazy-init (662) + toggle (677). ✔
- Reuse / skip / noop / failed paths return `{next:null}` → no stamp, correctly (C-3 test confirms). ✔
- `readSnapshot` rejects payloads with a newer `__schemaVersion` (`store.ts:727-732`). ✔
- This is a **plugin-only invariant** — the in-host has no `__schemaVersion` field. It is additive (does not change any in-host-visible field), so it is **not a parity drift**; it is a forward-compat hardening the plugin adds because its `PlanModeSessionState` is now a cross-plugin wire contract. Acceptable.

---

## 7. Test coverage assessment

`tests/state/store.test.ts` — claimed "67 cases". Actual: **57 `it()` blocks** across 16 `describe` blocks (C-8, `test-gap`/doc-drift, P2). Coverage of the 10 invariants + 4 result kinds:

- **All 10 invariants**: covered (see §2 table). #5/#6 only via the in-memory gateway — the real-gateway lock + `skipCache` round-trip is **explicitly deferred** to Eva-live (`store.test.ts:11-17`). That deferral is a genuine `test-gap` (C-4): a regression in `session-store-gateway.ts`'s slot-merge logic (e.g. clobbering a sibling plugin's `pluginExtensions` entry) would not be caught by any automated test — `session-store-gateway.test.ts` is shape-only (no disk round-trip, lines 13-19 say so).
- **4 result kinds** of `persistApprovalRequest`: `persisted` ✔ (75-83), `reused` ✔ (213-223), `skipped` ✔ (53-73), `failed` ✔ (353-399). All four also asserted to carry an `approvalId` (402-445). ✔
- **Missing negative test (C-9, `test-gap`, P2)**: no test asserts that on the **reuse** path the candidate `lastPlanSteps` / `title` are NOT written (the reuse path returns `{next:null}` so by construction nothing is written, but there is no regression test pinning "a reuse call with a *different* `lastPlanSteps` leaves the persisted steps untouched"). A future refactor that moved the bundle-build above the idempotency guard would silently overwrite. Worth one test.

---

## 8. Findings table

| ID | Title | Class | Severity | In-host `file:line` | Plugin `file:line` |
|----|-------|-------|----------|---------------------|--------------------|
| C-1 | **`applyApprovalAction` never passes `expectedApprovalId` to `resolvePlanApproval`** — the stale-event guard (`approval.ts:80-83`) is dead code in the plugin's mutator path. In-host `sessions-patch.ts:940` passes `expectedApprovalId` so a stale Approve click (token mismatch) is no-op'd. The plugin's `recordApproval`/`recordRejection`/`recordTimeout` call `resolvePlanApproval(current, action, feedback)` with NO 4th arg — any pending cycle is resolvable by *any* caller regardless of which `approvalId` the UI event carried. Re-opens the orphan-card / cross-surface-stale-click class the guard exists to close. | parity-gap | **P1** | `sessions-patch.ts:940`; `approval.ts:80-83` | `store.ts:571` (call site, 4th arg omitted); `applyApprovalAction` input type `store.ts:549-557` has no `expectedApprovalId` field |
| C-2 | InMemoryGateway locks per **`sessionKey`**; in-host `withSessionStoreLock` locks per **`storePath`** (coarser). Production gateway inherits the in-host lock so prod parity holds — but the test gateway's finer lock can mask a cross-session ordering bug. | parity-gap | P2 | `store.ts:610` (`storePath`-keyed) | `in-memory-gateway.ts:38,70-78` (`sessionKey`-keyed) |
| C-3 | Audit emitted **after** `withLock` resolves (i.e. after the write lands). In-host emits `logPlanModeApprovalTransition` *inside* the callback, *before* the disk persist. Plugin: if a sibling subscriber observed the audit event it would be post-write — actually *safer* than in-host (in-host can log a transition that then fails to persist). Noting as a deliberate, benign divergence, not a bug. | parity-gap | P2 | `tools.ts:224` (inside callback, pre-persist) | `store.ts:277-284` (after `withLock`) |
| C-4 | No automated test exercises the **real** `SessionStoreGateway` against a `session.json` round-trip. `session-store-gateway.test.ts` is shape-only; invariants 5/6 are in-memory-only. A slot-merge regression (clobbering sibling `pluginExtensions`) ships uncaught. | test-gap | P2 | n/a | `tests/state/session-store-gateway.test.ts:13-19` (deferral stated) |
| C-5 | `persistApprovalRequest` writes `updatedAt: Date.now()` on the persist path; in-host also writes `updatedAt: now`. **Matched** — listed only to record it was checked. No action. | (verified) | — | `tools.ts:210` | `store.ts:254` |
| C-6 | `SessionStoreGateway.loadSdk` guesses SDK import paths (`openclaw/plugin-sdk/config-runtime`, `openclaw/plugin-sdk/runtime`) with `as string` casts + try/catch fallback. If the installed SDK renames these, config/routing silently degrade to the fallback parser (still functional, but `resolveStorePath` could resolve the wrong store if `loadConfig` is missing). Fragile; the in-host imports are statically resolved (`tools.ts:154-164` import real module paths). | parity-gap | P2 | `tools.ts:50-56` (typed module imports) | `session-store-gateway.ts:164-177` |
| C-7 | `store.ts:6` doc-comment conflates anchor SHA `1081067476` with tip `ea04ea52c7` without noting the ancestor relationship. Cosmetic. | parity-gap | P2 | n/a | `store.ts:5-7` |
| C-8 | `store.test.ts:1` header + brief claim "67 cases"; file actually has **57** `it()` blocks. Doc-drift in the test header / brief. | test-gap | P2 | n/a | `tests/state/store.test.ts` (count) |
| C-9 | No negative regression test pinning that the **reuse** path does not overwrite persisted `lastPlanSteps`/`title` with a differing candidate. Currently safe by construction (`{next:null}`); unprotected against a future bundle-reorder refactor. | test-gap | P2 | n/a | `tests/state/store.test.ts` (absent case) |

---

## 9. Severity counts

- **P0**: 0
- **P1**: 1 — C-1 (`expectedApprovalId` stale-event guard not wired through `applyApprovalAction`)
- **P2**: 7 — C-2, C-3, C-4, C-6, C-7, C-8, C-9 (C-5 is a verified-OK, not a finding)

---

## 10. Conclusion

The S3 race-fix mutator is **structurally faithful** — all 10 invariants present, all 10 correct, the empty-plan-body race cannot re-appear through `persistApprovalRequest`. The S15 production gateway is the strongest possible port because it *reuses the identical in-host `updateSessionStoreEntry`* rather than re-implementing the lock.

The one real defect is **C-1**: the plugin re-ported `resolvePlanApproval` byte-identically (correct) including its `expectedApprovalId` parameter — but the `PlanModeStore` mutators that *call* it never thread the approval token through. In-host, `sessions-patch.ts:940` does. The result: the stale-event / cross-surface-click guard that `resolvePlanApproval` carries is dead code in the plugin. This should be P1-fixed by adding `expectedApprovalId?: string` to the `recordApproval`/`recordRejection`/`recordTimeout` inputs and forwarding it as the 4th arg at `store.ts:571`.
