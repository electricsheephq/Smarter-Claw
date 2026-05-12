# S9 — Plan-Mode UI Surfaces — Wave-1 Audit (read-only)

**Slice**: S9 — Plan-mode UI surfaces (sidebar variant; inline UI deferred to P-final)
**Auditor**: Wave-1 agent A9 (first-principles testing-gap analysis)
**Method**: Read-only walkthrough of in-host UI files vs. plugin port and tests
**Date**: 2026-05-12

---

## 1. Slice summary

The in-host (`v2026.4.24 + 172 commits` rebase) ships FOUR plan-mode UI placements distributed across the chat view. The Smarter-Claw plugin ports only the **sidebar variant** (Phase A); the three inline placements (mode-switcher chip, plan-event cards in message stream, inline approval card above the input bar) require an upstream SDK seam (`registerChatStreamRenderer`, draft `openclaw/openclaw#80982`) and are explicitly deferred to **P-final**.

What ships in v0.x:

- **Sidebar UI descriptor** (`buildPlanModeSidebarDescriptor`) — declares a `session`-surface widget. Rendering is host-side; plugin owns DATA (via `pluginExtensions["smarter-claw"]["plan-mode"]` projection) and ACTIONS (the six `plan.*` session-actions).
- **6 session actions** dispatched by UI clients via `(pluginId, actionId)`: `plan.accept`, `plan.edit`, `plan.reject`, `plan.cancel`, `plan.answer`, `plan.auto.toggle`. Each verifies an optional `expectedApprovalId` for stale-event protection and either calls a `PlanModeStore` mutator or enqueues an injection (or both).
- **`plan-clear` CLI sweep** — operator rollback drain (`openclaw plan-clear -s <sessionKey>`) for sessions stuck in plan mode.

Source-of-truth files reviewed:

- In-host UI: `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/ui/src/ui/chat/{plan-cards,mode-switcher,plan-resume}.ts`, `ui/src/ui/views/{plan-approval-inline,chat}.ts`
- Plugin ports: `/Users/lume/repos/Smarter-Claw/src/ui/{sidebar-descriptor,session-actions,sweep-command}.ts`
- Plugin tests: `/Users/lume/repos/Smarter-Claw/tests/ui/{sidebar-descriptor,session-actions,sweep-command}.test.ts` (7 + 25 + 9 = 41 cases)
- Patched SDK overlay: `/Users/lume/repos/Smarter-Claw/patches/openclaw-2026.5.10-beta.5/{loader-DdN5GTsW.js,protocol-BBwaRnfZ.js,manifest.json}`

Confirmed reading the patched loader: the seam **is opt-in** (validation only fires when `descriptor.activeWhen !== void 0`, and chat-stream surfaces only reject the descriptor when `surface ∈ chatStreamSurfaces`). The plugin's sidebar descriptor uses `surface: "session"` and does NOT set `activeWhen` — so the v0.x sidebar code path is **not exercising** any chat-stream surface accidentally. The patch is a no-op for the sidebar variant.

---

## 2. The 4 in-host UI placements

| # | Placement | In-host file | Description | Plugin parity |
|---|---|---|---|---|
| **A** | **Plan-event cards in message stream** | `ui/src/ui/chat/plan-cards.ts` (renders `<details>` w/ step checklist) | Informational expandable cards rendered as plan events flow through the chat stream (status markers ⬚/⏳/✅/❌, completion meta string `N/M done`, `formatPlanAsMarkdown` for sidebar export). | **MISSING** (deferred to P-final — needs `chat-message` chat-stream surface). |
| **B** | **Inline plan-approval card above input bar** | `ui/src/ui/views/plan-approval-inline.ts` (`renderInlinePlanApproval`); mounted at `chat.ts:1395` | "Claude proposed a plan" affordance: title strip + (Accept / Accept-with-edits / Revise) buttons + "Open plan" sidebar link; revise opens inline textarea; PR-10 alternate `renderInlineQuestion` variant when `request.question` present (option buttons + optional "Other…" textarea). Input bar is hidden by caller (`chat.ts:1462-1465`) when `planApprovalRequest` is active. | **MISSING** (deferred to P-final — needs `chat-input-bar` chat-stream surface). |
| **C** | **Mode-switcher chip in input toolbar** | `ui/src/ui/chat/mode-switcher.ts` (`renderModeSwitcher`); mounted at `chat.ts:1513` | Pill/chip showing current mode + dropdown menu w/ 6 entries: Default / Ask / Accept / Plan / Plan-auto / Bypass. Ctrl+1..6 shortcut handler (`handleModeShortcut`) with deep Shadow-DOM focus guard. `resolveCurrentMode` derives mode from session state — plan-mode WINS over execSecurity/execAsk, and `planAutoApprove === true` upgrades to the "plan-auto" entry. Synthetic "Custom" entry when no preset matches. | **MISSING** (deferred to P-final — needs `chat-header-chip` or `chat-input-bar` chat-stream surface). |
| **D** | **Sidebar slot (full plan content, markdown-formatted)** | `ui/src/ui/chat/plan-cards.ts:formatPlanAsMarkdown` + sidebar host code | Full plan rendered with title, italic explanation, and a markdown checklist (`- [x]` / `- [ ] ~~cancelled~~` / `- [ ] **in-progress**` / `- [ ]`). Triggered from the "Open plan" link in the inline card. | **PARTIAL** — plugin declares a `surface: "session"` descriptor with a schema for the data; the host renders the widget. No `formatPlanAsMarkdown` analog is shipped by the plugin (host renders from the schema). |

