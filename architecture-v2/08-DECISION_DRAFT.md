# Step 4 — Decision (DRAFT, awaiting Eva sign-off)

**Status**: DRAFT — 2 BLOCKERs + ~4 open decisions need Eva input before this becomes the locked plan.

**Methodology**: `first-principles-architectural-decision` skill, full Steps 1 → 4 walked. Wave 1 (4 agents) + Wave 2 (3 agents) produced 7 durable artifacts in this directory.

**Confidence as of this draft**: ~72% on Option C as originally written. **NOT at the 95% bar.** This document lays out what's needed to get there.

---

## Context

Port the in-host plan-mode feature set at `/Users/lume/repos/openclaw-pr70071-rebase` (branch `rebase/pr70071-onto-main-2026-04-25`, tip `ea04ea52c7`, 2026-05-02) to a downloadable OpenClaw plugin at `github.com/electricsheephq/Smarter-Claw`. Distributable via ClawHub + direct install. The plugin SDK seams that were missing during the prior failed attempt have now landed in upstream/main; per Agent B research, every one of the 12 in-host features maps to at least one mature seam.

The mission constraint Eva set: 100% feature parity with the in-host implementation, ZERO repeats of the prior failure (where work was reinvented rather than ported).

---

## What Wave 1+2 established

| Artifact | Finding | Confidence |
|---|---|---|
| `01-PARITY_CATALOG.md` | 12 features, ~85 plan-mode-relevant files, ~875 tests, 39 hook integration points. Source-of-truth is concrete. | HIGH |
| `02-ARCHITECTURE_OPTIONS.md` | 3 options scored. Option C (Hybrid: single namespace + decomposed surfaces) wins 26/30. | MEDIUM (counter-evidence below) |
| `03-BUILD_BASELINE.md` | 220/220 plan-mode tests pass on the source-of-truth. Branch is solid to port from. | HIGH |
| `04-LESSONS_LEARNED.md` | Prior failure modes: wrong abstraction (installer-patcher BECAME the system), manifest-vs-implementation drift, no reality feedback for 70+ commits. 10 testable guardrails. | HIGH |
| `05-ADVERSARIAL_AGAINST_C.md` | **2 BLOCKERs + 4 HIGH-severity gaps in Option C as originally written.** | HIGH (the findings are concrete) |
| `06-DIAGRAMS.md` | 6 ASCII diagrams + 4 "obvious-but-wrong" mapping gaps. | HIGH |
| `07-PR_LADDER.md` | 14-PR ladder, 4 Eva-live-smoke gates, foundation-block revertable. Will need revision after BLOCKER resolution. | MEDIUM (assumes Option C ships as-written) |

---

## Options considered

- **Option A (Monolithic)**: single namespace + single entry file. Score 21/30. Fastest to first-flight if scope shrinks to <5 features. Worse at maintainability past PR-16.
- **Option B (Feature-decomposed)**: one namespace per feature. Score 20/30. Most modular but state coherence is weakest — easy to leave the race-fix invariant un-protected.
- **Option C (Hybrid)**: single namespace owned by `PlanModeStore`, decomposed feature surfaces. Score 26/30. Best at making the race-fix invariant structurally enforceable. **Selected as the basis, with amendments below.**

---

## Decision (proposed, pending sign-off)

**Option C with two amendments.** The amendments are not optional — they resolve the two BLOCKERs that adversarial review surfaced. Without them, Option C re-introduces the bug class the in-host code was specifically fixed against.

### Amendment 1 — Typed mutator API (resolves BLOCKER 1)

Replace `store.lockedUpdate(updater: (state) => state)` with a typed-mutator class encoding the four co-located invariants from `pi-embedded-subscribe.handlers.tools.ts:130-237`:

```typescript
class PlanModeStore {
  // Race-fix invariant: writes approvalId + lastPlanSteps + title +
  // payloadHash atomically; emits audit event; idempotent on payloadHash.
  async persistApprovalRequest(input: {
    approvalId: string;
    lastPlanSteps: string;
    title: string;
    payloadHash: string;
    mode: PlanMode;
  }): Promise<{ status: "wrote" | "idempotent-reuse" | "skipped-not-plan-mode"; effectiveApprovalId: string }>;

  // Mode-precondition guard (in-host invariant b)
  private requirePlanMode(state): boolean;

  // Payload-hash idempotency (in-host invariant c) — prevents the
  // Telegram /plan-accept duplicate-fire orphan-card regression
  private reuseApprovalIdIfHashMatches(state, payloadHash): string | null;

  // Audit emission (in-host invariant d)
  private emitApprovalTransition(prev, next): void;
}
```

This makes the four invariants impossible to skip from caller code. Any future contributor adding a new mutation point must extend the typed API, which is a code-review touchpoint.

