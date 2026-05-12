# 05 — Adversarial Review Against Option C (Hybrid)

**Step 3 of `first-principles-architectural-decision`.** Goal: argue against
Option C at ≥95% confidence and surface every credible reason it will fail.
If Option C survives, ship. If a real flaw is found, fix it before code moves.

**Inputs read:** `01-PARITY_CATALOG.md`, `02-ARCHITECTURE_OPTIONS.md`,
`03-BUILD_BASELINE.md`, `04-LESSONS_LEARNED.md`,
`openclaw-pr70071-rebase/src/agents/pi-embedded-subscribe.handlers.tools.ts`,
`openclaw-main/src/plugins/contracts/host-hooks.contract.test.ts`,
`openclaw-1/docs/plugins/hooks.md`, in-host UI files
(`ui/src/ui/views/chat.ts:1652`, `ui/src/ui/app.ts:1733`,
`ui/src/ui/views/plan-approval-inline.ts:306`,
`ui/src/ui/chat/mode-switcher.ts:424`, `ui/src/ui/chat/plan-cards.ts:122`).

---

## Attack Vector 1: SDK contract drift — sync projector + JSON-bounded + cleanup

**Severity**: **HIGH**

**Evidence**:
- `host-hooks.contract.test.ts:786-808`:
  > `"rejects async session extension projectors because gateway rows are synchronous"` —
  test forces `project: (async () => ({state:"late"})) as unknown as () => undefined`
  and asserts the diagnostic `"session extension projector must be synchronous"`.
- `host-hooks.contract.test.ts:647-686`: `"validates plugin-owned JSON values as plain JSON-compatible data"`
  and `"rejects non-JSON descriptor schemas before projecting Control UI descriptors"` —
  asserts `"control UI descriptor schema must be JSON-compatible: bad-schema"`.
- `host-hooks.contract.test.ts:822-848`: `cleanup` callback is required to be a
  function; `"session extension cleanup must be a function"` and
  `"session extension projector must be a function"` are both enforced.
- `host-hooks.contract.test.ts:924-936`: defensively ignores promise-like
  projections — but the diagnostic is **silent at registration**; the projector
  returns garbage at request time.
- `02-ARCHITECTURE_OPTIONS.md:18-20`: Option C wraps writes through
  `store.lockedUpdate(updater)` ⇒ `updateSessionStoreEntry`, which IS async
  (the in-host helper is `await updateSessionStoreEntry(...)`), but the
  **projector** itself for `registerSessionExtension` must remain sync —
  the projector reads the persisted JSON; the writer (`lockedUpdate`) is the
  async path.

**Claim**: Option C's `02-ARCHITECTURE_OPTIONS.md` recommendation conflates the
two surfaces. The doc says (`02:14`) `"State seam: api.session.state.registerSessionExtension({ namespace, description, cleanup })"`
and (`02:264`) `"all writes go through store.lockedUpdate(updater) which wraps updateSessionStoreEntry"`.
That's correct in shape, but the doc **does not specify** that:
1. The projector function is a closed contract — synchronous, JSON-bounded.
2. JSON-incompatible state (Map, Set, Date, undefined, non-plain prototypes,
   Symbol-keyed fields) silently corrupts the session row.
3. The 5+ `cleanup` reasons (`reset | delete | disable | restart`) each need
   a code path. `04-LESSONS_LEARNED.md` doesn't enumerate plugin-port handling
   for `restart` vs `delete`; the prior plugin had **none of these** wired
   correctly (admitted in `LESSONS-B2`: *"`src/snapshot-persister.ts:169`
   — 'no-op shutdown handle'"*).

Subtle gap: `PlanModeStore.lockedUpdate` is documented but `cleanup` is not.
`pluginExtensions` cleanup semantics (per `hooks.md:340-346`) require that
on `reset/delete/disable` the host **removes** the namespace state AND drains
pending injections. The store would need a `cleanup(reason)` method —
currently absent in Option C's `PlanModeStore` sketch (`02:208`:
*"PlanModeStore: readState/writeState/lockedUpdate"* — no cleanup method).

**Best-case mitigation**: Add to `PlanModeStore`:
1. `cleanup(reason: 'reset'|'delete'|'disable'|'restart'): void` — restart
   keeps state (per `hooks.md:343`), delete/disable/reset clears in-mem cache
   AND any cron handles.