**Companion in-host helper**: `ui/src/ui/chat/plan-resume.ts:resumePendingPlanInteraction` — fires a hidden `chat.send` with `deliver: false` and a `plan-resume-<uuid>` idempotencyKey after the approval/answer is persisted so the next agent turn runs. **No plugin analog** — the SDK's `enqueueNextTurnInjection` returns and the plugin trusts the host's drain loop to continue. **GAP (P0)**: see §5.

---

## 3. The 6 session actions — input contract + error paths matrix

### Action contracts

| Action ID | Required payload | Optional payload | Calls (state) | Calls (injection) | `continueAgent` |
|---|---|---|---|---|---|
| `plan.accept` | (none) | `approvalId` (stale-check) | `store.recordApproval({ edited: false })` | `enqueuePlanApprovedInjection({ edited: false })` | `true` |
| `plan.edit` | (none) | `approvalId`, `body` (edited plan text) | `store.recordApproval({ edited: true })` | `enqueuePlanApprovedInjection({ edited: true, bodyText? })` | `true` |
| `plan.reject` | (none) | `approvalId`, `feedback` | `store.recordRejection({ feedback? })` | `enqueuePlanDecisionInjection({ decision: "rejected", feedback?, rejectionCount })` | `true` |
| `plan.cancel` | (none) | (none) | `store.exitPlanMode()` | (none — terminal) | `false` |
| `plan.answer` | `questionId`, `questionPrompt`, `selectedOption` (all non-empty strings) | (none) | (no state mutator) | `enqueueQuestionAnswerInjection` | `true` |
| `plan.auto.toggle` | `enabled: boolean` | (none) | `store.setAutoApprove({ enabled })` | (none) | (unset — `result.enabled, result.kind`) |

### Error-path matrix

| Error code | accept | edit | reject | cancel | answer | auto.toggle |
|---|---|---|---|---|---|---|
| `MISSING_SESSION_KEY` | ✅ guarded | ✅ guarded | ✅ guarded | ✅ guarded | ✅ guarded | ✅ guarded |
| `INVALID_PAYLOAD` (non-object) | ✅ guarded | ✅ guarded | ✅ guarded | n/a (payload unused) | ✅ guarded | ✅ guarded |
| `INVALID_PAYLOAD` (required field) | n/a | n/a | n/a | n/a | ✅ (q-id/prompt/option) | ✅ (enabled boolean) |
| `STALE_APPROVAL_ID` | ✅ via `checkApprovalId` | ✅ via `checkApprovalId` | ✅ via `checkApprovalId` | **MISSING** (no expectedApprovalId guard) | **MISSING** (no expectedApprovalId guard) | n/a (not approval-cycle bound) |
| `NOT_IN_PLAN_MODE` | ✅ | ✅ | ✅ | (idempotent kind: "noop") | **MISSING** (no plan-mode check) | (lazy-init — creates empty payload) |
| `NO_PENDING_APPROVAL` | ✅ via `checkApprovalId` + skipped-result | ✅ via `checkApprovalId` + skipped-result | ✅ via `checkApprovalId` + skipped-result | n/a | **MISSING** (no pending-approval check; will fire injection for stale question) | n/a |
| `STORE_ERROR` | ✅ failure path | ✅ failure path | ✅ failure path | ✅ failure path | n/a (no store call) | ✅ failure path |

**Note**: every action receives a `Promise<PluginSessionActionResult>`; the success shape carries `{ ok: true, result: { … }, continueAgent? }` and error returns `{ ok: false, error, code }`.

---

## 4. Test coverage matrix

41 cases across 3 files. Below mapped to action × error code (cell = ✅ tested / ❌ not tested / n/a).

