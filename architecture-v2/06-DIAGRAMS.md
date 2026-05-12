# Smarter-Claw v2 — Option C Architectural Diagrams

Step-2 input to the architectural decision record. Six diagrams of the recommended Hybrid plugin (`02-ARCHITECTURE_OPTIONS.md` §4). Every box anchors to an in-host file:line from `01-PARITY_CATALOG.md` or an SDK seam in `openclaw-1/docs/plugins/hooks.md` / `openclaw-1/src/plugins/contracts/host-hook-fixture.ts`.

---

## Diagram 1 — Module / file layout

12-feature taxonomy mapped onto `smarter-claw/src/`. Peer-dependency rule: every box outside `state/` reaches the store only through the typed `PlanModeStore` interface — this is what makes the race fix structurally guaranteed (Diagram 6, defense #1).

```
smarter-claw/
├── index.ts                  Orchestrator. Calls createPlanModeStore + 6 registers.
├── api.ts                    Public type/constant barrel (re-exports state types).
├── runtime-api.ts            Re-exports SDK shape so consumers compile w/o openclaw-sdk dep.
├── openclaw.plugin.json      Manifest. openclaw.extensions → dist/index.js.
├── package.json
└── src/
    ├── state/                              ─── OWNS namespace "plan-mode" ───
    │   ├── store.ts          F1,F3,F4,F6,F8,F11   PlanModeStore: readState
    │   │                                          / lockedUpdate / clearState
    │   ├── projector.ts      F3,F4               registerSessionExtension call
    │   │                                         (SDK: api.session.state.registerSessionExtension)
    │   ├── types.ts          F1,F3,F4,F6,F8,F11   PlanModeState shape (mirrors
    │   │                                          Parity Appendix C: SessionEntry.planMode + roots)
    │   └── store.test.ts                          Unit: lockedUpdate atomicity journal
    │           ▲   ▲   ▲   ▲   ▲   ▲
    │           │   │   │   │   │   │   only PlanModeStore boundary
    │           │   │   │   │   │   │   crosses these arrows
    ├── tools/  │   │   │   │   │   │              ─── api.registerTool x4 ───
    │   ├── register.ts       F1               tools/register.ts groups all 4
    │   ├── enter-plan-mode.ts        F1,F4    in-host: pi-embedded-subscribe.handlers.tools.ts:1791
    │   ├── exit-plan-mode.ts         F1,F3,F6 in-host: pi-embedded-subscribe.handlers.tools.ts:1838
    │   │                                      // RACE-FIX SITE — calls store.lockedUpdate
    │   ├── ask-user-question.ts      F5       in-host: pi-embedded-subscribe.handlers.tools.ts:1971
    │   ├── plan-mode-status.ts       F11      in-host: agents/tools/plan-mode-status-tool.ts
    │   └── tools.test.ts                      Per-tool tests w/ fake store
    │
    ├── gates/                                     ─── api.on(before_tool_call) x3 ───
    │   ├── register.ts       F2,F10,F12
    │   ├── mutation-gate.ts          F2       in-host: pi-tools.before-tool-call.ts:317
    │   ├── exec-allowlist.ts         F10      in-host: pi-tools.before-tool-call.ts (allowlist branch)
    │   ├── shell-escape-defense.ts   F12      in-host: agents/plan-mode/exec-shell-escape.ts
    │   └── gates.test.ts                      Per-gate decision matrix
    │
    ├── prompt/                                    ─── api.on(before_prompt_build) ───
    │   ├── register.ts       F5
    │   ├── archetype.ts              F5       in-host: pi-embedded-runner/run/attempt.ts:689
    │   └── prompt.test.ts
    │
    ├── lifecycle/                                 ─── session_start / agent_end / after_tool_call ───
    │   ├── register.ts       F5,F6,F7,F8,F11
    │   ├── auto-enable.ts            F5       in-host: cron/isolated-agent/run.ts (evaluateAutoEnableForMatch)
    │   ├── retry.ts                  F7       in-host: pi-embedded-runner/run.ts:2046
    │   ├── plan-title-limit.ts       F6       in-host: pi-embedded-runner/run.ts (maxIterations gate)
    │   ├── cycle-tracker.ts          F8       in-host: agents/plan-mode/approval.ts:62 (rejectionCount)
    │   ├── grant-ledger.ts           F11      in-host: subagent-announce.ts (approvalRunId propagation)
    │   └── lifecycle.test.ts
    │
    ├── ui/                                        ─── api.registerControlUiDescriptor x1 ───
    │   ├── register.ts       F9
    │   └── descriptors.ts            F9       SDK: api.session.controls.registerControlUiDescriptor
    │
    └── actions/                                   ─── api.registerSessionAction x4 ───
        ├── register.ts       F3,F5,F8
        └── handlers.ts                F3,F5,F8 in-host: auto-reply/reply/commands-plan.ts:556
```

**Peer-dependency invariant.** No file outside `state/` imports `pluginPatch` directly. The store wraps `updateSessionStoreEntry` (SDK seam in `host-hook-fixture.ts`). In module space the only file that knows how to land an `approvalId` is `state/store.ts`, and its sole write API is the lock callback.

---

## Diagram 2 — Plugin registration topology

`api.*` calls at plugin load and the handler each points at. Anchored to `hooks.md:105-150` (hook taxonomy) and `host-hook-fixture.ts`.

```
                        index.ts::register(api)
                                 │
        ┌────────────────────────┼─────────────────────────────────────┐
        │                        │                                     │
        ▼                        ▼                                     ▼
   createPlanModeStore     api.session.state.                    api.registerRuntimeLifecycle
   (constructor)           registerSessionExtension              ──► lifecycle/register.ts
   ──► state/store.ts      ──► state/projector.ts                    onStartup / onShutdown
                           namespace: "plan-mode"                    (drain nudges, flush store)
                           cleanup: reset|delete|disable|restart
                                 │
                 ┌───────────────┼───────────────┐
                 │               │               │
                 ▼               ▼               ▼
        registerTools     registerGates     registerPrompt     registerLifecycle     registerUi     registerActions
        (tools/register)  (gates/register)  (prompt/register)  (lifecycle/register)  (ui/register)  (actions/register)

  tools/register.ts
    api.registerTool(enterPlanModeFactory)    ──► tools/enter-plan-mode.ts::handler
    api.registerTool(exitPlanModeFactory)     ──► tools/exit-plan-mode.ts::handler  // RACE-FIX site
    api.registerTool(askUserQuestionFactory)  ──► tools/ask-user-question.ts::handler
    api.registerTool(planModeStatusFactory)   ──► tools/plan-mode-status.ts::handler

  gates/register.ts  (priorities descending; block:true terminal)
    api.on("before_tool_call", mutationGate,     {priority:90000}) ──► mutation-gate.ts    // F2, H10
    api.on("before_tool_call", shellEscapeGuard, {priority:85000}) ──► shell-escape-defense.ts // F12
    api.on("before_tool_call", execAllowlist,    {priority:80000}) ──► exec-allowlist.ts   // F10

  prompt/register.ts
    api.on("before_prompt_build", planArchetype, {priority:50000}) ──► archetype.ts   // F5, parity H32 L1491

  lifecycle/register.ts
    api.on("session_start",         autoEnable,     {p:50000}) ──► auto-enable.ts          // F5
    api.on("agent_end",             retryHandler,   {p:50000}) ──► retry.ts                // F7
    api.on("agent_end",             titleLimitTick, {p:40000}) ──► plan-title-limit.ts     // F6
    api.on("after_tool_call",       cycleTracker,   {p:50000}) ──► cycle-tracker.ts        // F8
    api.on("subagent_lifecycle",    grantLedger,    {p:50000}) ──► grant-ledger.ts         // F11
    api.on("before_agent_finalize", retrySteer,     {p:30000}) ──► retry.ts

  ui/register.ts
    api.session.controls.registerControlUiDescriptor({
      id:"plan-mode", surface:"session-sidebar", placement:"primary", label:"Plan Mode",
    }) ──► ui/descriptors.ts::buildDescriptor   // renders mode-switcher + plan-card (F9)

  actions/register.ts  (RPC: plugins.sessionAction; requiredScopes:["operator"] on all)
    api.registerSessionAction({id:"plan.approve",     schema, handler})  ──► handlers.ts::approve
    api.registerSessionAction({id:"plan.reject",      schema, handler})  ──► handlers.ts::reject
    api.registerSessionAction({id:"plan.cancel",      schema, handler})  ──► handlers.ts::cancel
    api.registerSessionAction({id:"plan.toggle-auto", schema, handler})  ──► handlers.ts::toggleAuto
    // each: validates approvalId, store.lockedUpdate, {continueAgent:true} on approve
    // in-host: auto-reply/reply/commands-plan.ts:556

Total api.* at load: 1 store + 1 extension + 4 tools + 6 hooks + 1 UI + 4 actions + 1 lifecycle = 18.
```

---

## Diagram 3 — PlanModeStore state model

Single namespace `"plan-mode"`. Schema mirrors Parity Appendix C (lines 1502-1541). The store enforces which writes are synchronous (in `lockedUpdate`) vs asynchronous (fire-and-forget post-lock).

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ PlanModeState (one extension namespace)                                                  │
│   anchor: state/types.ts ⇄ Parity Appendix C, lines 1502-1541                           │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ Key                       Type                          Write mode                       │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ mode                      "off"|"plan"|"executing"      SYNC  (lockedUpdate)             │
│ approval                  "none"|"pending"|"approved"   SYNC  ── race-fix invariant set ─│
│                           |"edited"|"rejected"          │     │ all 5 keys MUST land in  │
│                           |"timed_out"                  │     │ ONE lock callback per    │
│ approvalId                string|undefined              SYNC  │ persistPlanApprovalRequest│
│ lastPlanSteps             Array<PlanStep>               SYNC  │ (anchor: parity §F3 line │
│ lastPlanPayloadHash       string (sha1 prefix 12)       SYNC  │ 399; commit 1081067476)  │
│ title                     string ≤80 chars              SYNC  ── end race-fix set ───────│
│ cycleId                   string (uuid)                 SYNC  (set on enter; F11)         │
│ enteredAt                 number (epoch ms)             SYNC  (set on enter)              │
│ confirmedAt               number                        SYNC  (set on approve/edit)       │
│ updatedAt                 number                        SYNC  (bumped every write)        │
│ feedback                  string|undefined              SYNC  (set on reject, cleared on  │
│                                                                approve/edit)              │
│ cycleCount                number (= rejectionCount)     SYNC  (incremented on reject,     │
│                                                                reset on approve/edit)     │
│ autoApprove               boolean                       SYNC  (toggle.action; survives    │
│                                                                mode→normal — F5)          │
│                                                                                          │
│ approvalRunId             string                        ASYNC (after agent_approval_event;│
│                                                                empty-string THROW guard — │
│                                                                parity §F11 line 916)      │
│ blockingSubagentRunIds    string[]                      ASYNC (subagent_lifecycle event)  │
│ lastSubagentSettledAt     number                        ASYNC (drain-to-zero)             │
│ nudgeJobIds               string[]                      ASYNC (cron-schedule emit)        │
│                                                                                          │
│ // root-level (peer of plan-mode object, survives plan-mode delete):                     │
│ recentlyApprovedAt        number                        SYNC  (set on approve)            │
│ recentlyApprovedCycleId   string                        SYNC  (paired with above)         │
│ postApprovalPermissions   {acceptEdits,grantedAt,       SYNC  (set on edit action,        │
│                            approvalId}                          cleared on close-on-complete│
│                                                                 — parity §F8)             │
│ planModeIntroDeliveredAt  number|undefined              SYNC  (one-shot marker)           │
│ pendingAgentInjections    PendingAgentInjectionEntry[]  SYNC  (priority queue cap=10,     │
│                                                                parity §F7)                │
│ pendingInteraction        {kind,approvalId,...}         SYNC  (durable rehydration)       │
└──────────────────────────────────────────────────────────────────────────────────────────┘

Projector (state/projector.ts), sync — UI subset (anchor: parity §F4 L470 + §F9):
  EXPOSED:  mode, approval, title, cycleCount, autoApprove, approvalId,
            lastPlanSteps[*].{step,status}, postApprovalPermissions.acceptEdits
  HIDDEN:   approvalRunId, blockingSubagentRunIds, nudgeJobIds,
            lastPlanPayloadHash, pendingAgentInjections, pendingInteraction

Cleanup callback (registerSessionExtension):
  reset    Clear plan-mode object; KEEP recentlyApproved* + autoApprove
  delete   Clear everything including roots
  disable  Clear plan-mode object; KEEP autoApprove
  restart  No-op — namespace survives via pluginExtensions persistence
           (anchor: 02-OPTIONS §4 "Restart survival")

Store contract (state/store.ts):
   lockedUpdate(updater)  wraps SDK updateSessionStoreEntry({update}); all
                          synchronous writes happen inside one callback
   readState()            non-locking projection read
   clearState({reason})   routes through cleanup above
   subscribe(handler)     forwards api.on("plan-mode.state.changed")
```

---

## Diagram 4 — `enter_plan_mode` → approval → execution flow

Happy path. Every box maps to either a hook seam (Parity Appendix B) or a store boundary.

```
 user message          ┌─────────────┐
   ("plan X")  ──────► │   Model     │
                       └──────┬──────┘
                              │ tool call: enter_plan_mode
                              ▼
       ┌─────────────────────────────────────────────────────┐
   [1] │ tools/enter-plan-mode.ts::handler                   │
       │   store.lockedUpdate(s => ({                        │
       │     ...s, mode:"plan", cycleId:newUuid(),           │
       │     enteredAt:Date.now(), approval:"none"           │
       │   }))                                               │
       │   // anchors: parity H1 line 1460, H8 line 1467     │
       └─────────────────────┬───────────────────────────────┘
                              │ tool returns; agent loop continues
                              ▼
       ┌─────────────────────────────────────────────────────┐
   [2] │ MUTATION GATE — every subsequent before_tool_call   │
       │   gates/mutation-gate.ts                            │
       │   if state.mode==="plan" AND isMutator(toolName):   │
       │     return { allow:false, reason:"plan-mode" }      │
       │   // anchor: parity H10 line 1469                   │
       └─────────────────────┬───────────────────────────────┘
                              │ (gate stays armed until exit_plan_mode lands)
                              ▼
       ┌─────────────────────────────────────────────────────┐
   [3] │ PROMPT BUILD — before_prompt_build fires next turn  │
       │   prompt/archetype.ts injects plan-archetype prompt │
       │   + reads state.autoApprove + state.feedback to     │
       │   compose deescalation/retry framing                │
       │   // anchor: parity H32 line 1491                   │
       └─────────────────────┬───────────────────────────────┘
                              │
                              ▼
                       ┌─────────────┐
                       │   Model     │ emits plan body + exit_plan_mode tool call
                       └──────┬──────┘
                              │
                              ▼
       ┌─────────────────────────────────────────────────────────────────────────────┐
   [4] │ tools/exit-plan-mode.ts::handler          ── RACE-FIX SITE ──                 │
       │   const approvalId  = newPlanApprovalId();                                    │
       │   const payloadHash = sha1(toolParams).slice(0,12);                           │
       │                                                                              │
       │   const persistResult = await store.lockedUpdate(s => {                       │
       │     // Idempotency (parity §F3 L344): repeat fire with same hash reuses ID    │
       │     if (s.lastPlanPayloadHash === payloadHash                                 │
       │         && s.approval === "pending" && s.approvalId) {                        │
       │       return { state:s, approvalId:s.approvalId, reused:true };               │
       │     }                                                                        │
       │     return { state:{ ...s,                                                    │
       │         approval:"pending", approvalId,                                       │
       │         lastPlanSteps: extractSteps(toolParams),                              │
       │         title:         extractTitle(toolParams),                              │
       │         lastPlanPayloadHash: payloadHash,                                     │
       │         updatedAt: Date.now() },                                              │
       │       approvalId, reused:false };                                             │
       │   });                                                                        │
       │   // 5 fields, ONE callback. Mirrors persistPlanApprovalRequest               │
       │   // at pi-embedded-subscribe.handlers.tools.ts:130-237 (parity §F3 L399)     │
       │                                                                              │
       │   await api.emitAgentApprovalEvent({                                          │
       │     kind:"plugin", approvalId: persistResult.approvalId, title, plan,...      │
       │   });   // emit STRICTLY after lock returns                                  │
       └─────────────────────┬───────────────────────────────────────────────────────┘
                              │
                              ▼
                       ┌──────────────────┐
                       │   Agent yields   │  awaiting-approval state surfaces in UI
                       └────────┬─────────┘  via projector + registerControlUiDescriptor
                                │
                                ▼ (UI now shows plan-card with approve/reject buttons)
       ┌─────────────────────────────────────────────────────────────────────────────┐
   [5] │ User /approve  ──► plugins.sessionAction id:"plan.approve", {approvalId}      │
       │   ──► actions/handlers.ts::approveHandler                                     │
       │       1. assert ctx.scopes.includes("operator")                               │
       │       2. store.lockedUpdate(s => {                                            │
       │            if (s.approvalId !== input.approvalId) throw STALE_APPROVAL;       │
       │            if (s.approval !== "pending")          throw TERMINAL_STATE;       │
       │            return { ...s, approval:"approved", confirmedAt:Date.now(),       │
       │                     recentlyApprovedAt: Date.now(),                           │
       │                     recentlyApprovedCycleId: s.cycleId };                     │
       │          })                                                                  │
       │       3. api.enqueueNextTurnInjection({                                       │
       │            idempotencyKey: `plan-decision-${approvalId}`,                     │
       │            content: "[PLAN_DECISION]: approved\n…", ttl: 600_000              │
       │          })   // parity H28 L1487                                             │
       │       4. return { continueAgent: true }                                       │
       │   // in-host: auto-reply/reply/commands-plan.ts:556 (parity §F8)              │
       └─────────────────────┬───────────────────────────────────────────────────────┘
                              │
                              ▼
       ┌─────────────────────────────────────────────────────────────────────────────┐
   [6] │ Host resumes turn. before_prompt_build drains pendingInjections →             │
       │   "[PLAN_DECISION]: approved" delivered exactly-once.                         │
       │   Mutation gate sees mode="plan" + approval="approved" + approvalRunId        │
       │   matches ctx.runId → disengages for this run.                                │
       │   // anchor: parity §F2 + §F11 (approvalRunId-scoped grant)                   │
       └─────────────────────┬───────────────────────────────────────────────────────┘
                              │
                              ▼
                       ┌─────────────┐
                       │   Model     │ executes mutations (Edit/Bash/Write); gate
                       └─────────────┘ allows them because approval matches this run
```

---

## Diagram 5 — Rejection + cycle tracking flow

Sad path. State transitions through `cycleCount` until termination at `maxCycles` (`agents.defaults.embeddedPi.autoContinue.maxCycles`, default 3 — parity §F7 line 728).

```
  Agent yields with approval:"pending", approvalId set.
                              │
                              ▼
   [1] User /reject ──► plugins.sessionAction id:"plan.reject", {approvalId, feedback}
       ──► actions/handlers.ts::rejectHandler
            1. assert ctx.scopes.includes("operator")
            2. assert feedback non-empty  // F8 schema requirement, parity §F8 L754
                              │
                              ▼
   [2] store.lockedUpdate(s => {
         if (s.approvalId !== input.approvalId) throw STALE_APPROVAL;
         if (s.approval !== "pending")          throw TERMINAL_STATE;
         return { ...s,
           approval:"rejected", feedback:input.feedback,
           cycleCount: s.cycleCount + 1, updatedAt: Date.now() };
       })
       // mirrors resolvePlanApproval at agents/plan-mode/approval.ts (parity §F8 L754)
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
   [3a] cycleCount < maxCycles         [3b] cycleCount ≥ maxCycles
        Inject deescalation hint:           Terminal rejection — emit final summary:
          api.enqueueNextTurnInjection({      api.enqueueNextTurnInjection({
            idempotencyKey:                     content:"[PLAN_DECISION]: rejected
              `plan-retry-${cycleCount}-                (final, max cycles reached)" })
              ${approvalId}`,                 Then:
            content:"[PLAN_DECISION]:           store.lockedUpdate(s => ({
              rejected\nfeedback: "             ...s, mode:"off", approval:"none",
              + feedback })                     approvalId:undefined,
        Reset approval/Id but KEEP              lastPlanSteps:[], title:"" }))
        feedback + cycleCount:                Mutation gate permanently disengages
          store.lockedUpdate(s => ({         for this run (mode→off).
            ...s, approval:"none",
            approvalId:undefined }))                  │
        // archetype.ts re-reads                      ▼
        // feedback next turn                  Agent receives termination tag;
              │                                session continues in normal mode.
              ▼
       Loop to Diagram 4 step [3]; model
       emits revised plan in body.