2. Compile-time guarantee that `PlanModeSessionState` is JSON-compatible
   (a contract test that `JSON.parse(JSON.stringify(state))` deep-equals
   `state` for every code-path-realizable shape).
3. Document explicitly that the projector is sync (closes over the synchronous
   `entry.pluginExtensions['plan-mode']` read).

**Worst-case escalation**: If SDK contract drifts (e.g., upstream adds a
new cleanup reason like `migrate`, or projector schema gains required
metadata fields), the silent-failure mode is exactly what
`LESSONS_LEARNED.A2` describes: vocabulary leakage with no enforcing test.
Restart-survival regression goes undetected for weeks because dev/restart
workflow keeps state — production users hit it once the gateway crashes.

---

## Attack Vector 2: The race-fix invariant claim is incomplete

**Severity**: **BLOCKER**

**Evidence** — read the in-host fix directly,
`pi-embedded-subscribe.handlers.tools.ts:130-237`:

```ts
async function persistPlanApprovalRequest(
  sessionKey, approvalId, log,
  planSnapshot?: { title?, payloadHash?, lastPlanSteps? },
): Promise<{ approvalId: string; reused: boolean }> {
  // ...
  await updateSessionStoreEntry({
    update: async (entry) => {
      const current = entry.planMode;
      // PRECONDITION #1: must already be in plan mode
      if (!current || current.mode !== "plan") return null;

      // PRECONDITION #2 (idempotency-by-payload-hash, lines 183-205):
      if (
        planSnapshot?.payloadHash &&
        current.lastPlanPayloadHash === planSnapshot.payloadHash &&
        current.approval === "pending" &&
        typeof current.approvalId === "string" &&
        current.approvalId.length > 0
      ) {
        resolvedApprovalId = current.approvalId;
        reused = true;
        return null;  // NO WRITE — preserves existing approvalId
      }

      const nextPlanMode = {
        ...current,
        approval: "pending",
        approvalId,            // freshly minted token
        updatedAt: now,
        ...(planSnapshot?.title ? { title } : {}),
        ...(planSnapshot?.payloadHash ? { lastPlanPayloadHash } : {}),
        ...(planSnapshot?.lastPlanSteps?.length > 0 ? { lastPlanSteps } : {}),
      };
      // SIDE EFFECT: emit approval_transition event for audit (line 224-229)
      logPlanModeApprovalTransition(sessionKey, current, nextPlanMode, /*site*/);
      return { planMode: nextPlanMode };
    },
  });
  return { approvalId: resolvedApprovalId, reused };
}
```

**Claim**: The in-host fix is FOUR co-located invariants, not one:

1. **Synchronous bundle write** — `approval + approvalId + lastPlanSteps + title + lastPlanPayloadHash` land in the same `updateSessionStoreEntry` callback. This is the part Option C captures.
2. **Mode-guard precondition** — if `current.mode !== "plan"`, **return null without write**. Option C's naive `lockedUpdate(s => ({...s, approval: 'pending', ...}))` would FORCE the write regardless of current mode, silently arming the gate from a normal-mode session if an agent fires `exit_plan_mode` outside of plan mode (defense-in-depth gone).
3. **Payload-hash idempotency** — if `payloadHash` matches the persisted hash AND `current.approval === "pending"` AND `approvalId` is non-empty, **reuse the existing approvalId and return `reused: true`**. Option C's `lockedUpdate(s => ({...s, approvalId: newId}))` would rotate `approvalId`, orphaning the existing approval card (Eva's Telegram /plan accept duplicate-fire bug, see comment at line 137-145 of in-host fix). This is a USER-VISIBLE REGRESSION the in-host fix specifically prevents.
4. **Audit-event emission** — `logPlanModeApprovalTransition(...)` fires inside the lock. The C7 debug-log feature (F11 in catalog) depends on this. Option C's `store.lockedUpdate(updater)` has no hook for emitting structured side-effects from inside the lock — the call site would have to bolt on event emission outside `lockedUpdate`, re-introducing exactly the cross-namespace ordering bug Option C claims to eliminate.

