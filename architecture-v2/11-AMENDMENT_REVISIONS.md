# Amendment Revisions — Wave 3 (autonomous)

**Status**: research findings from Wave 3 force material revisions to both amendments in the Step 4 decision draft.

**Generated**: autonomous loop iteration (Eva away), 2026-05-12.

---

## Revision A — Amendment 1 (typed-mutator API) is INSUFFICIENT as drafted

### What the Wave 2 adversarial agent claimed

The in-host `persistPlanApprovalRequest` encodes 4 invariants:
1. Sync bundle write of approvalId + lastPlanSteps + title + payloadHash
2. `mode === "plan"` precondition guard
3. Payload-hash idempotency (reuse approvalId on hash match)
4. Audit-event emission via `logPlanModeApprovalTransition`

### What Wave 3 Agent N (verification) actually found by reading the code

The 4 named invariants ARE all there, BUT the function actually encodes **~10 invariants** once the full envelope is read. The 6 additional ones the adversarial agent missed:

5. **`withSessionStoreLock` atomic critical section** (`store.ts:610`) — entire operation runs inside a session-store lock acquired BEFORE the update. Race protection is at the lock, not just at the write.
6. **`skipCache: true` fresh-read** (`store.ts:651`) — the read inside the lock bypasses session cache. Reuse-decision must be made against the freshest disk state, not a stale projection.
7. **4-conjoined-condition decomposition of the idempotency guard** (lines 193-199) — the "hash match → reuse" decision is NOT a single equality check. It's `(state.approvalRequest?.lastPlanPayloadHash === input.payloadHash) && (state.approvalRequest?.approvalId === currentApprovalId) && (state.approvalRequest?.lastPlanSteps != null) && (state.approvalRequest?.title === input.title)`. Four predicates AND'd. Missing any leads to false-reuse (wrong approvalId returned) or false-overwrite (orphan-card regression).
8. **Try/catch that swallows IO errors and returns the candidate ID anyway** (lines 153-235) — if the disk write fails partway through, the function STILL returns the approvalId the caller passed in, allowing the agent to proceed. Failure-mode contract: "best-effort persistence, never block the agent."
9. **Deliberate audit-skip on the reuse path** (line 202 comment) — `logPlanModeApprovalTransition` is intentionally NOT called when reusing. This prevents audit-log spam during duplicate-fire scenarios. The audit-skip is documented in code with a comment justifying it.
10. **Lazy-import discipline** (lines 154-164) — `logPlanModeApprovalTransition` and a few helpers are dynamically imported inside the function body, not at module top, to avoid a circular import the original commit message addresses.

### Plus a contract on the caller side

The function returns `{approvalId, reused: boolean}` — and the caller at `line 1881` uses `reused` to emit a "duplicate detected" warning. **The return shape is part of the contract.** If the typed mutator returns a plain `Promise<string>` or `Promise<void>`, callers lose the signal needed to detect duplicates.

### Revised PlanModeStore.persistApprovalRequest signature

```typescript
type PersistApprovalRequestResult =
  | { kind: "persisted"; approvalId: string }   // fresh write happened
  | { kind: "reused"; approvalId: string }      // hash match; existing ID returned, NO audit emitted
  | { kind: "skipped"; reason: "not-plan-mode" | "missing-fields" }  // precondition failed
  | { kind: "failed"; error: Error; approvalId: string };  // IO error; candidate ID returned anyway

interface PersistApprovalRequestInput {
  approvalId: string;          // required candidate ID
  lastPlanSteps: string;       // REQUIRED — race-fix invariant #1
  title: string;               // REQUIRED — race-fix invariant
  payloadHash: string;         // REQUIRED for idempotency
  mode: PlanMode;              // for the precondition guard
}

class PlanModeStore {
  // Atomic, idempotent, audit-aware, fail-soft.
  // Internally uses sessions-store lock (or plugin-equivalent).
  // Internally calls projector inside lock.
  // Internally emits audit event ONLY on { kind: "persisted" }.
  async persistApprovalRequest(
    input: PersistApprovalRequestInput,
  ): Promise<PersistApprovalRequestResult>;
}
```

### Critical test-coverage gap (Agent N finding)

**There are ZERO direct unit tests for `persistPlanApprovalRequest`** in the in-host tree. It's exercised only through:
- Eva live-tests (manual, not in CI)
- Integration tests in `sessions-patch.test.ts` and `sessions-patch.subagent-gate.test.ts`