| Test target | Cases | Coverage notes |
|---|---:|---|
| sidebar-descriptor — id + surface + label + description + schema keys + mode enum + approval enum | 7 | All 7 schema property keys checked. Required-array shape verified. |
| session-actions — registration shape (ids + descriptions) | 2 | ✅ |
| `plan.accept` happy path + 4 errors | 7 | `MISSING_SESSION_KEY`, `STALE_APPROVAL_ID`, `NOT_IN_PLAN_MODE`, `NO_PENDING_APPROVAL`, idempotency-key shape, no-stale-id happy, matching-id happy |
| `plan.edit` w/ body + without body | 2 | ✅ both paths |
| `plan.reject` 4 cases + stale + no feedback | 5 | rejection→count=1, feedback in injection, deescalation hint at count=3, STALE_APPROVAL_ID, no-feedback |
| `plan.cancel` happy + idempotent + missing-key | 3 | ✅ |
| `plan.answer` happy + invalid-payload | 2 | ✅ |
| `plan.auto.toggle` happy + invalid-payload | 2 | ✅ |
| payload type-guards (non-object, undefined) | 2 | ✅ |
| sweep — registration shape + 6 behavior cases | 9 | empty session, no payload, normal-mode no-op, dry-run, success, IO failure, whitespace trim |

### Per-action coverage gaps