```

---

## Diagram 6 — Failure modes & defenses

Where each known attack/bug is structurally prevented.

```
| # | Failure mode | Defense | Lives in | Anchor |
|---|---|---|---|---|
| 1 | Empty-plan-body race (commit `1081067476`). Async persister landed `approvalId` before `lastPlanSteps` materialized; /approve fired against empty body. | Store contract: `approvalId`, `lastPlanSteps`, `title`, `lastPlanPayloadHash`, `approval` ALL inside ONE `lockedUpdate` callback. Signature forbids splitting the bag. | `state/store.ts` (only write API is the lock) | Diagram 4 step [4]; parity §F3 L399 |
| 2 | Mutation-gate silent bypass via missing `approvalRunId` (undefined used to mean "no live state", silently allowed mutations). | Gate reads `store.readState()` + `ctx.runId`. Fail-closed: if `approvalRunId` undefined while `approval==="approved"` → block. Empty-string `approvalRunId` THROWS at projector. | `gates/mutation-gate.ts` + `state/projector.ts` | parity §F11 L914, §F12 |
| 3 | Shell-escape attack via dangerous flag in exec (e.g. `bash -c "rm -rf /"`). | `DESTRUCTIVE_ESCAPE_PATTERNS` regex match at `before_tool_call` priority 85000 → block. Independent of mutation gate (layered defense). | `gates/shell-escape-defense.ts` | parity §F12 |
| 4 | Stale `approvalId` reuse (user double-clicks /approve after agent rotated ID). | Lock callback compares `input.approvalId` to `s.approvalId`; mismatch → throw `STALE_APPROVAL`. Terminal-state check → throw `TERMINAL_STATE`. Both checks atomic with state read. | `actions/handlers.ts` (all 4 actions) | parity §F8 L754 |
| 5 | Plugin restart mid-approval (process dies between persist and emit, or operator reloads). | `cleanup({reason:"restart"})` is a no-op; namespace survives via `pluginExtensions` persistence. Projector returns persisted state on next read; pending `approvalId` still valid. | `state/store.ts` + `state/projector.ts` | parity §F3 L466; 02-OPTIONS §4 "Restart survival" |
| 6 | Subagent-gate bypass via `sessions.patch` (prior-repo issue #73). External `sessions.patch` used to flip `planMode` without going through plugin's gate. | New architecture: host's `sessions.patch` treats `pluginExtensions["plan-mode"]` as opaque — only the plugin can write through `plugins.sessionAction`. Combined gate (`blockingSubagentRunIds.length > 0` OR within `SUBAGENT_SETTLE_GRACE_MS` 10000ms) → throw `PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS` or `..._WAITING_FOR_SUBAGENT_SETTLE`. `grant-ledger.ts` mirrors `openSubagentRunIds` into store on `subagent_lifecycle` hook → fail-closed by construction. | `actions/handlers.ts` + `lifecycle/grant-ledger.ts` | parity §F11 L914, L1490 |

**Cross-cutting (always-on):**
- Persist before broadcast — `actions/handlers.ts` awaits `lockedUpdate` BEFORE `emitAgentApprovalEvent` / `enqueueNextTurnInjection` (parity §F3 L472).
- Empty-string `approvalRunId` THROWS at projector boundary (parity §F11 L913).
- `lastPlanPayloadHash` idempotency prevents `approvalId` rotation when agent re-fires `exit_plan_mode` with same payload (parity §F3 L344, §F1 L300).
```

---

## Summary — places where Option C's "obvious" mapping doesn't fit in-host 1:1

(200 words.)

Four gaps the decision record needs to address explicitly:

**1. Schedule-time persistence vs SDK injection seam.** In-host `schedulePlanNudgesAndPersist` writes `nudgeJobIds` *and* schedules cron jobs (`infra/heartbeat-runner.ts:729`). The SDK has no first-class cron seam. Option C's `lifecycle/retry.ts` can emulate via `setInterval` inside `registerRuntimeLifecycle.onStartup`, but that loses cross-process durability the in-host cron family has — survives gateway restart, plugin doesn't. Decision needed: accept reduced durability, or proxy through host's plugin-cron API if one exists.

**2. `getAgentRunContext(approvalRunId)` lookup.** In-host `sessions-patch.ts:853` reaches into agent-runner internals to fetch live ctx. SDK exposes no `getAgentRunContext` equivalent. Plugin must rely *entirely* on the persisted `blockingSubagentRunIds` mirror (Diagram 3 ASYNC fields). Fail-closed is preserved, but parentCtx fast-path is gone — adds latency to gate decisions for active subagents.

**3. Always-on subsystem loggers** (parity Appendix G). Two loggers fire at info even when `agents.defaults.planMode.debug:false`. SDK gives `api.logger` with default level controlled by host config — plugin can't force info. Either we accept opt-in logging only, or surface a plugin-config knob.

**4. lastPlanSteps materialization** (parity §F3 line 420, in-host `sessions-patch.ts:1135-1189`) runs inside host-side patch flow before plan-snapshot-persister reads it. In Option C, materialization moves into `tools/exit-plan-mode.ts` (where the payload is). Pure relocation — but it means the plugin owns step-shape normalization (status enum mapping, etc.) which the host previously did, expanding the plugin's bug surface.