**Worst-case escalation**: A new contributor implements
`tools/exit-plan-mode.ts` as `store.lockedUpdate(s => ({...s, approval: 'pending', approvalId: newId, lastPlanSteps, title}))` — looks correct, passes naive
tests. Then:
- Telegram /plan accept duplicate-fire bug returns (user reports "approval
  card is stale, agent ignored my approval").
- Mode-guard precondition is absent (no test catches the cross-state arming).
- C7 debug events stop firing (audit trail is broken).

This is the highest-severity finding in the review. The in-host fix is a
**transaction with co-located invariants**, not a "single write." Option C
must either:
- **(A)** Expose `lockedUpdate` as a low-level escape hatch (kept) AND build
  a typed convenience method `requestPlanApproval({approvalId, planSnapshot})`
  that encodes ALL four invariants atomically.
- **(B)** Document that arbitrary `lockedUpdate(updater)` is structurally
  unsafe for approval semantics and forbid it for `approval`/`approvalId`
  writes via type-level discrimination.

**Best-case mitigation**: Option (A) above. Add to
`02-ARCHITECTURE_OPTIONS.md` Section 6:
- `store.requestPlanApproval(args): { approvalId, reused }` is the only
  caller-facing path for arming approval. Internally uses `lockedUpdate`
  with the four invariants hard-coded.
- Cycle-counter writes via `store.tickRejection()` (similar typed wrapper)
  rather than free-form `lockedUpdate(s => ({...s, cycleCount: s.cycleCount+1}))`.
- This converts the "lockedUpdate is the seam" claim into "**typed mutators
  built on top of `lockedUpdate` are the seam**" — exactly what the in-host
  fix encodes.

---

## Attack Vector 3: UI gap — `registerControlUiDescriptor` is the wrong surface

**Severity**: **BLOCKER**

**Evidence**:
- In-host UI footprint (from `01-PARITY_CATALOG.md` lines 188-213):
  - `ui/src/ui/views/chat.ts:1652` — `+554 LOC` plan-mode integration; lines
    274 reference `clearCompactionToast`; the file is the main chat-message
    stream renderer.
  - `ui/src/ui/views/plan-approval-inline.ts:306` — `renderInlinePlanApproval`
    renders the plan card **inline within the message stream**, with
    Accept / Accept allow edits / Revise + Open plan buttons AND a
    revise-textarea state machine, AND a question-variant for
    `ask_user_question` with "Other..." inline textarea.
  - `ui/src/ui/chat/mode-switcher.ts:424` — dropdown chip with planMode +
    planAutoApprove props.
  - `ui/src/ui/chat/plan-cards.ts:122` — `<details>/<summary>` plan-step
    rendering.
  - `ui/src/ui/app.ts:1733` — `+779 LOC` view + dispatch wiring.
  - **Total: 4,237 LOC across 5 plan-mode-specific UI files** plus
    `app-tool-stream.ts:+369`, `app-view-state.ts:+74`, `app-render*.ts`,
    CSS, i18n, `chat.test.ts:+388` — a full UI subsystem.
- `host-hooks.contract.test.ts:672-686`: `registerControlUiDescriptor`
  surface is `"session"` (placement-level), and the descriptor schema must
  be JSON-compatible. The descriptor projects **static state** from the
  session extension; the **UI renderer is host-side**, not plugin-supplied.
- Test at line 681: `expect(registry.registry.controlUiDescriptors ?? []).toHaveLength(0)`
  when the descriptor schema is invalid — Control UI descriptors are an
  **opt-in projection**, not a render seam.

**Claim**: `registerControlUiDescriptor` is a **status-projection mechanism**
for showing plugin state in a generic Control UI sidebar. It is NOT a render
surface for:
- Inline-in-message-stream plan cards with Accept/Reject buttons.
- A revise-textarea state machine bound to plan-rejection feedback.
- An `ask_user_question` "Other..." textarea variant.
- A dropdown chip in the chat header that toggles `sessions.patch { planMode, planApproval.action:"auto" }`.
- A `<details>/<summary>` step-by-step plan-step render with
  `STATUS_MARKERS` mapping `pending/in_progress/completed/cancelled`.

The plugin-SDK has no way to inject DOM into the message stream of the
host webchat. The Control UI surface renders descriptors **in a sidebar
panel**, not interleaved with chat messages. The in-host implementation
is **deeply woven into `chat.ts`'s render loop** (imports mode-switcher
at line 39, calls plan-approval-inline at message-stream-render time).