| Action | What's tested | What's NOT tested |
|---|---|---|
| `plan.accept` | happy, stale, missing-key, not-plan-mode, no-pending, idempotency-key, matching-id | **STORE_ERROR** code path, **INVALID_PAYLOAD** (non-object via accept, even though general payload-guard test exists), double-accept idempotency (two concurrent calls), accept while approval is "approved"/"edited"/"rejected" (terminal-state guards beyond just "pending") |
| `plan.edit` | edited-with-body, edited-without-body | **STALE_APPROVAL_ID**, **MISSING_SESSION_KEY**, **NOT_IN_PLAN_MODE**, **NO_PENDING_APPROVAL**, **INVALID_PAYLOAD** (non-object, non-string body), **STORE_ERROR**, very-long body text, body containing control characters / injection-attack vectors |
| `plan.reject` | happy, stale, no-feedback, count-increment, count-3 deescalation, idempotency-key, metadata | **MISSING_SESSION_KEY**, **NOT_IN_PLAN_MODE**, **NO_PENDING_APPROVAL**, **INVALID_PAYLOAD** (non-object, feedback non-string), **STORE_ERROR**, double-reject race (two consecutive rejects on same approvalId — second should NO_PENDING_APPROVAL since first cleared approvalId), feedback at length boundaries (empty trim, very long, multi-byte UTF-8), feedback shape that contains `[PLAN_DECISION]:` envelope-closer (sanitization is in store but not asserted at session-action boundary) |
| `plan.cancel` | happy, idempotent (normal-mode noop), missing-key | **STORE_ERROR** (exitPlanMode IO failure), cancel-while-pending (terminal-state for the approvalId is implicit — does NO_PENDING_APPROVAL or skipped affect the result shape?), `continueAgent: false` actually-asserted (the test reads it but doesn't assert the agent does NOT run), cancel right after accept (race between cancel + the implicit auto-continue from accept) |
| `plan.answer` | happy, invalid-payload (missing required fields) | **MISSING_SESSION_KEY**, all 5 cases on the answer ID format (UUID? freeform?), **questionId mismatch with pending question** — there is NO state check that the question is currently pending; an answer can fire its injection for a stale or non-existent question, double-answer race on the same questionId (the idempotencyKey would dedup at host but the plugin emits both), selectedOption that doesn't match any of the agent's options (free-text "Other…" not validated against the option list), control characters in questionPrompt/selectedOption (sanitization not applied), questionPrompt that closes the `[QUESTION_ANSWER]:` envelope |
| `plan.auto.toggle` | happy (true), invalid-payload (string instead of boolean) | **MISSING_SESSION_KEY**, **STORE_ERROR**, toggle false (only true is tested), idempotent re-toggle (already-true → already-true returns `kind: "noop"` per store — test doesn't read kind), lazy-init when no current payload (store creates one in normal mode — not tested via the session-action path), toggle while approval is pending (does it affect the in-flight cycle?), toggle while approval is approved/edited (PR-13 layer-2 gate reads autoApprove — does mid-flight toggle apply to the next bash call?) |

### Sweep CLI coverage gaps

What's tested: registration shape, empty session, no payload, normal-mode noop, --dry-run write-count=0, success path, IO failure, whitespace trim. Plus one case "description mentions plan.mode".

What's NOT tested: see §7.

---

## 5. Testing gaps (P0 / P1 / P2)

### P0 (correctness or schema-mismatch that ships broken behavior)

**G-P0-1**: **`plan.answer` has no state check.** Per source review, `plan.answer` does NOT call `readSnapshot` or check that there's a pending question. An old questionId can still fire its `[QUESTION_ANSWER]:` injection regardless of session state. In-host's flow ties answers to the same approval-card render path (which is mode-aware); plugin port skips this. **No test asserts** answer-without-pending-question fails or short-circuits. The host-side idempotency-key dedup masks the issue for double-answers within a session-lifetime, but a brand-new question can be answered against a session that has already moved on. (`src/ui/session-actions.ts:389-422` — no `checkApprovalId` analog).

**G-P0-2**: **`plan.cancel` has no terminal-state idempotency at the SESSION-ACTION layer.** The store layer is idempotent (returns `kind: "noop"`), but the action returns `ok: true` with `continueAgent: false` regardless. No test asserts that cancel followed by accept (race) cannot accidentally re-enter plan mode. The audit emitter may still fire the approval branch even after cancel committed (depending on emit-ordering with the gateway lock).

**G-P0-3**: **No plan.cancel `STORE_ERROR` test.** Sweep CLI tests an IO failure path; session-action layer doesn't. Per the source `cancelAction` does return `STORE_ERROR` when `store.exitPlanMode` returns `{ kind: "failed" }` (`src/ui/session-actions.ts:368-374`), but the test suite never asserts this branch. Coverage holes mean a future refactor could silently delete this guard. Severity P0 because store-error swallowing would be invisible to UI clients.

**G-P0-4**: **Sidebar descriptor `pluginId` field is REQUIRED by the SDK schema but NOT set by `buildPlanModeSidebarDescriptor`.** Per `patches/.../protocol-BBwaRnfZ.js:2197-2217`, `PluginControlUiDescriptorSchema` requires `pluginId: NonEmptyString`. The plugin's `buildPlanModeSidebarDescriptor` returns `{ id, surface, label, description, schema, requiredScopes }` only — no `pluginId`. The host's `registerControlUiDescriptor` may auto-inject the calling plugin's id (`record.id` in `loader-DdN5GTsW.js:3258`), but **no test asserts the registration succeeds against the wire schema** — only that the local object has the expected static shape. If the host-side auto-injection isn't applied at register-time (e.g. for a different SDK build), the descriptor would silently be rejected as `additionalProperties: false` violation. **Add a contract test**: assert the registration path (or run the descriptor through the `PluginControlUiDescriptorSchema` shape).

**G-P0-5**: **No "ARCHITECTURAL CONTRADICTION" check on `plan.edit` body**. The PR-10 protocol carries `body: <text>` from the user's inline edit. The session-action accepts ANY non-empty string. The downstream `enqueuePlanApprovedInjection` writes it verbatim into `${opener}\n${bodyText}`. **Sanitization is NOT applied** to the body before injection (`src/runtime/injection-writer.ts:124`). A body containing `[PLAN_DECISION]:` could close the envelope and inject adversarial decision payloads on the next turn. Tests assert the success-shape but never assert sanitization. The `sanitizeFeedbackForInjection` helper exists per `types.ts:131` for `feedback` (rejection); same protection is needed for edit `body` and `selectedOption`/`questionPrompt` on `plan.answer`.

### P1 (regression-prone or operator-visible gap)

**G-P1-1**: **Sidebar schema does NOT cover all `PlanModeSessionState` fields.** The descriptor's schema declares: `mode, approval, rejectionCount, approvalId, title, feedback, lastPlanSteps, autoApprove, __schemaVersion`. Per `src/types.ts:109-213`, the actual `PlanModeSessionState` also has: `enteredAt`, `confirmedAt`, `updatedAt`, `lastPlanPayloadHash`, `approvalRunId`. None of those 5 are declared in the descriptor schema. Tests assert the 9 declared fields exist via `expect.arrayContaining(...)` (so missing fields don't fail the test). UI clients can't statically know whether `enteredAt` ms is available for "you've been planning for N minutes" display, `confirmedAt` for grant timing, or `approvalRunId` for subagent-correlation display. **Add tests** that explicitly assert ALL `PlanModeSessionState` fields are in the schema, or a negative test that documented-omitted fields are intentional.

**G-P1-2**: **`requiredScopes` is an empty array** (`src/ui/sidebar-descriptor.ts:98-102`). Plugin code comments say "basic operator access is enough" but `isOperatorScope` from the patched loader (`loader-DdN5GTsW.js:32`) suggests the validation rejects unknown scopes. **No test asserts** what scopes the plugin SHOULD require vs. the empty-array default. Mutation-privileged operators (write access to session state) and read-only operators (sidebar view) would both pass the gate today. Decide explicitly: does the sidebar render to read-only operators? Document + test.

**G-P1-3**: **Sweep CLI does not enforce input-format constraints on `--session`.** Trim is tested (whitespace), but: empty after trim (no test — would the message say "required" or "no plan-mode payload"?), session key with shell-injection chars, non-ASCII (multi-byte unicode), session key of pathological length (>1024 chars). Per `src/ui/sweep-command.ts:120`, the only validation is `String(...).trim()` then `if (!sessionKey)`. The `store.readSnapshot` would receive the (possibly garbage) key as-is.

**G-P1-4**: **No double-fire test for session actions under the host-side dedup lens.** Each handler builds an idempotencyKey (`session-actions` injects via `injection-writer` which builds `smarter-claw:plan_decision:<approvalId>:<decision>`). When a user double-clicks Accept on a slow link, the host dedups at the injection layer — but the STATE write happens via `store.recordApproval` first. The second `recordApproval` would see `approval === "approved"` and return `{ kind: "skipped", reason: "no-pending-approval" }`. The session-action then surfaces `NO_PENDING_APPROVAL` to the UI — which is **the wrong code for a double-click race** (the user did succeed; the second click is a duplicate). Test: two-concurrent-acceptHandlers on the same payload should EITHER (a) both succeed (one as no-op), OR (b) the second returns a distinct `DUPLICATE_RESOLUTION` code. Currently the second returns `NO_PENDING_APPROVAL` which UI clients can't distinguish from "your approval card is stale, refresh".

**G-P1-5**: **No "accept while reject is mid-flight" race test.** `recordApproval` and `recordRejection` both acquire the same per-sessionKey lock so they serialize. If reject lands first, accept second, accept sees `approval !== "pending"` and returns `NO_PENDING_APPROVAL`. Good behavior, but **untested**. If a future store impl drops the lock invariant, the parallel paths would race silently.

**G-P1-6**: **`plan.auto.toggle` lacks `NOT_IN_PLAN_MODE` guarding (intentionally lazy-init)**. Per source `src/state/store.ts:641-657`, `setAutoApprove` will lazy-create a `{ mode: "normal", approval: "none" }` payload with `autoApprove` set. The session-action layer never verifies whether the operator intended to set auto-approve on a session that has no plan-mode history. This is by design (operator pre-arming), but no test asserts the lazy-init path through the session-action handler (only direct store tests). The state-extension namespace is reserved before any tool fires; if the lazy-init writes a row that's never read by enterPlanMode, the autoApprove flag silently survives a session reset.

**G-P1-7**: **No test for `auto.toggle: false` (disable).** The single test case `enabled: true`. The disable path (`enabled: false`) was tested at the store level (`tests/state/store.test.ts`) but the session-action handler is a separate dispatcher. Could regress on a refactor that changes how `readBooleanField` distinguishes `false` from `undefined`.

**G-P1-8**: **Question-answer `selectedOption` is unvalidated.** Per `plan.answer` handler (`src/ui/session-actions.ts:400`), `selectedOption` is just "any non-empty trimmed string". The in-host UI presents N option buttons + an optional "Other…" textarea. The plugin port has no way to validate the answer against the agent's offered options — a malicious or buggy UI client could submit anything. The agent reads `[QUESTION_ANSWER]: "<selectedOption>"` next turn; if the option doesn't exist, the agent will hallucinate context. **Mitigation**: include the option list on the persisted state (or carry it via approvalId metadata) so the handler can verify. Currently this isn't even tracked. **Spec gap**, not just a test gap.

**G-P1-9**: **`continueAgent` is unset on `plan.auto.toggle`.** Per `src/ui/session-actions.ts:458-461`, the success result has no `continueAgent` field. The SDK contract treats `undefined` as "don't auto-continue". This is probably correct (toggling auto-approve shouldn't kick the agent), but the test doesn't assert it. A future change that adds `continueAgent: true` would silently fire an unwanted turn. **Add an explicit "auto.toggle does NOT continue agent" test.**

### P2 (nice-to-have, low risk)

**G-P2-1**: **Sidebar descriptor label is hard-coded.** Tests assert `expect(d.label).toBe("Plan Mode")`. No i18n test. v0.x acceptable. P2.

**G-P2-2**: **Sidebar `placement` field is omitted.** Per the descriptor (`src/ui/sidebar-descriptor.ts:61`) the comment says "No placement — let the host's Control UI decide". The patched protocol schema declares `placement: Type.Optional(Type.String())` (`protocol-BBwaRnfZ.js:2212`) — so omission is valid. But the loader's validation rejects when `placement === ""` (empty string). No test asserts that the plugin's descriptor passes the "non-empty if present" check. P2 because the plugin doesn't set it.

**G-P2-3**: **No test for descriptor uniqueness across plugin reloads.** The descriptor id `smarter-claw.plan-mode.sidebar` is registered every plugin register call. If the host doesn't dedup, a plugin reload could double-register and fire a diagnostic. Tests don't cover this path. P2 — host responsibility.

**G-P2-4**: **`SESSION_ACTION_ERROR_CODES` has 6 codes; tests reference 5.** The `STORE_ERROR` code is defined but only the sweep-command path tests it (in a hand-rolled "semi-broken gateway" setup). No session-action test triggers `STORE_ERROR`. P2 for coverage cleanliness.

**G-P2-5**: **Schema `__schemaVersion` declared as integer; the value is set via `stampSchemaVersion`.** No test asserts the descriptor's `__schemaVersion` constraint matches `CURRENT_SCHEMA_VERSION`. Drift risk if the store bumps version but the descriptor stale-mentions version 1.

**G-P2-6**: **No test for descriptor surface enum compatibility with the host.** The host accepts `surface ∈ { session, tool, run, settings, chat-message, chat-input-bar, chat-header-chip }` (per `controlUiSurfaces` set at `loader-DdN5GTsW.js:3065-3073`). The plugin uses `"session"` (correct). A test like `expect(controlUiSurfaces).toContain(d.surface)` (against a copy of the enum) would catch a typo regression.

**G-P2-7**: **Sweep CLI does not test combined `--session + --dry-run` with a session in approved/rejected state.** Only the "pending" plan-mode state is tested. `--dry-run` with `approval=rejected` would still report "would call exitPlanMode" but the write isn't actually needed (rejected isn't a plan-clear blocker per se). Edge cases that don't matter for behavior but matter for log clarity.

**G-P2-8**: **Sweep `--dry-run` exit code.** No test asserts process exit code. The action returns `void`; in commander world that maps to exit 0. If a future change makes dry-run report-only-on-stderr with exit 1, no test catches it. P2.

**G-P2-9**: **Sweep CLI doesn't handle `--session` containing the literal `"undefined"` or `"null"` strings.** Defensive — the `String(...)` cast would render `undefined` as `"undefined"` (a 9-char non-empty string), which then becomes a session key lookup that misses. Operators could see "no plan-mode payload" which is confusing. Test: a coerced undefined produces a clear error.

**G-P2-10**: **No test asserts the audit logger fires on the success path.** Source-of-truth audits do emit on the session-action path indirectly via the store mutators. The tests assert state changes but not the audit-emit invocations. P2 — the audit logger is a separate emission path (`src/index.ts:223-271`) covered by store tests, not session-action tests.

**G-P2-11**: **No test for the `enqueueNextTurnInjection` failure mode.** The stub in tests always returns `{ enqueued: true }`. If the host rejects (e.g. session does not exist, host is shutting down), the session-action returns success regardless because it doesn't read `enqueue.enqueued`. The `injectionId: enqueue.id` in `result` could be undefined. P2 risk because the failure path isn't reachable in tests.

**G-P2-12**: **`requiredScopes: []` empty-array vs. `undefined`.** Per the patched loader (`loader-DdN5GTsW.js:3253`), `normalizeHostHookStringList` handles both. No test asserts the plugin uses `[]` consistently (deliberate empty array vs. accidentally undefined). P2.

**G-P2-13**: **No "registerControlUiDescriptor errors" simulation.** The plugin doesn't surface a diagnostic when the host rejects its descriptor. Tests don't cover what happens if the registration fails (network error, host shutdown, etc.). The descriptor is registered at register-time in `src/index.ts:300-302` with no try/catch.

### Cross-action gaps

**G-P0-6**: **No test asserts that `plan.accept` followed by `plan.cancel` on a still-pending injection-drain produces sane state.** The accept commits state and enqueues injection. If the user clicks Cancel before the agent's next turn drains the injection, what happens? The cancel calls `exitPlanMode` which clears approval-related fields. The accepted injection is still in the queue — it will execute on the next turn against a normal-mode session. The `[PLAN_DECISION]: approved` injection should be safe (it's just context), but the test suite never reproduces this.

