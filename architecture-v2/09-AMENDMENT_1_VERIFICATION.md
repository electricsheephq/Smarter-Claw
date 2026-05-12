## Verification: persistPlanApprovalRequest

### Source location
- File: `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-subscribe.handlers.tools.ts`
- Function: `persistPlanApprovalRequest`
- Lines: 130–237 (LOC count: 108 incl. doc-comment; function body 130–237, callback body 175–231)
- Worktree HEAD at audit: `ea04ea52c7` (audit anchor; the doc-tag race-fix commit in user memory is `1081067476`, which is an ancestor — the current tip merely appends the `[plan-accept-debug]` line at the precondition)
- Test coverage: ZERO direct unit tests. `grep -rn 'persistPlanApprovalRequest\|lastPlanPayloadHash' src/ test/` returns only the function itself, type definitions, and one prose comment in `auto-reply/reply/commands-plan.ts:297`. The four invariants are exercised only through live integration (Eva) and the broader `sessions-patch` flow.

---

### Invariant (a) — Sync bundle write
**VERIFIED — EXPANDED** (the adversarial agent listed 4 fields; the code writes up to **7**)

- All writes happen inside ONE `updateSessionStoreEntry` callback (line 175). The callback returns a single `{ planMode: nextPlanMode }` patch at line 230, which `updateSessionStoreEntry` then `mergeSessionEntry`s and persists atomically under `withSessionStoreLock` (store.ts:650 → store.ts:610).
- Fields written into `nextPlanMode` (lines 206–223):
  1. `...current` — spread of prior planMode object (preserves `mode`, `cycleId`, `enteredAt`, `rejectionCount`, `blockingSubagentRunIds`, `autoApprove`, etc.)
  2. `approval: "pending"` (line 208) — overwrites prior approval state
  3. `approvalId` (line 209) — the candidate ID (NOT `resolvedApprovalId`; reuse path returns null before this branch)
  4. `updatedAt: now` (line 210)
  5. `title` (line 218, optional — only if `planSnapshot.title` truthy)
  6. `lastPlanPayloadHash` (line 219, optional — only if `planSnapshot.payloadHash` truthy)
  7. `lastPlanSteps` (lines 220–222, optional — only if non-empty array)
- Code excerpt (lines 206–223):
  ```ts
  const nextPlanMode = {
    ...current,
    approval: "pending" as const,
    approvalId,
    updatedAt: now,
    ...(planSnapshot?.title ? { title: planSnapshot.title } : {}),
    ...(planSnapshot?.payloadHash ? { lastPlanPayloadHash: planSnapshot.payloadHash } : {}),
    ...(planSnapshot?.lastPlanSteps && planSnapshot.lastPlanSteps.length > 0
      ? { lastPlanSteps: planSnapshot.lastPlanSteps }
      : {}),
  };
  ```
- Atomicity: `withSessionStoreLock` (store.ts:610) provides a serialized critical section per store path; the read (`loadSessionStore`), the callback evaluation, and the persist all run while holding the lock. The bundle is therefore not just "one call" but one **lock-scoped transaction**.

---

### Invariant (b) — Mode precondition guard
**VERIFIED**

- Condition: `!current || current.mode !== "plan"` (line 180)
- Behavior on false (i.e. predicate true): returns `null` from the update callback, which `updateSessionStoreEntry` interprets as "no patch — return existing entry unchanged" (store.ts:658–660). No write occurs. The outer function then falls through to the bottom `return { approvalId: resolvedApprovalId, reused: false }` (line 236) — the CANDIDATE approvalId echoes back, but disk is untouched, so any later approval click will still fail the `resolvePlanApproval` stale-id check.
- Code excerpt (lines 176–182):
  ```ts
  const current = entry.planMode;
  // No active plan-mode session — agent called exit_plan_mode
  // outside of plan mode (shouldn't happen in normal flow). Leave
  // the entry untouched so we don't accidentally arm the gate.
  if (!current || current.mode !== "plan") {
    return null;
  }
  ```
- Note: the guard checks **two** sub-conditions (entry has any planMode AND mode is "plan"). A pure-Smarter-Claw mirror that only tests `mode === "plan"` would dereference undefined when no planMode object exists yet.

---

### Invariant (c) — Payload-hash idempotency
**VERIFIED — EXPANDED** (the adversarial agent said "if hashes match, reuse"; the code requires **4 conjoined conditions**, not 1)