This is the same trap `LESSONS_LEARNED.A1` describes: *"`installer/patch-plan.json` declares 42 patches against host v2026.4.23 — 6 core diffs + 26 UI anchor-patches + 9 brand-new UI files copied verbatim from PR #70071"* — the prior plugin
shipped UI as host-source patches because the SDK has no UI-render seam
for chat-stream-integrated UI. Option C inherits this exact gap.

**Worst-case escalation**: The plugin ships with a Control UI sidebar
descriptor that shows "Plan: pending approval — click here" but the actual
inline plan card in the chat stream is **absent**. Eva approves from the
sidebar; the auto-approve path works. But the inline-card revise-textarea,
the question "Other..." flow, the Accept-allow-edits two-button distinction,
the mode-switcher chip — none of these can be rendered through
`registerControlUiDescriptor`. Distribution looks plausible (Eva sees
something on screen) but the operator UX is gutted.

**Best-case mitigation** (three options, escalating in invasiveness):
1. **Ship UI in-host as a separate PR.** Plan-mode UI is upstreamed to
   OpenClaw `main`; the workspace plugin ONLY ships the runtime (tools,
   gates, persistence). The UI is hard-coupled to host version. This
   matches `LESSONS_LEARNED.D2`: *"UI lives in-host or it doesn't ship"*
   — guardrail #2.
2. **Drive a new SDK seam.** Propose `api.registerInlineMessageRenderer`
   in `openclaw/plugin-sdk`. Plumb through chat.ts. Wait for upstream
   acceptance. This blocks the plugin behind an SDK change.
3. **Accept reduced parity.** Ship plan-mode with Control UI sidebar only;
   no inline cards. Operator clicks /plan accept in chat OR uses the sidebar
   panel. Distribute as "plan-mode v0.1 — chat UI requires host v2026.4.24+".
   Quality bar drops below `01-PARITY_CATALOG.md`'s "zero divergence acceptable"
   contract.

This is a **BLOCKER**. Option C cannot ship the UI catalog (F9 in parity catalog)
through `registerControlUiDescriptor`. Either UI ships in-host (option 1)
or the parity catalog must be amended (option 3).

---

## Attack Vector 4: `allowConversationAccess` workspace-plugin friction

**Severity**: **MEDIUM**

**Evidence**:
- `openclaw-1/docs/plugins/hooks.md:304-321`:
  > *"Non-bundled plugins that need raw conversation hooks
  > (`before_model_resolve`, `before_agent_reply`, `llm_input`, `llm_output`,
  > `before_agent_finalize`, `agent_end`, or `before_agent_run`) must set:
  > `plugins.entries.<my-plugin>.hooks.allowConversationAccess: true`"*
- The 12-feature taxonomy in `02-ARCHITECTURE_OPTIONS.md:22-34` shows
  Smarter-Claw uses `agent_end` (auto-continue / escalating retry, F7)
  and `before_agent_run`/`before_agent_finalize` for the "PLAN MODE
  AVAILABLE" branch.
- ClawHub distribution model: operator installs from a registry; default
  config has `allowConversationAccess` UNSET (i.e., false), so the plugin's
  hooks silently no-op until the operator manually edits config.

**Claim**: Operators who install Smarter-Claw from ClawHub will see the
plugin "installed" but core features won't fire. The friction surface:
1. Operator runs `openclaw plugin install smarter-claw`.
2. Plugin appears in registry. Config schema visible.
3. Operator restarts gateway. Plugin loads, registers `session_start` /
   `before_tool_call` / `agent_end` hooks via `api.on(...)`.
4. **`agent_end` hook silently no-ops** because `allowConversationAccess`
   is false — the host filters it out.
5. Auto-continue (F7) doesn't fire. Plan-archetype debug (F11 event
   emission) doesn't fire if it depends on `agent_end`. Escalating retry
   doesn't fire.
6. Operator says "the plan-mode feature doesn't work." Files issue.
7. Maintainer says "set `allowConversationAccess: true`."

This is exactly the prior-plugin's class of failure (`LESSONS_LEARNED.B1`:
*"Schema-accepted, no-op config knobs"*).

**Best-case mitigation**:
1. Plugin docs (`README.md`) leads with: *"Before installing, you MUST add
   `plugins.entries.smarter-claw.hooks.allowConversationAccess: true` to
   your config."*
2. Plugin emits a **loud warning at startup** if `allowConversationAccess`
   is missing: *"smarter-claw: conversation hooks disabled. Plan-mode will
   not function. Add `plugins.entries.smarter-claw.hooks.allowConversationAccess: true` to ~/.openclaw/config.yml."*