**G-P0-7**: **No test for the FOUR-way race**: accept + reject + cancel + auto.toggle fired in rapid succession from a buggy UI. The store-level lock serializes them, but the session-action contract returns the resulting code distinctly for each. Coverage gap: ensure each subsequent caller sees a clear `NO_PENDING_APPROVAL` or `NOT_IN_PLAN_MODE` code rather than silent success.

**G-P1-10**: **No test for stale `expectedApprovalId` against a session that's already approved.** Current "stale" test seeds pending state and feeds a mismatched id. The case where `current.approval === "approved"` (terminal state) is covered as `NO_PENDING_APPROVAL` — but the test scaffolds `approval: "rejected"`. The terminal states `approved`, `edited`, `timed_out` are not individually tested. (`session-actions.test.ts:172-181` only tests `rejected`.)

---

## 6. Inline UI deferral gap — what's minimally needed for parity once upstream merges

When `openclaw/openclaw#80982` (chat-stream Control UI surfaces) merges, the plugin needs the following plugin-side work to reach UX-parity with the in-host:

| In-host placement | Required plugin-side work (post-merge) |
|---|---|
| **Plan-event cards (chat-message surface)** | Register a SECOND `PluginControlUiDescriptor` with `surface: "chat-message"`, `activeWhen: { sessionExtensionNamespace: "plan-mode", valuePath: "lastPlanSteps" }`. Schema mirrors the plugin's `lastPlanSteps[]`. Host renders the `<details>`/`<summary>` card. **No new session-action.** Plan-resume hidden-send analog (`resumePendingPlanInteraction`) is HOST-side (host fires `chat.send` after the injection drains). |
| **Inline approval card (chat-input-bar surface)** | Register a THIRD descriptor with `surface: "chat-input-bar"`, `activeWhen: { sessionExtensionNamespace: "plan-mode", valuePath: "approval", equals: "pending" }`. The host's chat-stream renderer reads the descriptor + invokes the existing `plan.accept`/`plan.edit`/`plan.reject` session-actions on click. The plugin's existing session-action handlers ALREADY support inline-revise feedback via `feedback` payload field; no changes needed. **Add a `plan.revise.draft.*` set of session-actions** if the host wants per-keystroke draft persistence (current in-host has client-side `reviseDraft` state in `vs.*`; the plugin could ignore this if the host caches client-side). |
| **Mode-switcher chip (chat-header-chip surface)** | Register a FOURTH descriptor with `surface: "chat-header-chip"`. Action surface needs **two new session-actions**: `mode.set` (with payload `{ planMode: "plan" \| "normal", autoApprove?: boolean }`) — would call `store.setAutoApprove` + a new `store.setMode` mutator. And `mode.shortcut` for the Ctrl+1..6 keyboard binding (host fires it on key event; plugin handles dispatch). The in-host `MODE_DEFINITIONS` (6 entries: Default/Ask/Accept/Plan/Plan-auto/Bypass) couples permission-mode + plan-mode in a single dropdown; the plugin owns only the Plan + Plan-auto entries — the host already owns Ask/Accept/Bypass via `execSecurity`/`execAsk`. **GAP TO RESOLVE**: who owns the integrated dropdown? Likely: host renders the dropdown, plugin contributes the Plan + Plan-auto entries as additional "modes" via descriptor metadata. |
| **Sidebar "open plan" sidebar slot (already shipped)** | No additional work. The host's "Open plan" link in the inline card opens the existing sidebar widget. |