- Hash field: `current.lastPlanPayloadHash` (compared to `planSnapshot.payloadHash`)
- Match behavior: SHORT-CIRCUITS the entire write. Sets `resolvedApprovalId = current.approvalId`, sets `reused = true`, returns `null` from the callback (no write — entry already correct), and SKIPS the audit emission (the comment at line 202 explicitly notes this).
- Guard requires ALL of:
  1. `planSnapshot?.payloadHash` truthy (line 194)
  2. `current.lastPlanPayloadHash === planSnapshot.payloadHash` (line 195)
  3. `current.approval === "pending"` (line 196) — cycle still live
  4. `typeof current.approvalId === "string" && current.approvalId.length > 0` (lines 197–198)
- Comment justifying it (lines 183–192):
  ```ts
  // 2026-04-28 (Eva live-test) IDEMPOTENCY GUARD: if the candidate
  // payload has the SAME hash as the last persisted hash AND the
  // cycle is still pending with a valid approvalId, reuse the
  // existing approvalId. Collapses duplicate exit_plan_mode
  // retries (model retried the tool, runner re-fired after a
  // transient error, Telegram /plan accept never propagated, etc.)
  // so the user's existing approval card / `/plan accept` is
  // never orphaned by a rotated ID. Conservative — only fires when
  // every condition is true; falls through to the rotate path
  // otherwise so behavior never gets WORSE than today.
  ```
- Type-system anchor: the field is documented in both `src/config/sessions/types.ts:376–384` and `src/agents/plan-mode/types.ts:95`, with cross-refs back to `persistPlanApprovalRequest`. Two duplicate type definitions for the same conceptual field — itself a smell the plugin port should consolidate.

---

### Invariant (d) — Audit-event emission
**VERIFIED**

- Function called: `logPlanModeApprovalTransition` (imported from `./plan-mode/plan-mode-debug-log.js` at line 44; called at line 224)
- Called **inside** the `update` callback, but **before** the patch is returned (line 230) — so it executes within the `withSessionStoreLock` critical section but BEFORE the disk write actually lands (the persist happens in `persistResolvedSessionEntry` after the callback returns, store.ts:662). If the disk write subsequently fails, the audit log records a transition that didn't actually persist — a small but real gap.
- Skipped in the reuse path (no transition occurred — the comment at line 203 calls this out).
- Skipped in the precondition-fail path (returns `null` before reaching line 224).
- The helper itself is a pure log emitter (`plan-mode-debug-log.ts:260–287`): gated on `isPlanModeDebugEnabled()`, suppresses no-op transitions (line 275), then calls `logger.info`. No fs writes, no crons, no side effects.
- Code excerpt (lines 224–230):
  ```ts
  logPlanModeApprovalTransition(
    sessionKey,
    current,
    nextPlanMode,
    "pi-embedded-subscribe:persistPlanApprovalRequest",
  );
  return { planMode: nextPlanMode };
  ```

---

### Additional invariants found

The adversarial agent missed several:

- **(e) Atomicity envelope via `withSessionStoreLock`** (store.ts:610, invoked at store.ts:650): the entire read-modify-write is serialized per store path. The four claimed invariants are not just "co-located in the same callback" — they share a mutex-protected critical section. A plugin port that calls `updateSessionStoreEntry`-equivalents from multiple sites cannot reproduce this without an equivalent lock.
- **(f) Skip-cache read** (store.ts:651, `loadSessionStore(storePath, { skipCache: true })`): the entry is re-read from disk inside the lock, defeating the in-process cache. The idempotency check at lines 193–199 therefore sees the latest persisted state, not a stale snapshot. A typed mutator MUST guarantee the same — otherwise the hash check is racy.
- **(g) Order-independence within the bundle**: all writes are object-spread into one literal; order on the wire doesn't matter. But the dependency between the GUARD read (`current.lastPlanPayloadHash`) and the WRITE (`lastPlanPayloadHash: planSnapshot.payloadHash`) is order-sensitive within the callback — the guard MUST run before the write of the new hash, otherwise it would always match itself. Code already gets this right (lines 193–205 before 206–223) but it's a precondition a typed mutator API must encode.
- **(h) Try/catch around the entire IO** (lines 153–235): any error in module load, config load, path resolve, or `updateSessionStoreEntry` is swallowed and logged via `log?.warn?.` (line 234). The function then returns `{ approvalId: <candidate>, reused: false }` — the caller cannot tell apart "persisted" from "failed". The Smarter-Claw plugin will need explicit `Result<>` typing here if it wants to fix this gap rather than mirror it.
- **(i) Dual return shape**: `{ approvalId, reused }`. Caller (line 1881) overrides its local `approvalId` from the persist result and branches on `reused` to emit a duplicate-detected warning (lines 1882–1886). The mutator output is part of the contract — the function is NOT void-returning.
- **(j) Lazy-import constraint** (lines 154–164): `updateSessionStoreEntry`, `loadConfig`, `resolveStorePath`, `parseAgentSessionKey` are all dynamic-imported via `Promise.all`. Per the repo's `CLAUDE.md`, no module may be both statically AND dynamically imported in the same prod tree — the plugin port must preserve this discipline or ship a `*.runtime.ts` boundary.