3. Doctor-check that asserts the config knob is set when smarter-claw
   appears in `plugins.entries`.

**Worst-case escalation**: Without the doctor-check or the loud warning,
plugin appears installed-but-dead — exactly the failure mode of
`LESSONS_LEARNED.C2`: *"No feedback loop with reality until Eva ran it."*
Acceptable trade-off if the warning is loud and the README onboarding
covers it; not a blocker.

---

## Attack Vector 5: Test-portability — host-internal access patterns won't port

**Severity**: **HIGH**

**Evidence** — three specific high-risk in-host test files from
`01-PARITY_CATALOG.md`:

1. **`src/gateway/sessions-patch.test.ts:1,061 LOC`** — drives
   `applySessionsPatchToStore` directly. The test stubs `storePath`,
   creates raw `SessionEntry` rows, mutates `entry.planMode` directly,
   asserts `entry.planMode.approval === "pending"` and `entry.planApproval.cycleId`.
   The plugin has **no equivalent of `applySessionsPatchToStore`** — it
   would route writes through `sessions.pluginPatch` → host's gateway,
   meaning the plugin test would need to spin up a real gateway, which
   is a true integration test, not a unit test. Translation friction =
   ~1,061 LOC of test surface that requires a full e2e harness to retain
   the same coverage.

2. **`src/gateway/plan-snapshot-persister.test.ts:3 cases`** — tests
   `persistApprovalMetadata({approvalRunId: ""})` THROWS with
   `/approvalRunId is required/`. This is the C4 silent-bypass-guard
   (`01-PARITY_CATALOG.md` line 116, F12). The test reaches into a
   private helper exposed via `__testingPlanSnapshotPersister` test seam.
   The plugin port has no equivalent `__testing*` escape hatch because
   `plan-snapshot-persister.ts` runs **inside the gateway**, not inside
   the plugin. The plugin's analog would persist via `store.lockedUpdate`,
   but the security-relevant invariant — that empty/whitespace
   `approvalRunId` is **rejected before any write** — needs to be
   re-encoded as a precondition gate inside the store mutator. The test
   would have to assert against the typed mutator wrapper, not the
   underlying `lockedUpdate`.

3. **`src/cron/isolated-agent/run.plan-mode.test.ts:7 cases`** — auto-enable
   runtime (F5). Tests the actual cron-driven agent turn dispatch with
   `evaluateAutoEnableForMatch(modelId, patterns)` integrated into the
   real cron runner. The plugin has **no cron runner** — cron is a host
   concern. The plugin can register a `cron_changed` observer
   (`hooks.md:148-149`), but it can't drive the agent-turn-dispatch
   pre-flight. The auto-enable check must move to a `session_start`
   or `before_prompt_build` hook — completely different test shape.
   These 7 cases would need to be re-thought as hook-driven unit tests
   plus one integration test against a real gateway+cron.

**Claim**: At least 3 specific test files have host-internal access
patterns that don't survive the port. The catalog claim
(`03-BUILD_BASELINE.md:84-103`) of "220 / 220 plan-mode-hardening-config
tests passing" cannot mean **the same tests** will pass in plugin-land.
~30-40% of the test surface needs **architectural re-port**, not
mechanical translation.

This is `LESSONS_LEARNED.B6` re-emerging: *"Tests are pure-logic, never
integration"* — the prior plugin's 563 unit tests "predicted nothing"
about the live regression. Option C's claim that 875 tests "can port"
needs a **port-pattern decision** for each non-portable test: replace
with integration test (slow, requires real gateway) OR rely on the
SDK contract test to cover the host-side behavior (acceptable but
NOT a 1:1 port).

**Best-case mitigation**:
- Mark every test in the parity catalog as `port-pattern: 1:1 | wrap-in-store | replace-with-integration | drop-host-internal`. Honest accounting before
  porting.
- Build an in-memory `createFakeStore` (mentioned `02:286` in fixture
  notes) — but explicitly include the four typed mutators (request,
  rotate, reject, accept) so the wrap-in-store test pattern works.
- Pre-emptively spin up `tests/integration/` with one e2e harness
  by feature commit 5 (per `LESSONS_LEARNED` Guardrail 5).