### Minimal post-merge plugin work (one PR)

1. Add 3 new descriptors (`chat-message`, `chat-input-bar`, `chat-header-chip` surfaces) with the right `activeWhen` filters
2. Add 1 new session-action: `mode.set` (and possibly `mode.shortcut`)
3. Add 1 new store mutator: `setMode` (modeled on existing `setAutoApprove`)
4. Update tests: 1 new descriptor-shape test per new surface; 1 new session-action contract test for `mode.set`
5. **Sanity test**: assert the new descriptors are REJECTED by the unpatched loader (no `chatStreamSurfaces` set), so the plugin can be installed against pre-PR-80982 builds without exploding

### What's NOT needed

- Custom rendering code — host owns rendering for all 4 surfaces
- Markdown formatter (`formatPlanAsMarkdown`) — host renders from `lastPlanSteps` schema directly
- Lit / web-component code — the plugin remains a pure schema + actions provider
- Keyboard-shortcut handler — host owns Ctrl+1..6 dispatch; the plugin only provides the action ids

### Confirming the seam is opt-in only

The patched loader's `chatStreamSurfaces` set (`loader-DdN5GTsW.js:3074-3078`) is checked ONLY when `descriptor.activeWhen !== void 0` (line 3299). The plugin's sidebar descriptor does NOT set `activeWhen`, so the v0.x sidebar path doesn't trigger the chat-stream code branch. **VERIFIED**: no plugin code accidentally registers a chat-stream-renderer descriptor; the seam is opt-in.