So the function actually encodes **at least 10** invariants when you count the lock/cache/error-handling envelope. The four the adversarial agent listed are the most user-visible, but the envelope-level ones (e, f, h) are what make the four work in practice.

---

### Tests covering this function
- **None directly.** Greps across `src/` and `test/` for `persistPlanApprovalRequest` or `lastPlanPayloadHash` return only the function definition, two duplicate type-doc comments (`src/config/sessions/types.ts:376–384`, `src/agents/plan-mode/types.ts:95`), and one prose reference in `src/auto-reply/reply/commands-plan.ts:297`.
- `src/agents/pi-embedded-subscribe.handlers.tools.test.ts` exists but does not exercise this function (zero matches for either symbol).
- Indirect coverage is via the broader `sessions-patch` approve-flow tests and the Eva live-test (referenced in the dated comments at lines 115, 137, 183 — all "Eva live-test" anchors are manual QA, not automated). This is itself a finding: a function carrying four-to-ten safety invariants has no automated regression net.

---

### Verdict

- The adversarial agent's claim is **PARTIALLY VERIFIED but UNDERSTATED**. The four invariants it named (a/b/c/d) are all real and present at the claimed location. But the function actually encodes ~10 invariants once you count the lock/cache/error envelope and the multi-condition decomposition of (c). The amendment should ENCODE THE FULL ENVELOPE, not just the four headline rules.
- The typed-mutator API needs to encode **10** invariants — the 4 headline + 6 envelope (atomic lock, fresh-read, conjoined-guard decomposition, error-swallowing-returns-candidate, reuse-skip-of-audit, lazy-import discipline). Failing to encode any one of these silently breaks one of the bug fixes (race, orphan card, Telegram /plan accept duplicate-fire, debug audit trail).
- Sample typed-mutator signature:
  ```ts
  // proposed PlanModeStore.persistApprovalRequest
  // - Lock-scoped, fresh-read transaction (no caller-provided snapshot allowed)
  // - All-or-nothing bundle write (compile-time enforced via a single Patch literal)
  // - Idempotency built in (compiler can't forget the 4-condition guard)
  // - Audit emission tied to the transition path (compile-time impossible to skip on rotate; compile-time impossible to fire on reuse)
  type PersistApprovalResult =
    | { kind: "persisted"; approvalId: string }     // rotate path — wrote bundle, emitted audit
    | { kind: "reused"; approvalId: string }        // idempotency hit — no write, no audit
    | { kind: "skipped"; reason: "not_in_plan_mode" } // precondition guard — no write
    | { kind: "failed"; cause: Error };             // IO error — disk untouched (caller branch)

  interface PlanModeStore {
    persistApprovalRequest(input: {
      sessionKey: string;
      candidateApprovalId: string;          // mutator may return a DIFFERENT one (reuse)
      planSnapshot: {                       // required, not optional — forces caller to supply
        title?: string;
        payloadHash?: string;               // ALL FOUR idempotency-guard conditions live or die on this
        lastPlanSteps: ReadonlyArray<{ step: string; status: PlanStepStatus; activeForm?: string }>;
      };
    }): Promise<PersistApprovalResult>;
  }
  ```
  Key points the signature enforces at compile time:
  - Caller MUST supply `lastPlanSteps` (no longer optional — closes the race).
  - Caller CANNOT supply a pre-built `planMode` patch (enforces the bundle is internal).
  - Result discriminator forces caller to branch on `reused` vs `persisted` (was a `boolean` flag — easy to miss).
  - `failed` is a first-class variant — caller cannot accidentally treat IO failure as "persisted but maybe-stale".
  - Audit emission is the mutator's job, not the caller's — impossible to forget on rotate, impossible to over-fire on reuse.