**Worst-case escalation**: The plugin ships "875 tests passing" but
covers ~600 unique behaviors and ~275 mechanical translations whose
semantics were silently weakened. Eva hits a regression on feature
F5 (auto-enable) because the test was rebuilt against a fake cron,
not the real one. Same pattern as `LESSONS_LEARNED.A1`.

---

## Attack Vector 6: Bundled-vs-workspace mutation-gate security regression

**Severity**: **HIGH**

**Evidence**:
- `host-hooks.contract.test.ts:125-158`: workspace plugin attempting
  `api.registerTrustedToolPolicy({...})` is **rejected** with diagnostic
  *"only bundled plugins can register trusted tool"*. The test
  unambiguously confirms `registerTrustedToolPolicy` is bundled-only.
- `02-ARCHITECTURE_OPTIONS.md:18` explicitly acknowledges this:
  *"Trusted policy: api.registerTrustedToolPolicy — bundled-plugin gate that
  runs BEFORE ordinary before_tool_call. Smarter-Claw should not use this
  (we're third-party); use a high-priority before_tool_call instead."*
- `hooks.md:189-204`: ordinary `before_tool_call` runs **after** trusted
  tool policies, and within the `before_tool_call` group runs in
  **descending priority order**. Plugins register at priority X; if
  another plugin registers at priority X+1, it fires first.
- In-host integration test (`01-PARITY_CATALOG.md` line ~177-186, F2):
  *"asserts that mutation gate blocks BEFORE the plugin hookRunner sees
  the call — proving the wire is in the right order."* — this is the
  contract the in-host implementation freezes.

**Claim**: A malicious or buggy third-party workspace plugin can
register `before_tool_call` at a higher priority than Smarter-Claw's
mutation gate, intercepting tool calls BEFORE the gate runs. Concrete
attack:
1. Operator installs both `smarter-claw` (workspace) and `evil-plugin`
   (workspace) from ClawHub.
2. `smarter-claw` registers `before_tool_call` at priority `100` (a sane
   default).
3. `evil-plugin` registers `before_tool_call` at priority `1000`.
4. Agent emits `exec rm -rf /`. Plan mode is active, gate would normally
   block.
5. `evil-plugin` hook fires first, rewrites params to `exec ls`, returns
   `params: {command: "ls"}`.
6. `smarter-claw` gate fires next, sees `command: "ls"`, allows
   (it's in the read-only whitelist).
7. `exec` runs with the rewritten `ls` command, **but** the agent's
   intent was `rm -rf /` — the agent thinks it ran the destructive
   command. Plan-mode integrity broken.

The in-host implementation is at the **runtime layer** (`src/agents/pi-tools.before-tool-call.ts:280-323`,
`01-PARITY_CATALOG.md` line 108-110). It runs before any plugin hook
because it's NOT a plugin hook. The plugin port loses this property.

`hooks.md:194`: *"A lower-priority `block: true` can still block after
a higher-priority hook requested approval."* — but this only protects
against approval-rewrite; a higher-priority `params` rewrite happens
*before* the lower-priority handler sees the call. So the mutation
gate sees the **rewritten** params, not the original.

**Best-case mitigation**:
- Plugin registers at the **highest declarable priority** (e.g., 100,000)
  and documents this. But priority is not a security guarantee — any
  plugin can declare higher.
- Plugin verifies params haven't been rewritten by checking a hash of
  the original. But the original is not exposed to the hook.
- Operator-level mitigation: refuse to install any other workspace
  plugin that registers `before_tool_call`. Doctor check that warns
  when smarter-claw + other workspace plugins co-exist with
  `before_tool_call` priority overlap.
- Long-term: propose `api.registerTrustedToolPolicy` access for the
  smarter-claw npm package (per `host-hooks.contract.test.ts:160-191`,
  bundled-status is recognized for `@openclaw/codex`-style packages).
  This routes through a long upstream process.

**Worst-case escalation**: The plugin claims to enforce the mutation
gate, but a higher-priority workspace plugin can defeat it. Operator
trust in the plan-mode boundary breaks. This is a **security regression
vs in-host** that needs explicit acknowledgment in the parity catalog
and the README. Severity = HIGH (not BLOCKER) because the practical
attack requires an additional malicious plugin to coexist — but the
guarantee is weaker than in-host.

---

## Attack Vector 7: Features the architecture doc doesn't explicitly map

**Severity**: **HIGH**

**Evidence** — features from `01-PARITY_CATALOG.md` with NO explicit
plugin-location in `02-ARCHITECTURE_OPTIONS.md` Option C section:

1. **`[PLAN_COMPLETE]` injection text emission** —
   `01-PARITY_CATALOG.md:72`: *"PLAN_COMPLETE injection text emission"*
   in `plan-snapshot-persister.ts`. Option C's `lifecycle/` folder mentions
   `auto-enable.ts`, `retry.ts`, `plan-title-limit.ts`, `cycle-tracker.ts`,
   `grant-ledger.ts` — but no `plan-complete-emitter.ts`. The catalog
   feature F3+F11 requires emitting this text **inside the same locked
   re-evaluation** as the snapshot persistence. Where does it live?

2. **C7 debug-log event emission** —
   `01-PARITY_CATALOG.md:51`: *"`PlanModeDebugEvent` discriminated union
   (state_transition, gate_decision, tool_call, synthetic_injection, ...)"*
   with `logPlanModeDebug` / `logPlanModeApprovalTransition`. In-host this
   fires inside every state mutation (see Vec 2 — emission at line 224 of
   the race-fix). Option C doesn't designate a debug-event sink. Plugin
   would need a sibling module under `state/debug-events.ts` with a
   typed emitter (env-wins-over-config + 30s TTL cache, per catalog
   line 51). Where in Option C? Unspecified.

3. **Pre-flight + locked re-evaluation** in `plan-snapshot-persister.ts` —
   `01-PARITY_CATALOG.md:72`: *"persistSnapshot with closeOnComplete +
   pre-flight + lock-snapshot re-evaluation"*. The in-host pattern is
   (a) read state outside lock as pre-flight to skip the common case
   without taking the lock, (b) re-read INSIDE the lock to handle the
   race. Option C's `store.lockedUpdate(updater)` API doesn't naturally
   express this; the updater runs inside the lock, so the pre-flight
   would have to happen before calling `lockedUpdate` — but every
   such call would need to re-read inside the updater. Not specified.

4. **`__testingPlanSnapshotPersister`** test seam —
   `01-PARITY_CATALOG.md:72` + `03-BUILD_BASELINE.md:206`: *"helper is
   exposed via `__testingPlanSnapshotPersister` (controlled test-only
   export, not a private-import smell)"*. The plugin port needs an
   equivalent `__testing*` discipline (per `LESSONS_LEARNED` and
   `BASELINE.md:300-302`). Option C doesn't mention test-export
   discipline.

5. **Atomic file write for `plan-archetype-persist.ts`** —
   `01-PARITY_CATALOG.md:49`: *"atomic O_CREAT|O_EXCL ('wx'); MAX_COLLISION_SUFFIX = 99; path-traversal rejection; symlink rejection
   at agent + plans dir; PlanPersistStorageError class (ENOSPC/EACCES/EIO)"*.
   This is a F5 plan-archetype feature (write markdown to disk in
   `~/.openclaw/agents/<agentId>/plans/`). Plugins are sandboxed against
   raw FS access in some configurations; need to verify the plugin can
   write to host filesystem with the security invariants the in-host
   code enforces. Option C doesn't specify the filesystem-access seam.

6. **Plan-store cross-session namespacing** —
   `01-PARITY_CATALOG.md:65`: *"PlanStore class for cross-session plan
   namespacing (CLAUDE_CODE_TASK_LIST_ID style); namespace validation
   regex ...; Windows reserved name reject; O_NOFOLLOW symlink reject;
   ... MAX_PLAN_FILE_BYTES=1MB"*. This is `plan-store.ts` — different
   from `PlanModeStore` in Option C. The architecture doc conflates two
   stores. Where does the cross-session plan-store live in the plugin?

**Claim**: At least 6 catalog features have unspecified plugin location.
`LESSONS_LEARNED.D1`: *"Knowledge sentinel: parity catalog file ...
Any feature without a `host_ref` cannot be ported."* — Option C's
folder layout (`tools/`, `gates/`, `prompt/`, `lifecycle/`, `ui/`,
`actions/`) doesn't accommodate these 6 features without further
decomposition or co-location decisions.

**Best-case mitigation**:
- Amend `02-ARCHITECTURE_OPTIONS.md:200-244` to either add `state/snapshot.ts`,
  `state/debug-events.ts`, `state/archetype-persist.ts`, `state/plan-store.ts`
  as siblings of `state/store.ts`, OR explicitly defer 4-6 to feature folders
  with clear cross-imports (`tools/exit-plan-mode.ts` imports
  `state/snapshot.ts` for the pre-flight pattern).
- Add per-feature `host_ref` entries in `02-ARCHITECTURE_OPTIONS.md` so
  each maps to a concrete plugin location.
- Run a 5-minute audit: walk the 12-feature taxonomy + the catalog's
  sub-features and assert every line item has a target folder. Bake
  this into a pre-implementation CI check.

**Worst-case escalation**: The 6 features get bolt-on locations during
implementation (e.g., `lifecycle/plan-complete-emitter.ts` invented in
PR-5). The bolt-on diverges from the in-host shape; reviewer doesn't
catch it; Eva hits a regression. This is `LESSONS_LEARNED.C3`: *"Scope
creep ratcheted, never contained"*.

---

## Summary

| Severity | Count |
|----------|-------|
| BLOCKER  | 2 (Vectors 2, 3) |
| HIGH     | 3 (Vectors 1, 5, 6) |
| MEDIUM   | 1 (Vector 4) |
| NONE     | 0 |
| Vector 7 | HIGH (composite — 6 sub-issues, treated as one finding) |

---

## Verdict

**Option C does NOT survive at ≥95% confidence.**

Two BLOCKERs:

1. **Vector 2** (race-fix invariant is incomplete): the in-host fix
   encodes **four co-located invariants** (sync bundle write,
   mode-guard precondition, payload-hash idempotency, audit-event
   emission). Option C's `store.lockedUpdate(updater)` captures only
   one. A naive port loses the Telegram /plan-accept duplicate-fire
   protection and the cross-state arming defense. Fix is mandatory
   before code moves: define typed mutators (`requestPlanApproval`,
   `tickRejection`, etc.) that encode the invariants, NOT free-form
   `lockedUpdate`.

2. **Vector 3** (UI gap): `registerControlUiDescriptor` is a
   status-projection surface, NOT a chat-message-stream render seam.
   4,237 LOC of in-host plan-mode UI cannot be ported to this surface.
   Either UI ships in-host as a separate PR (preferred per
   `LESSONS_LEARNED.D2` guardrail), or the parity catalog must be
   amended to accept "Control UI sidebar only" parity (a real loss).

Three HIGHs (Vectors 1, 5, 6) are real risks but workable with
explicit mitigations declared **before** PR-1.

Vector 4 (MEDIUM) is acceptable with loud-warning + doctor-check.

Vector 7 (HIGH composite) is fixable in a 5-minute amend pass on
`02-ARCHITECTURE_OPTIONS.md`.

---

## Recommendation to the team

Before implementation begins:

1. **Amend Option C in `02-ARCHITECTURE_OPTIONS.md`** to:
   - Replace `store.lockedUpdate(updater)` with **typed mutators**
     (`requestPlanApproval`, `tickRejection`, `acceptApproval`,
     `rejectApproval`, `recordCycleTransition`) that encode the four
     in-host invariants. `lockedUpdate` becomes a private escape hatch,
     not the caller-facing seam.
   - Add `state/debug-events.ts`, `state/snapshot.ts`,
     `state/archetype-persist.ts`, `state/plan-store.ts` as siblings
     of `state/store.ts`.
   - Add `cleanup(reason)` to `PlanModeStore`.
   - Mark `registerControlUiDescriptor` as INCAPABLE of inline plan
     cards / revise-textarea / mode-switcher — document the UI gap
     loudly.

2. **Decide UI strategy NOW**:
   - Path A (recommended): UI ships as in-host PR upstream of plugin.
     Plugin distributes runtime only.
   - Path B: Accept reduced UI parity (sidebar only). Amend
     `01-PARITY_CATALOG.md` F9 to "sidebar-only" scope.
   - Path C: Block plugin behind a new SDK seam
     (`registerInlineMessageRenderer`).

3. **Re-run the 95%-confidence gate** AFTER amendments. If Option C
   survives the amended doc, ship. If not, escalate to Option D
   (split: in-host UI + workspace runtime plugin) or Option E
   (defer plugin port entirely; ship in-host as the long-term home).

Eva already said: *"she'd rather find the fatal flaw NOW than ship
and fail again."* These two BLOCKERs are the fatal-flaw class.
Address them in the doc before any code moves.