---

## 7. Sweep CLI gaps — error paths, idempotency

The sweep command (`openclaw plan-clear -s <sessionKey> [--dry-run]`) has 9 tests. Gaps:

| Gap | P-tier | Notes |
|---|---|---|
| `--session=""` (post-trim empty) | P1 | Whitespace-only trim test exists but doesn't assert the message **specifically** says "required". |
| `--session` with shell-metacharacters (`;`, `$`, etc.) | P2 | The CLI never executes a shell; passes through to `store.readSnapshot`. Untested but low impact. |
| `--session` with control characters (`\x00`, `\n`) | P2 | Per `String(...).trim()`, control chars survive trim. `readSnapshot` would lookup a key that probably doesn't exist. Untested. |
| `--session` containing the literal string `"undefined"` | P2 | Defensive — coerced undefined becomes a real string. Misleading "no plan-mode payload" log. |
| `--dry-run` on an `approval=approved` session | P2 | Tests only cover `approval=pending`. Approved is a transient state (gets cleared on `exitPlanMode`). Untested. |
| `--dry-run` on an `approval=rejected` session | P2 | Same as above. |
| `--dry-run` on an `approval=edited` session | P2 | Same. |
| `--dry-run` on an `approval=timed_out` session | P2 | Same. |
| `--dry-run` writeCount=0 assertion | P0 | **Already tested** (`gw.writeCount === 0`). ✅ |
| `--dry-run` then non-dry-run sequence | P1 | The two calls in sequence: dry-run reports, follow-up writes. Untested as a sequence. |
| Restart resilience (sweep after gateway restart) | P1 | Plugin uses `SessionStoreGateway` in production, which reads from disk. After a restart, snapshot reflects on-disk state. Untested at the CLI level — only the store-gateway tests cover this. |
| Mass sweep (`--all-sessions`) | n/a | Explicitly deferred per `src/ui/sweep-command.ts:13-19`. |
| Exit code on success vs. failure | P2 | No assertion. Operator scripts piping output might depend on it. |
| `--session` for a session that ONLY has `autoApprove: true` and no plan-mode history | P2 | The lazy-init path of `setAutoApprove` creates `{ mode: "normal", approval: "none", autoApprove: true }`. `plan-clear` would see `mode === "normal"` and report no-op. Behavior is probably correct (nothing to clear) but the operator may want to clear the auto-approve flag too. Untested + behavior-undefined. |
| Concurrent sweep + session-action plan.cancel | P1 | Two callers acquiring `withLock` for the same sessionKey. The second waits. Whichever lands first writes the "exit" transition; the second sees `kind: "noop"`. Untested as an integration. |
| Sweep on a session at a SCHEMA VERSION the plugin doesn't know how to read | P1 | Per `src/state/store.ts:720-725`, `readSnapshot` returns `undefined` and logs a warning when `version > CURRENT_SCHEMA_VERSION`. Sweep would log "no plan-mode payload" (incorrect — the payload exists, just unreadable). Plugin's "forward-compat" path is misleading at the CLI layer. |
| `--session` UUID format | P2 | All tests use `agent:main:main`. No test with a UUID-format session key. |
| `--session` containing slash characters | P2 | The default session-key format `agent:main:main` has colons. A path-like `proj/main/main` would parse and lookup — no test. |
| Logger contract test | P2 | The logger expects `info/warn/error`. If the host's logger ever changes to use `log()` or `trace()`, the sweep would break silently. Untested. |