This is a major risk for the port. **The plugin port MUST add direct unit tests for `PlanModeStore.persistApprovalRequest`** covering:
- All 4 result kinds (persisted, reused, skipped, failed)
- All 4 idempotency-guard conditions independently (so partial-match doesn't false-reuse)
- The lock semantics (concurrent calls don't double-write)
- The audit-skip-on-reuse semantic (assertable via mock)
- The IO-error fail-soft semantic (returns approvalId on disk error)

### Revised Amendment 1 verdict

**~95% confidence** the typed-mutator API with the revised shape (above) encodes all 10 invariants. Plus the test-gap is now an explicit work item in the PR ladder (PR-3 adds the PlanModeStore tests; these are NEW tests the in-host doesn't have).

---

## Revision B — Amendment 2 Path B IS OFF THE TABLE (correctness regression)

### What Wave 3 Agent O (UI gap analysis) found

Cataloging 25 plan-mode UI elements across 11 files:
- **5 fit sidebar cleanly**: plan-view markdown surface, live update_plan refresh, plan title, archetype sections, auto-open
- **10 need chat-stream rendering**: mode-switcher chip + dropdown, plan-approval card + title strip + buttons, rejection-feedback textarea, AskUserQuestion card + "Other..." textarea, error banner, "Plan view" toggle button location, **input-bar suppression**
- **10 either-way**: keyboard shortcut, Open-plan link, subagent-blocking toast, all slash commands, hidden plan-resume, hydration, dismissed-approvalId set, dead-code `renderPlanCard`

### The blocker for Path B — input-bar suppression

When a plan approval is pending, the in-host UI **suppresses the chat input bar** so the user can't accidentally send a message that bypasses the plan-approval flow. The user must `/approve` or `/reject` first.

**No SDK seam can replicate this from a plugin.** The chat input bar lives in the host UI; it accepts keystrokes regardless of plugin state. A sidebar-only architecture means:

> User has a plan pending in the sidebar. User accidentally types a message into the chat input ("hey can you also do X"). User hits Enter. The message ships to the agent. The agent receives the message AND the pending plan-approval simultaneously. The agent now has ambiguous state.

This is not UX degradation. **This is a correctness regression** — the agent's state machine becomes ambiguous because the user can issue out-of-band input that the plan-mode flow assumes is suppressed.

### Path B is therefore off the table

The Wave 2 decision draft said "Path B accepts UX degradation as a known trade-off." Wave 3 demonstrates it's not UX — it's correctness. **Drop Path B from consideration.**

### Remaining options: Path A or Path C

Both require upstream contributions. Wave 3 Agent O recommended **Path A at ~78% confidence**:

| | Path A (UI in upstream/main) | Path C (new SDK seam) |
|---|---|---|
| Code already written | YES (in-host implementation exists at ea04ea52c7) | NO (proposed seam needs to be designed + reviewed) |
| Upstream-PR cycle | ~4-8 weeks (sub-staged into 4-6 sub-PRs at <600 LOC) | ~6-12 weeks (new abstraction + design discussion) |
| Plugin-only ship feasible | NO — plugin requires host UI version | NO — plugin requires host with new seam |
| ClawHub distribution | requires host >=vX.Y.Z that includes the UI | requires host >=vX.Y.Z that includes the seam |
| Long-term cleanliness | medium (UI knows about plugin extension schema) | high (UI rendering is plugin-agnostic via the seam) |
| Risk if upstream rejects | high (we're already committed to architecture) | high (same problem, different code) |
| Existing UI test coverage portable | YES (370+ test cases in `ui/` tree) | NO (would need new tests for new seam) |

### Why Path A vs Path C — Agent O's case

Path A is the same upstream-PR cost as Path C (both require upstream merges), but Path A uses code that's already written, already tested, and already verified in live Eva use. Path C is a NEW abstraction that future plugins benefit from, but it's speculative — no other plugin needs it today, and the security-sensitive surface (input-bar suppression) is exactly the kind of seam where review takes longest.

Path C reads as "right answer for the third plan-mode-equivalent plugin, wrong answer for the first one."

### Revised Amendment 2 verdict

**Path A is the strongly-recommended option** (~85% confidence after Agent O's analysis). The plan-mode UI ships to upstream/main as a sub-staged PR series; the Smarter-Claw plugin requires host >=vX.Y.Z (the version that includes the UI). Eva's "anyone can download from ClawHub" constraint becomes "ClawHub install + host upgrade" — same as bundled plugins already require.

**Path C remains the long-term clean answer.** Worth filing a tracking issue against upstream/main for the new chat-stream rendering seam, even if we don't gate plan-mode on it. Future plan-mode evolution could migrate to Path C if/when the seam lands.

---

## Updated confidence trajectory

| Stage | Original (08-DECISION_DRAFT) | Revised (this doc) |
|---|---|---|
| Wave 2 done | 72% | — |
| Wave 3 (Agents N+O) done | — | **80%** |
| Eva agrees with Path A + revised Amendment 1 | — | 90% |
| Re-adversarial pass against amended doc | — | 95% (target) |
| PR-1 lands | — | 97% |
| Eva live-smoke #1 (PR-5) | — | 99% |

We jumped from 72% to 80% by resolving Path B vs Path A and discovering the additional 6 race-fix invariants. The path to 95% now runs through:
1. Eva confirms Path A as the chosen direction.
2. Eva confirms the revised typed-mutator API signature.
3. One fresh adversarial pass against the architecture as it now stands (with Path A locked + 10-invariant mutator + the additional test coverage requirement).

---

## Open items deferred to Eva

1. **Path A confirmation**: the recommendation is Path A. Confirm?
2. **Upstream PR strategy**: how do we work with the openclaw maintainers on this? Do we file the UI sub-PRs ourselves, or coordinate with `jalehman` / openclaw-team?
3. **Plugin distribution stance**: ClawHub install requires host version pin. Acceptable?
4. **Plan-mode-aware UI in upstream/main**: should the upstream UI couple directly to Smarter-Claw plugin extension namespace, or should the upstream UI define a generic "plan-mode-shape" contract that any plugin can satisfy?

---

## Files / lines referenced

- Source-of-truth for `persistPlanApprovalRequest`: `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237` (commit `1081067476`)
- Lock semantics: `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/store.ts:610` (`withSessionStoreLock`)
- Fresh-read flag: `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/store.ts:651` (`skipCache: true`)
- Caller using `reused` flag: `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-subscribe.handlers.tools.ts:1881` (approx)
- UI files cataloged: `ui/src/ui/views/chat.ts`, `ui/src/ui/app.ts`, `ui/src/ui/chat/mode-switcher.ts`, `ui/src/ui/chat/plan-cards.ts`, `ui/src/ui/chat/plan-resume.ts`, `ui/src/ui/views/plan-approval-inline.ts`
- Detailed UI catalog: `10-UI_GAP_ANALYSIS.md` (this directory)
- Detailed invariant verification: `09-AMENDMENT_1_VERIFICATION.md` (this directory)