**Risk traded off**: more boilerplate per mutator (~50 LOC). Acceptable.

### Amendment 2 — UI strategy decision (BLOCKER 2 — Eva input required)

`registerControlUiDescriptor` is a sidebar status-projection seam, NOT a chat-message-stream render seam. The in-host plan-mode UI is 4,237 LOC across 5 files deeply woven into `chat.ts` and `app.ts` (inline plan cards in the chat stream, revise-textarea state machine, ask_user_question "Other..." flow, mode-switcher chip).

Three paths forward; **Eva picks one**:

- **Path A**: Land the plan-mode UI in upstream/main as its own PR (separate from the plugin). Plugin owns backend; UI ships with host. **Pro**: matches in-host fidelity; UX unchanged. **Con**: anyone installing the plugin needs a host version that includes the UI — the "downloadable from anywhere" promise becomes "download from ClawHub AND have ≥v2026.X.Y host." This is a soft requirement; bundled plugins already have this constraint.

- **Path B**: Ship plugin with sidebar UI only (via `registerControlUiDescriptor`). Plan cards become a sidebar widget instead of inline chat cards. **Pro**: 100% within current SDK seams. ZERO UI-patching of the host. **Con**: degraded UX vs in-host; rejection-with-feedback flow loses inline integration; "ask_user_question Other..." input flow needs to move to sidebar.

- **Path C**: Propose a new SDK seam for chat-message-stream rendering (e.g., `registerChatStreamRenderer`), file upstream PR first, then build plan-mode UI on top. **Pro**: clean long-term answer; future plugins benefit. **Con**: delays plan-mode port by however long that upstream PR takes (probably 2-4 weeks for review/merge cycle).

**My read**: **Path A** is the best fidelity match for "100% parity" — but it splits the ship target (plugin + upstream PR). **Path B** is the cleanest plugin-only ship, accepting UX degradation. **Path C** is the cleanest long-term but introduces sequencing risk.

This is a product/UX trade-off Eva owns. The engineering work differs significantly across them.

### Plus 6 sub-amendments (HIGH severity, not BLOCKERs)

Resolved or accepted as known trade-offs:

| # | Finding | Resolution |
|---|---|---|
| H1 | SDK contract drift risk (Vector 1) | Pin to current SDK contract via integration tests; CI gate on `host-hooks.contract.test.ts` shape; bump openclaw peer dep on every SDK change |
| H2 | ~30-40% of host-internal tests not portable (Vector 5) | Port the ~70% that are pure logic (mutation-gate, escalating-retry, accept-edits-gate, types, exec allowlist). For the 30% host-internal (gateway integration, sessions internals), write plugin-equivalent integration tests against the new architecture, not 1:1 ports |
| H3 | workspace plugin gate priority race (Vector 6) | Accept the trade-off (no other plugin should be installing competing `before_tool_call` policies in a security-sensitive way). Document operator config requirement; add startup banner warning if a competing policy is detected; long-term consider getting "trusted" exemption like `@openclaw/codex` precedent |
| H4 | 6 features without explicit plugin location (Vector 7) | Add `state/`, `lifecycle/` subdirs to Option C's file layout. Map: `[PLAN_COMPLETE]` injection → `state/injection.ts`; C7 debug events → `state/debug-log.ts`; pre-flight + locked re-evaluation → inside `PlanModeStore.persistApprovalRequest`; `__testing*` seams → `state/testing.ts`; atomic FS writes → `lifecycle/persistence.ts`; cross-session plan-store → out of scope (defer to future PR) |
| H5 | Cron durability gap (from diagrams) | Plan-mode nudges (10/30/60min) → use `registerSessionSchedulerJob` (per Agent B's seam inventory). If kind="nudge" doesn't fit, file upstream issue to add it |
| H6 | `lastPlanSteps` materialization transfer (from diagrams) | Acknowledged; move status-enum normalization from host's `sessions-patch.ts:1135-1189` into `tools/exit-plan-mode.ts` carefully, port the existing tests verbatim |

---

## Counter-arguments considered

**Counter 1 (adversarial Vector 2)**: "Even with typed mutators, you'll still miss invariants. The in-host code has 7 years of accreted defensive checks that you can't see by reading once."

**Rebuttal**: The parity catalog (Artifact 01) is the explicit listing. Plus the test corpus (220/220 passing) IS the spec — port the tests, the assertions ARE the invariants. Plus Amendment 1's typed-mutator API surfaces gaps at compile-time, not runtime.

**Counter 2 (adversarial Vector 3)**: "The UI gap means you can't ship a 100%-parity plugin. Either accept worse UX or do the upstream UI PR. Either way the 'plugin' answer is incomplete."

**Rebuttal**: TRUE. This is exactly what Amendment 2's three-path decision acknowledges. The product decision is Eva's.

**Counter 3 (LESSONS_LEARNED.md guardrail #2)**: "Zero UI patches, zero schema-only config knobs. CI fails on either."

**Rebuttal**: This is the right guardrail. Path A puts UI in upstream/main where it's NOT a "patch" — it's a real upstream contribution. Path B puts UI in the sidebar where it's a legitimate use of the SDK seam. Neither violates the guardrail.

**Counter 4 (general)**: "The 14-PR ladder is too long. Eva will lose patience or context."

**Rebuttal**: 14 is roughly right for 12 features + 2 setup PRs. Each PR <600 LOC keeps reviewability. The 4 Eva-live-smoke gates (PR-5/8/13/14) ensure feedback every 3-4 PRs. The foundation block (PR-1..3) is revertable as a unit if early findings change the plan.

---

## Risks accepted

- The UI gap will degrade UX vs in-host unless Path A or C is taken. Path B = accepted UX degradation.
- ~30-40% of in-host tests don't port 1:1. We rewrite them as integration tests against the plugin architecture.
- Workspace plugin gate priority is not as strong as in-host (or bundled). Mitigated by operator-config documentation and startup-warning detection.
- 14 PRs over ~6-8 weeks elapsed time. This is realistic given test-gating + 4 Eva-live-smoke gates.

---

## Open questions deferred (or for Eva)

1. **Path A vs B vs C for UI** — Eva picks. Engineering work differs significantly.
2. **`registerSessionSchedulerJob` covers cron nudges** — to be verified during PR-2 (PlanModeStore + lifecycle). If not, upstream issue.
3. **Bundled vs workspace clarification** — Eva confirmed workspace plugin for distribution. Re-confirm understanding: this means `allowConversationAccess: true` is a documented operator-config step.
4. **Should the architecture-v2 branch eventually become `main` of Smarter-Claw**, or should it be merged in as a feature branch leaving the old code accessible at a tag?

---

## Reversibility

- **PR-1..3 (foundation)**: reverts cleanly. Returns repo to bare scaffolding.
- **PR-4 onward**: each PR is reverts-clean individually (each ships with its tests and no shared state with later PRs).
- **Architecture pivot risk**: if mid-port we discover Option C is structurally wrong (e.g., the SDK changes a contract), the foundation PRs can be reverted in <1 hour and a new architecture chosen. The parity catalog (Artifact 01) is architecture-agnostic — it stays valid no matter what architecture we pick.

---

## Next steps once Eva signs off

1. **Resolve Amendment 2 (UI strategy)** — Eva picks Path A / B / C.
2. **Revise `07-PR_LADDER.md`** to reflect Amendment 1's typed-mutator + Amendment 2's chosen path + the 6 sub-amendments. Likely shape: 14-16 PRs.
3. **Re-run adversarial pass** against the amended architecture; target ≥95% confidence verdict from a fresh agent.
4. **Tag the architecture-v2 branch tip** as `architecture-v2-locked` once Eva approves.
5. **Enter Claude plan-mode** with PR-1 (plugin skeleton + manifest) as the first concrete task. Submit for approval.

---

## Confidence trajectory

| Stage | Confidence | Gate |
|---|---|---|
| Wave 1 done | 60% (architecture options surveyed, not stress-tested) | — |
| Wave 2 done (this doc) | 72% (BLOCKERs identified but not yet resolved) | — |
| Eva chooses Amendment 2 path | 85% (architecture is concrete) | Eva approval |
| Re-adversarial against amended doc | 95% (target) | Fresh adversarial agent verdict |
| PR-1 lands + foundation tests pass | 97% (architecture is verified at code level) | Live CI |
| Eva live-smoke #1 (PR-5) | 99% (real-world plan-mode flow works) | Eva runs the plugin |

We are at **72%** as of this draft. The path to 95% runs through **Eva's decision on Amendment 2** plus **one more adversarial pass against the amended doc**.

---

## Files referenced

- Source-of-truth: `/Users/lume/repos/openclaw-pr70071-rebase` (branch `rebase/pr70071-onto-main-2026-04-25`, tip `ea04ea52c7`)
- SDK seams: `/Users/lume/repos/openclaw-1/src/plugins/contracts/host-hook-fixture.ts`, `host-hooks.contract.test.ts`, `docs/plugins/hooks.md`
- Plan-mode UI in-host: `/Users/lume/repos/openclaw-pr70071-rebase/ui/src/ui/views/chat.ts:1652`, `ui/src/ui/app.ts:1733`
- Race fix anchor: `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237` (commit `1081067476`)
- Telegram /plan-accept idempotency: same file, lines 137-145 (explicitly documented comment)
- Prior attempt: `/Users/lume/repos/Smarter-Claw/` on `main` branch (the abandoned installer-patch approach)

---

**Awaiting Eva**: Amendment 2 path selection + any pushback on the typed-mutator amendment.