---

## 8. Confidence score

| Surface | Confidence | Justification |
|---|---|---|
| Sidebar descriptor static shape | **95%** | All 7 schema property keys are explicitly tested. The MISSING `pluginId` field (G-P0-4) and 5 omitted state-fields (G-P1-1) are real gaps but caught at register-time only. |
| Session actions happy paths | **85%** | All 6 actions have at least one happy-path test. `plan.auto.toggle: false` (G-P1-7) and 5 of the 6 error codes-per-action are untested per the matrix. |
| Session actions error paths | **55%** | Only `plan.accept` has the full 5-code matrix (and only 4 are tested even there). The other 5 actions test 1-3 errors each. The cross-action race gaps (G-P0-6, G-P0-7) are NOT tested. |
| Sweep CLI | **75%** | 9 tests cover most happy + error paths. Missing: state-variety across the 6 `approval` values, restart resilience, concurrent paths. |
| Inline UI deferral discipline | **95%** | Confirmed via direct source-read that the plugin uses only `surface: "session"` and does NOT set `activeWhen`. The patcher's chat-stream seam is opt-in; the plugin doesn't accidentally trigger it. |
| Sanitization at session-action boundary | **30%** | The `feedback` field (`plan.reject`) goes through `sanitizeFeedbackForInjection` per the store/decision-injection layer. The `body` field (`plan.edit`) and `selectedOption`/`questionPrompt` (`plan.answer`) do NOT pass through sanitization in the session-action layer. **G-P0-5 is a real bug not just a test gap.** |
| Schema parity vs. PlanModeSessionState | **70%** | Schema covers 9 of the 14 `PlanModeSessionState` fields. The 5 omissions are documented above. |

**Overall S9 testing confidence**: **70%**

The sidebar variant is correctly scoped (declarative descriptor + 6 actions + a CLI), well-tested at the static-shape level, but under-tested at the error-path level and has 2 sanitization gaps (G-P0-5 and G-P1-8) that elevate to P0 because they widen the prompt-injection surface area. The inline UI deferral is correctly fenced (P2).

**Gap count**: 31 (4 P0 + 13 P1 + 14 P2; one additional cross-cutting in section 5's "Cross-action gaps" subsection).

**Recommended next actions**:
1. **G-P0-1** add state-check to `plan.answer` (must verify a question is pending; fail with a new `NO_PENDING_QUESTION` code on mismatch)
2. **G-P0-4** add a contract test for the sidebar descriptor registration roundtrip through the actual SDK schema validator
3. **G-P0-5** wire `sanitizeFeedbackForInjection` (or equivalent) into the `body` and `selectedOption`/`questionPrompt` paths
4. **G-P1-1** extend the descriptor schema to cover the 5 missing `PlanModeSessionState` fields (or document why they're omitted)
5. **G-P1-4** + **G-P1-5** add concurrency tests for double-click + parallel-action races
6. Add per-action negative-disclosure tests: each handler should be tested for `MISSING_SESSION_KEY` + `INVALID_PAYLOAD` (non-object) + `STORE_ERROR` (where store-bound)
