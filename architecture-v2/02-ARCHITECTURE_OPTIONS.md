# Smarter-Claw v2 — Plugin Architecture Options

**Status:** decision input — three viable shapes laid out, scored, one recommended.
**Inputs:** `openclaw-1/src/plugin-sdk` SDK seams (mature in upstream/main), `openclaw-pr70071-rebase` in-host source-of-truth (`src/agents/plan-mode/` ~12 modules + tool factories + `pi-embedded-subscribe.handlers.tools.ts`), abandoned Smarter-Claw v1 (`src/` flat with ~30 files), 12-feature taxonomy.
**Out of scope:** the actual feature catalog (separate document) and the install-vs-publish distribution decision (orthogonal).

---

## 1 — Shared baseline (true of every option)

The SDK gives one set of seams, so all three options use the same primitives. The difference is **how** they're partitioned across files and namespaces.

- **Entry:** `definePluginEntry({ id, register(api) })` from `openclaw/plugin-sdk/plugin-entry`. Loaded via `openclaw.extensions` in `package.json` resolving to `dist/index.js`.
- **State seam:** `api.session.state.registerSessionExtension({ namespace, description, cleanup })` projects JSON-compatible state through `pluginExtensions` on the session row. Mutations route through Gateway `sessions.pluginPatch`. Cleanup callback receives `reset | delete | disable | restart`.
- **Tool seam:** `api.registerTool(factoryFn)` for agent-callable tools (factory takes `OpenClawPluginToolContext`); `api.registerSessionAction({ id, schema, handler, requiredScopes })` for UI-callable mutators (RPC via `plugins.sessionAction`).
- **Hook seam:** `api.on(hookName, handler, { priority, timeoutMs })`. Priority is descending; `block:true` is terminal.
- **UI seam:** `api.session.controls.registerControlUiDescriptor({ id, surface, placement, label })`. Discovered through `plugins.uiDescriptors` RPC.
- **Trusted policy:** `api.registerTrustedToolPolicy` — bundled-plugin gate that runs BEFORE ordinary `before_tool_call`. Smarter-Claw should *not* use this (we're third-party); use a high-priority `before_tool_call` instead.
- **Injection seam:** `api.enqueueNextTurnInjection({ idempotencyKey, content, ttl })` — durable, exactly-once, drained before prompt hooks. This is how `[PLAN_DECISION]: approved`, `[PLANNING_RETRY]`, and accept-edits notes reach the model.
- **Race-fix mechanism:** any synchronous state write must happen inside the same `updateSessionStoreEntry({ update })` lock callback that flips approval to `pending`. This is the architectural constraint from the `1081067476` fix — patterns where the snapshot is persisted *asynchronously after* the approval row exists are broken by design.

The 12-feature taxonomy must land somewhere in every option:
1. `enter_plan_mode` / `exit_plan_mode` tools — `api.registerTool`
2. Mutation gate — `before_tool_call`
3. Plan-approval persistence — `session.state` namespace + synchronous lock-callback write
4. `planMode` runtime context — same namespace projector
5. Plan archetype + `ask_user_question` + auto-mode — `before_prompt_build` + tool
6. Plan title + turn limit — namespace fields + `agent_end` counter
7. Auto-continue / escalating retry — `agent_end` + `enqueueNextTurnInjection`
8. Rejection UX + cycle tracking — `session.state` cycle counter
9. Mode-switcher UI + plan cards — `registerControlUiDescriptor`
10. Exec allowlist — `before_tool_call` (allowlist check)
11. Approval grant ledger / `approvalRunId` / `approvalId` correlation — namespace state + agent-event subscription
12. Shell-escape defense — `before_tool_call` (params sanitizer)

---

## 2 — Option A: Monolithic feature plugin

**Summary:** one extension namespace, one entry file orchestrating all 12 features, sub-files imported as helpers but registration happens centrally in `index.ts`. Mirrors the v1 Smarter-Claw shape and the in-host `src/agents/plan-mode/index.ts` barrel.

### File / module layout

```
smarter-claw/
├── index.ts                       # ALL api.registerX + api.on calls
├── api.ts                         # public types/constants barrel
├── runtime-api.ts                 # read/write helpers for the state namespace
├── openclaw.plugin.json
├── package.json
└── src/
    ├── types.ts                   # PlanMode, PlanApprovalState, PlanStep
    ├── state.ts                   # readState/writeState/clearState helpers
    ├── tools/
    │   ├── enter-plan-mode.ts
    │   ├── exit-plan-mode.ts
    │   ├── ask-user-question.ts
    │   └── plan-mode-status.ts
    ├── archetype.ts               # build prompt fragment
    ├── mutation-gate.ts           # before_tool_call decision
    ├── exec-allowlist.ts          # before_tool_call decision
    ├── shell-escape-defense.ts    # before_tool_call sanitizer
    ├── auto-enable.ts             # session_start auto-flip
    ├── retry.ts                   # agent_end ack-only retry
    ├── plan-title-limit.ts        # plan-title + turn-limit accounting
    ├── cycle-tracker.ts           # rejection cycle counter
    ├── grant-ledger.ts            # approvalRunId/approvalId correlation
    ├── approval-persist.ts        # SYNC write inside updateSessionStoreEntry
    ├── injections.ts              # PLAN_DECISION / PLANNING_RETRY builders
    └── ui-descriptors.ts          # mode-switcher + plan-card descriptors
```

### Namespace strategy
**One namespace:** `"plan-mode"`. All 12 features read/write the same JSON bag through `runtime-api.ts`.

### Hook registration topology
ALL registrations in `index.ts`. Sub-files export pure helpers (`shouldBlockMutation`, `buildArchetypePromptResult`, `handleAckOnlyRetry`) that `index.ts` wires into `api.on(...)`. Hook count in entry: ~10 (one per: `before_prompt_build`, `before_tool_call`, `after_tool_call`, `agent_end`, `session_start`, `session_end`, `tool_result_persist`, `before_agent_run`, `before_compaction`, `gateway_start`).

### State model
- **Where:** single `plan-mode` namespace. Shape:
  ```ts
  { mode: "off"|"plan"|"executing", approval: "none"|"pending"|"approved"|"rejected",
    approvalId, approvalRunId, lastPlanSteps, lastPlanPayloadHash,
    title, cycleCount, turnCount, autoApprove, grants[] }
  ```
- **Cycle counter:** ticked in `exit_plan_mode` tool body (success path) AND in the rejection path (`onResolution: "deny"`).
- **Restart survival:** `registerSessionExtension` projects through `pluginExtensions` — host persists JSON to session store. Survives plugin restart automatically.
- **Empty-plan-body race fix:** the `exit_plan_mode` tool's `handler` opens an `updateSessionStoreEntry({ update })` lock and writes `approvalId + lastPlanSteps + title + payloadHash` inside the same callback. Mirrors the in-host `persistPlanApprovalRequest` exactly. No separate persister subscribes to agent events.

### Tool surface
- `api.registerTool`: `enter_plan_mode`, `exit_plan_mode`, `ask_user_question`, `plan_mode_status` (4 tools — agent-callable).
- `api.registerSessionAction`: `plan.approve`, `plan.reject`, `plan.toggle-auto-approve`, `plan.cancel` (4 actions — UI-callable).

### UI integration
**One `registerControlUiDescriptor`** with `id: "plan-mode"`, `placement: "session-sidebar"`. The Control UI renders both the mode-switcher and the plan-card from the projected `plan-mode` state.

### Test strategy
- Unit tests per `src/*.ts` helper (pure functions).
- End-to-end tests in `tests/` using `host-hook-fixture` style fixtures from `plugin-sdk/plugins/contracts`.
- Contract tests against SDK in `tests/contract/`.

### Test fixture location
`tests/fixtures/plan-mode-session.ts`, exports state-builders. `tests/e2e/full-flow.test.ts` for cradle-to-grave.

---

## 3 — Option B: Feature-decomposed plugin

**Summary:** every feature is a self-contained module exporting its own `register(api)`. Plugin entry orchestrates by calling each registration in order. State is split into per-feature namespaces; cross-feature reads go through typed accessors.

### File / module layout

```
smarter-claw/
├── index.ts                       # ~30 LOC: imports + register() per feature
├── api.ts
├── runtime-api.ts
├── openclaw.plugin.json
├── package.json
└── src/
    ├── features/
    │   ├── plan-mode-tools/       # enter/exit/status/ask_user
    │   │   ├── register.ts        # api.registerTool calls
    │   │   ├── enter-plan-mode.ts
    │   │   ├── exit-plan-mode.ts
    │   │   ├── ask-user-question.ts
    │   │   ├── plan-mode-status.ts
    │   │   └── tools.test.ts
    │   ├── mutation-gate/
    │   │   ├── register.ts        # api.on("before_tool_call", ...)
    │   │   ├── gate.ts
    │   │   └── gate.test.ts
    │   ├── exec-allowlist/
    │   ├── shell-escape-defense/
    │   ├── plan-approval/         # persistence + race-fix
    │   │   ├── register.ts        # session_start projector + agent-event listener
    │   │   ├── persist.ts         # SYNC write helper
    │   │   ├── grant-ledger.ts
    │   │   └── persist.test.ts
    │   ├── plan-runtime/          # planMode runtime context
    │   ├── archetype-prompt/      # before_prompt_build injection
    │   ├── auto-mode/
    │   ├── plan-title-limit/
    │   ├── escalating-retry/
    │   ├── rejection-ux/          # cycle counter + UX
    │   └── plan-ui/               # mode-switcher + plan-cards descriptors
    └── shared/
        ├── types.ts
        └── injections.ts
```

### Namespace strategy
**One namespace per feature** — 12 namespaces total: `"plan-mode.tools"`, `"plan-mode.gate"`, `"plan-mode.approval"`, `"plan-mode.runtime"`, etc. Each feature owns its slice.

### Hook registration topology
Plugin entry is a thin orchestrator:

```ts
register(api) {
  registerPlanModeTools(api, config);
  registerMutationGate(api, config);
  registerPlanApproval(api, config);
  registerArchetypePrompt(api, config);
  // ...
}
```

Each `register*.ts` calls its own `api.on(...)` / `api.registerTool(...)`. Hook wiring lives in each feature folder.

### State model
- **Where:** 12 namespaces. Approval state in `"plan-mode.approval"`, runtime context in `"plan-mode.runtime"`, etc.
- **Cycle counter:** lives in `"plan-mode.rejection-ux"`. The `exit_plan_mode` tool (in `plan-mode-tools`) cannot tick it directly — must dispatch via a cross-feature event or shared helper.
- **Restart survival:** all 12 namespaces persist independently. Host restores each on session-store load.
- **Empty-plan-body race fix:** the `plan-approval` feature's `register.ts` registers an agent-event subscription on `stream === "plan"`. It opens `updateSessionStoreEntry` synchronously inside the handler — BUT the source of the snapshot (the `exit_plan_mode` tool in a different feature) has already returned. **This is the v1 Smarter-Claw failure mode.** To match the in-host fix, the persist call must move INTO `exit_plan_mode`'s handler, which means the `plan-mode-tools` feature must import from `plan-approval/persist.ts` — feature coupling re-emerges through the import graph.

### Tool surface
- `api.registerTool`: in `plan-mode-tools/register.ts` (4 tools).
- `api.registerSessionAction`: distributed — `plan.approve`/`reject` in `plan-approval/register.ts`, `plan.toggle-auto-approve` in `auto-mode/register.ts`, `plan.cancel` in `plan-mode-tools/register.ts`.

### UI integration
**Two `registerControlUiDescriptor` calls:** `id: "plan-mode-switcher"` (in `plan-ui/register.ts`) projecting from `plan-mode.runtime`; `id: "plan-card"` projecting from `plan-mode.approval`. Control UI must compose both.

### Test strategy
- Per-feature unit tests in each folder.
- No end-to-end test naturally fits any folder — lives in `tests/e2e/`.
- Contract tests in `tests/contract/`.

### Test fixture location
Per-feature fixtures in each folder; shared fixture at `tests/fixtures/`.

---

## 4 — Option C: Hybrid (centralized state, decomposed behavior)

**Summary:** single `"plan-mode"` namespace owned by a `state/` module (so all approval/cycle/title fields stay coherent), but tools, hooks, and UI surfaces decompose into feature folders that call back into the state module through a typed `PlanModeStore` interface. State coherence + behavioral modularity.

### File / module layout

```
smarter-claw/
├── index.ts                       # ~40 LOC orchestrator
├── api.ts
├── runtime-api.ts
├── openclaw.plugin.json
├── package.json
└── src/
    ├── state/
    │   ├── store.ts               # PlanModeStore: readState/writeState/lockedUpdate
    │   ├── projector.ts           # registerSessionExtension call
    │   ├── types.ts
    │   └── store.test.ts
    ├── tools/                     # 4 tools, all call store.lockedUpdate
    │   ├── register.ts
    │   ├── enter-plan-mode.ts     # store.lockedUpdate({ mode: "plan" })
    │   ├── exit-plan-mode.ts      # store.lockedUpdate({ approval: "pending",
    │   │                          #   approvalId, lastPlanSteps, title, payloadHash })
    │   ├── ask-user-question.ts
    │   ├── plan-mode-status.ts
    │   └── tools.test.ts
    ├── gates/                     # before_tool_call surfaces
    │   ├── register.ts
    │   ├── mutation-gate.ts
    │   ├── exec-allowlist.ts
    │   ├── shell-escape-defense.ts
    │   └── gates.test.ts
    ├── prompt/                    # before_prompt_build surfaces
    │   ├── register.ts
    │   ├── archetype.ts
    │   └── prompt.test.ts
    ├── lifecycle/                 # session_start / agent_end / after_tool_call
    │   ├── register.ts
    │   ├── auto-enable.ts
    │   ├── retry.ts               # escalating-retry / ack-only
    │   ├── plan-title-limit.ts
    │   ├── cycle-tracker.ts
    │   ├── grant-ledger.ts
    │   └── lifecycle.test.ts
    ├── ui/                        # registerControlUiDescriptor
    │   ├── register.ts
    │   └── descriptors.ts
    └── actions/                   # registerSessionAction (UI mutators)
        ├── register.ts
        └── handlers.ts
```

### Namespace strategy
**One namespace:** `"plan-mode"`, owned by `state/projector.ts`. Every other module reads/writes through `PlanModeStore`. No other namespace.

### Hook registration topology
`index.ts` is thin:

```ts
register(api) {
  const store = createPlanModeStore(api);
  registerTools(api, store, config);
  registerGates(api, store, config);
  registerPrompt(api, store, config);
  registerLifecycle(api, store, config);
  registerUi(api, store, config);
  registerActions(api, store, config);
}
```

Each `register*` calls its own `api.on(...)`. The store is the only path to state — all writes go through `store.lockedUpdate(updater)` which wraps `updateSessionStoreEntry`.

### State model
- **Where:** one namespace, owned by `state/projector.ts`.
- **Cycle counter:** ticked through `store.lockedUpdate(s => ({ ...s, cycleCount: s.cycleCount + 1 }))` from `lifecycle/cycle-tracker.ts` or `tools/exit-plan-mode.ts`.
- **Restart survival:** single projector restores the full bag from session store on plugin restart.
- **Empty-plan-body race fix:** `exit_plan_mode.ts` calls `store.lockedUpdate(s => ({ ...s, approval: "pending", approvalId, lastPlanSteps, title, payloadHash }))` — one synchronous write inside one lock. The store's `lockedUpdate` IS the sequenced write. No event-bus indirection. Mirrors the in-host `persistPlanApprovalRequest` 1:1.

### Tool surface
- `api.registerTool` calls in `tools/register.ts` (4 tools).
- `api.registerSessionAction` calls in `actions/register.ts` (4 actions). Both consume the same `PlanModeStore`.

### UI integration
**One `registerControlUiDescriptor`** with `id: "plan-mode"`, `placement: "session-sidebar"`. Single descriptor renders mode-switcher + plan-card (matches Option A). State projection is coherent because there's only one namespace.

### Test strategy
- `state/store.test.ts` — pure unit tests on the store contract.
- Per-folder integration tests (`tools.test.ts`, `gates.test.ts`, etc.) — instantiate a fake store, exercise the registration.
- `tests/e2e/` — full-flow against `host-hook-fixture`.
- `tests/contract/` — SDK-shape stability.

### Test fixture location
`tests/fixtures/store.ts` exposes a `createFakeStore({ initialState })` helper consumed by every per-folder test. Each folder has its own `*.test.ts` colocated.

---

## 5 — Scoring matrix (1 = bad, 5 = great)

| Dimension                       | A: Monolithic | B: Decomposed | C: Hybrid |
|---------------------------------|:-------------:|:-------------:|:---------:|
| Parity-completeness risk        | 4             | 2             | 4         |
| Maintainability (PR-16 contributor) | 2         | 4             | 4         |
| Testability (unit isolation)    | 3             | 5             | 5         |
| Distribution complexity (ClawHub + install) | 5 | 3             | 4         |
| SDK-evolution resilience        | 2             | 4             | 4         |
| State coherence                 | 5             | 2             | 5         |
| **Total**                       | **21**        | **20**        | **26**    |

### How to read the scores

- **Parity-completeness risk:** A scores 4 because all 12 features live in `index.ts`'s registration block — easy to scan. B scores 2 because each feature's wiring is in a different file, so missing a feature means missing a folder you didn't know to look for. C scores 4 because the orchestrator block in `index.ts` lists all 6 `register*` calls — a small audit surface.
- **Maintainability:** A scores 2 because `index.ts` becomes 500+ LOC and intertwines concerns. B and C score 4 because feature folders are self-contained.
- **Testability:** B and C score 5 because each feature/folder is a unit. A scores 3 because cross-cutting concerns share `index.ts` setup.
- **Distribution:** A is simplest (one barrel, one dist file). B has more entry points and a larger surface to keep in sync. C is in between (state is centralized; surfaces decomposed but few).
- **SDK-evolution resilience:** A is brittle because every SDK seam change touches `index.ts`. B and C absorb seam churn within feature folders.
- **State coherence:** A and C have one namespace — read it once, you know the session. B has 12, requiring you to compose them mentally to reason about state.

---

## 6 — Recommendation: Option C (Hybrid)

**Pick C.** Rationale (200 words):

Option C scores highest (26 vs 21/20) because it inherits the three killer properties this codebase has already learned about plan-mode the hard way:

1. **State coherence is non-negotiable.** The empty-plan-body race fix (`1081067476`) only works because approval, snapshot, and title write inside *one* lock. Option B's per-feature namespaces re-introduce the cross-namespace ordering problem the in-host fix eliminated — even if persist.ts lives in a feature folder, the `exit_plan_mode` tool must import it, so coupling re-emerges through the import graph while losing the audit benefit of a single state owner.
2. **Modular behavior matters at PR-16.** A new contributor adding a feature like "voice plan announcements" should add a `lifecycle/voice.ts` and a one-line `register` call — not surgery on a 500-LOC `index.ts`. Option C preserves this.
3. **The store contract is the testable seam.** With one `PlanModeStore` interface, every other module is trivially unit-testable against a fake. Option A forces integration tests; Option B fragments the state into 12 fakes per test.

**Strongest counter-argument:** Option C requires a non-trivial up-front investment in the `PlanModeStore` abstraction, and the first three features will look like extra work compared to dropping helpers into `index.ts` (Option A). If the porting plan only ships 4 features then stops, A would have shipped faster. But we're shipping 12 + future, on a moving SDK, to ClawHub — the abstraction pays back by feature 5 and compounds thereafter. The store-first approach also encodes the race-fix invariant structurally (every write goes through `lockedUpdate`), making the empty-plan-body bug literally unrepresentable in module space.

---

## 7 — Implementation notes (deferred)

The next document (`03-IMPLEMENTATION_PLAN.md`) should cover, against Option C:

- Exact `PlanModeStore` interface (`readState`, `lockedUpdate(updater)`, `clearState`, subscribe-hook for projector).
- Migration sequence: order the 12 features to land — gate + tools + approval-persist first (so the race-fix lands with the smallest surface), then prompt/lifecycle/UI/actions.
- Test fixture for `lockedUpdate` (in-memory journal so unit tests can assert single-write atomicity).
- ClawHub distribution: confirm manifest fields (`openclaw.extensions`, `hooks.allowConversationAccess`, etc.).
- Backwards-compat with v1 namespace `"smarter-claw"`: read-migrate on first projector load.

---

## Executive summary (200 words)

**Recommended: Option C (Hybrid)** — single `"plan-mode"` namespace owned by a `PlanModeStore`, with tools / gates / prompt / lifecycle / UI / actions decomposed into feature folders that read and write state only through the store. Scores 26/30 in the matrix vs A's 21 and B's 20. The win is structural: every state mutation must go through `store.lockedUpdate`, which encodes the empty-plan-body race-fix invariant in module space — there is no path for `lastPlanSteps` and `approvalId` to land in separate writes. State stays as auditable as Option A (one namespace, one projector, one mental model) while behavior decomposes as cleanly as Option B (per-feature folders, per-feature tests, no central god-file). Tools register in `tools/`, hooks register in `gates/` and `lifecycle/`, UI registers in `ui/` — `index.ts` is ~40 LOC of orchestration.

**Strongest counter:** Option C front-loads work on the `PlanModeStore` abstraction that Option A could skip. If the goal were to ship 4 features and stop, A is faster. With 12 features + future on a moving SDK targeting ClawHub, the abstraction pays back by feature 5 and prevents the v1 race-bug class entirely. Worth the up-front cost.
