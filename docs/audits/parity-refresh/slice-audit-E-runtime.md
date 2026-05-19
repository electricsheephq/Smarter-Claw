# Parity Refresh — Slice Audit E: Runtime + Foundation Cluster

**Auditor:** parity-refresh slice-E agent (adversarial, read-only against in-host)
**Date:** 2026-05-19
**Cluster:** S6 (plan-tier model), S7 (escalating retry), S11 (grant-ledger + debug-log), S13 (plugin foundation), S14 (public types + helpers)
**In-host source-of-truth:** branch `rebase/pr70071-onto-main-2026-04-25` commit `ea04ea52c7` in `/Volumes/LEXAR/repos/openclaw-pr70071-rebase`
**Installed SDK:** OpenClaw `2026.5.18` (per `docs/audits/AUDIT-E-sdk-seam-parity.md` re-execution)

---

## Method

- Mechanical byte-comparison of all 24 S7 constants (extracted both sides via regex, diffed programmatically).
- Line-by-line diff of S14 helpers (`approval-id`, `payload-hash`, `sanitize`) and `types.ts` against in-host `plan-mode/types.ts` + `tools/exit-plan-mode-tool.ts`.
- Diff of plugin `debug-log.ts` event union vs in-host `plan-mode-debug-log.ts`.
- SDK seam re-check: `node_modules/openclaw/dist/plugin-sdk` for `registerSessionSchedulerJob`, `registerCommand`, `before_agent_finalize` event shape.
- Test-coverage review: `tests/runtime/*`, `tests/types.test.ts`, `tests/helpers/*`, `tests/p1-skeleton.test.ts`.

---

## Per-file verdict

| File | Slice | Verdict | Notes |
|---|---|---|---|
| `src/runtime/escalating-retry-constants.ts` | S7 | **PASS** | All 24 constants byte-identical to in-host. PR #89 re-port verified. |
| `src/runtime/escalating-retry.ts` | S7 | **PASS-with-gaps** | Coarse detection honestly documented. One stale doc + one new-seam opportunity (E-3, E-4). |
| `src/runtime/plan-tier-model.ts` | S6 | **PASS-with-gaps** | Plugin-invented feature, honestly flagged as having no in-host counterpart. Turn-limit watchdog deferral is now **stale** (E-1). |
| `src/runtime/debug-log.ts` | S11 | **PARITY-GAP** | Event union diverges from in-host in 4 event kinds. Not byte-parity despite "verbatim" claim (E-2). |
| `src/runtime/grant-ledger.ts` | S11 | **PASS** | Plugin-only correlation cache; process-local is intentional + documented. |
| `src/index.ts` | S13 | **PASS-with-gaps** | All 5 hooks + tool/command/CLI/UI registrations wired. Hotfix #93 `registerCommand` confirmed valid (E-5). Provider/model not threaded (E-4). |
| `src/types.ts` | S14 | **PASS** | Matches in-host union + interface; additive-only extra fields documented. |
| `src/helpers/approval-id.ts` | S14 | **PASS-with-gaps** | Logic byte-identical; one error-message string diverged (E-7). |
| `src/helpers/payload-hash.ts` | S14 | **PASS** | Byte-identical to in-host `exit-plan-mode-tool.ts:353-362`. |
| `src/helpers/sanitize.ts` | S14 | **PASS** | Byte-identical ZWSP replacement; U+200B verified. |

---

## Findings table

| ID | Severity | Class | Title | In-host ref | Plugin ref |
|---|---|---|---|---|---|
| E-1 | **P1** | parity-gap | S6 turn-limit watchdog deferral is now stale — the blocking seam exists | `incomplete-turn.ts` (loop-bound rationale) | `plan-tier-model.ts` (no watchdog); `docs/audits/wave-1/S6-S13-S14-foundation.md:159-196` |
| E-2 | **P1** | parity-gap | `debug-log.ts` event union diverges from in-host despite "verbatim port" claim | `plan-mode-debug-log.ts:63-141` | `src/runtime/debug-log.ts:60-131` |
| E-3 | **P2** | bug | `escalating-retry.ts` doc comment cites wrong `maxAttempts` & stale line numbers | `incomplete-turn.ts:151-265` | `escalating-retry.ts:27-39`; `tests/runtime/escalating-retry.test.ts:18-22` |
| E-4 | **P2** | missing-feature | `before_agent_finalize` now exposes `provider`+`model`; plugin discards them | `incomplete-turn.ts:556-573` (provider-gated detection) | `src/index.ts:530-547`; `escalating-retry.ts:79-101` |
| E-5 | **P2** | test-gap | `registerCommand` (hotfix #93) has no unit/skeleton-test coverage | n/a | `src/index.ts:322-333` |
| E-6 | **P1** | bug | `madeToolCall` proxy via `stopHookActive` is semantically unverified and likely wrong | `incomplete-turn.ts` (real `toolMetas`) | `src/index.ts:539`; `escalating-retry.ts:86-91` |
| E-7 | **P2** | parity-gap | `newPlanApprovalId` throw-message says `"newPlanApprovalId:"`; in-host says `"buildApprovalId:"` | `plan-mode/types.ts:142` | `helpers/approval-id.ts:66` |
| E-8 | **P2** | test-gap | `newPlanApprovalId` hard-refuse (throw-on-missing-RNG) path still untested | `approval.test.ts:247-261` (entropy only) | `tests/helpers/approval-id.test.ts:12-16` (explicitly deferred) |
| E-9 | **P2** | test-gap | No test pins `index.ts` hook *registration* — degraded-state + 5-hook wiring | n/a | `tests/p1-skeleton.test.ts` (module-shape only) |
| E-10 | **P2** | test-gap | `escalating-retry` attemptIndex is never wired from a real counter; cross-cycle staleness untested | `incomplete-turn.ts` (host counts via idempotencyKey) | `src/index.ts:542-547` (omits `attemptIndex`) |
| E-11 | **P2** | parity-gap | S11 grant-ledger correlation is never consumed — `record`/`prune` wired, but no read path | `plan-mode-debug-log.ts` correlation enrichment | `src/index.ts:255-277` (writes only); `grant-ledger.ts:98-106` (`get` unused in `src/`) |

---

## Detail

### E-1 — S6 turn-limit watchdog deferral is stale (P1, parity-gap)

The Wave-1 foundation audit (`docs/audits/wave-1/S6-S13-S14-foundation.md:25,159-196`) deferred the
turn-limit watchdog with the explicit rationale: *"would need `registerSessionSchedulerJob` wiring"* — i.e.
the deferral was **conditioned on the SDK seam not existing**.

That condition no longer holds. On the installed SDK (`2026.5.18`):

- `node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts:1982` —
  `registerSessionSchedulerJob: (job: PluginSessionSchedulerJobRegistration) => PluginSessionSchedulerJobHandle | undefined`
  exposed on `api.session.workflow`.
- `host-hooks.d.ts:151` defines `PluginSessionSchedulerJobRegistration`; `:162` defines the handle.
- `api-builder.d.ts:17` confirms it is part of the public `OpenClawPluginApi` surface.

So the seam the deferral waited for **is shipping**. The watchdog is the single biggest functional gap
in S6 (the Wave-1 audit's own conclusion at line 305), and its primary use case — auto-mode + repeated
rejections — is *exactly* the scenario Smarter-Claw markets. The plugin already carries
`rejectionCount` on `PlanModeSessionState` (`types.ts:139`) and `autoApprove` (`types.ts:212`), so the
state needed to trip a watchdog is present.

**Verdict:** This is now a *silent divergence*, not an honest limitation. The "deferred" status is
documented against a precondition that has expired. Either (a) implement the watchdog via
`registerSessionSchedulerJob`, or (b) re-document the deferral with a *current* rationale (e.g. "v1.0
scope cut") and a tracking issue — not "the seam doesn't exist."

`plan-tier-model.ts` itself is sound: its `host_ref` honestly states the in-host has no centralized
model-override file and that `modelOverride` is a generic per-session field (confirmed — in-host
`agent-command.ts:184,668,705` treats `modelOverride` as a session-entry field, never plan-mode-scoped).
The plan-tier-model hook is a *plugin-invented* feature, acceptably flagged. No finding on the override
logic itself.

### E-2 — `debug-log.ts` event union diverges from in-host despite "verbatim" claim (P1, parity-gap)

`src/runtime/debug-log.ts:57-59` claims: *"Port verbatim from in-host plan-mode-debug-log.ts:63-141."*
It is **not** verbatim. Diffing the two `PlanModeDebugEvent` unions:

| Event kind | In-host shape | Plugin shape | Divergence |
|---|---|---|---|
| `tool_call` | `tool: "enter_plan_mode" \| "exit_plan_mode" \| "update_plan" \| "ask_user_question"`; `runId: string`; `details?` | `tool: string`; `mode: string`; `meta?`; `approvalRunId?`; `approvalId?` | **Different fields entirely** — in-host has `runId`, plugin has `mode`+`meta`. In-host `tool` is a 4-value union; plugin is open `string`. |
| `synthetic_injection` | `tag: string`; `preview: string` | `injectionKind: string`; `idempotencyKey?` | **Different field names** — `tag`/`preview` vs `injectionKind`/`idempotencyKey`. |
| nudge event | kind = `nudge_event`; `nudgeId`; `phase: "scheduled"\|"fired"\|"cleaned"` | kind = `nudge_phase`; `phase: string`; `details?` | **Different kind name** (`nudge_event` vs `nudge_phase`) and field set. |
| approval event | kind = `approval_event`; `action`; `openSubagentCount`; `result` | (absent) | **Plugin drops the `approval_event` kind entirely.** |
| toast event | kind = `toast_event`; `toast`; `phase: "fired"\|"dismissed"` | kind = `ui_toast`; `message`; `severity?` | **Different kind name + fields.** |
| `subagent_event` | `parentRunId`; `childRunId`; `event: "spawn"\|"return"` | `event: string`; `details?` | In-host has explicit parent/child runIds; plugin has open `string`. |

Only `state_transition`, `gate_decision`, and `approval_transition` are genuinely shape-compatible.

This matters because the debug log is the operator's correlation surface — a `grep '\[plan-mode/'`
runbook written against the in-host taxonomy (`nudge_event`, `toast_event`, `approval_event`) will
silently miss events on the plugin. The header's "verbatim" claim is false and should be downgraded to
"semantic port; event taxonomy adapted to the SDK surface" with a divergence table, OR the union should
be re-aligned. Given S11's purpose is operator debuggability, the honest fix is to align the kind names
at minimum (`nudge_phase`→`nudge_event`, `ui_toast`→`toast_event`) and restore `approval_event`.

Sub-note: plugin's `tool_call` event has no `runId` field, so a plugin debug stream cannot correlate a
tool call to an agent run the way the in-host stream can — a real loss of the C7 correlation design the
header claims to preserve.

### E-3 — `escalating-retry.ts` doc comment cites wrong `maxAttempts` + stale line numbers (P2, bug)

`escalating-retry.ts:27` header says *"Escalation levels (max 3 retries per cycle)"*. That is correct
only for `PLANNING_RETRY`. `PLAN_YIELD` and `PLAN_ACK_ONLY` both cap at **2**
(`DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT = 2`, `DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT = 2`) — and the
code itself sets `maxAttempts: 2` for those (lines 144, 161). The blanket "max 3" header is misleading.

Separately, `escalating-retry.test.ts:19` claims the regex constants are *"byte-identical
(incomplete-turn.ts:66-74)"* — the actual in-host regex block is lines **66-89** (six regexes, the
`PLANNING_ONLY_ACTION_VERB_RE` ends at line 89). And line 21 references
`incomplete-turn.ts:151-265` for instruction strings — those are actually at the lines noted in the
constants file's own headers (151-156, 157-160, 161-166, 226-243, 254-265), so "151-265" as a single
range silently includes unrelated code. Cosmetic, but a parity-harness Layer-1 diff keyed on those line
numbers would mis-anchor. Tighten the citations.

The constants themselves are **byte-perfect** (24/24 verified) — this is a documentation-accuracy bug,
not a constants regression.

### E-4 — Plugin discards the now-available `provider`+`model` finalize fields (P2, missing-feature)

Wave-0's AUDIT-E re-execution (`docs/audits/AUDIT-E-sdk-seam-parity.md:372-376`) found that on
`2026.5.18` the `before_agent_finalize` event gained `provider`, `model`, and `messages` fields —
confirmed at `node_modules/openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts:143-150`:

```ts
export type PluginHookBeforeAgentFinalizeEvent = {
    runId?: string; sessionId: string; sessionKey?: string; turnId?: string;
    provider?: string;   // <-- new on 2026.5.18
    model?: string;      // <-- new on 2026.5.18
    cwd?: string; transcriptPath?: string;
    stopHookActive: boolean; lastAssistantMessage?: string; messages?: unknown[];
};
```

The in-host detection is provider-gated: `incomplete-turn.ts:556-573` only applies incomplete-turn
recovery for `isStrictAgenticSupportedProviderModel` or the Gemini provider set
(`GEMINI_INCOMPLETE_TURN_PROVIDER_IDS`). The plugin's `TurnSignal` (`escalating-retry.ts:79-101`) has
**no** `provider`/`model` field, and `src/index.ts:542-547` builds the signal without reading
`event.provider` / `event.model`. Result: the plugin retries uniformly regardless of provider, which
diverges from in-host behavior (in-host would NOT retry for an unsupported provider).

This is a *missing-feature* (the seam is available, the parity behavior is not built), severity P2
because the plugin's coarse detector is already a documented approximation. But it should be noted in
the coarse-detection limitation comment, and `provider`/`model` should be threaded through `TurnSignal`
so a future PR can gate. Right now the divergence is silent — the coarse-detection doc block
(`escalating-retry.ts:40-59`) lists what's deferred but does NOT mention provider gating.

### E-5 — `registerCommand` (hotfix #93) has no test coverage (P2, test-gap)

`src/index.ts:322-333` registers `/plan` and `/plan-mode` slash commands via `api.registerCommand`.
`registerCommand` is confirmed a real SDK seam (`registry.d.ts:67`, `types.d.ts:2142`,
`api-builder.d.ts:17`) — the wiring is valid. But `tests/p1-skeleton.test.ts` only asserts module
shape (id/name/description/register fn). No test exercises the command registration, the
`sessionActionHandlers` snapshot map (`index.ts:303-315`), or the `/plan accept|reject|cancel|edit|answer`
→ session-action routing. The slash-command wiring is a hotfix with zero regression net.

### E-6 — `madeToolCall` proxy via `stopHookActive` is semantically unverified (P1, bug)

`src/index.ts:539`: `const madeToolCall = event.stopHookActive === true;`

The plugin's own comment (`escalating-retry.ts:86-91`) and the Wave-1 S7 report
(`docs/audits/wave-1/S7-escalating-retry.md`, "`event.stopHookActive` semantics — 40%, assumed not
verified") both flag this as a *guess*. The SDK type (`hook-types.d.ts:148`) gives `stopHookActive` no
doc comment at all. Conventionally `stopHookActive` indicates *"this finalize is a re-invocation of a
stop hook"* — i.e. it is about hook re-entrancy, NOT about whether the turn called a tool. If that
conventional meaning holds, then `madeToolCall` is **wrong**:

- A genuine chat-only first turn has `stopHookActive = false` → plugin infers `madeToolCall = false` →
  detector fires. (Happens to be correct by accident.)
- A tool-call turn that is NOT a stop-hook re-invocation also has `stopHookActive = false` → plugin
  infers `madeToolCall = false` → detector **wrongly fires a retry on a turn that already acted.**

This is the single highest-risk correctness issue in the cluster: the entire 3-detector mechanism keys
off `madeToolCall`, and `madeToolCall` is derived from a field whose semantics are unverified and
plausibly unrelated. The in-host uses real `toolMetas` (a list of actual tool calls) — there is no
honest proxy for that in the SDK event today. This should be escalated: either (a) find a real seam
(`messages?: unknown[]` is now on the event — the plugin could inspect the last message for tool-call
content), or (b) the coarse-detection doc must explicitly state "tool-call detection is a heuristic
proxy via `stopHookActive` and may false-positive" — currently it claims `stopHookActive` "IS true
during turns that resolved via stop_hook (which fires for tool-call-using turns)" (`index.ts:537-538`),
an assertion with no SDK-doc backing.

`messages?: unknown[]` arriving on the event (E-4 / AUDIT-E line 374) is the unblock here — the plugin
can now inspect the final message array for tool-call entries instead of guessing from `stopHookActive`.

### E-7 — `newPlanApprovalId` throw-message diverges (P2, parity-gap)

`helpers/approval-id.ts:66-68` throws with a message beginning `"newPlanApprovalId: no
cryptographically secure RNG available..."`. The in-host (`plan-mode/types.ts:142`) throws the *same*
message but beginning `"buildApprovalId: ..."`. The file header claims *"This is a byte-identical
port"* (`approval-id.ts:45`). It is not — the function-name prefix in the error string differs. Either
the in-host has a stale name (`buildApprovalId` was likely the pre-rename identifier) and the plugin
"fixed" it silently, or the plugin should match. Low impact (error text only), but it contradicts the
explicit byte-identical claim and a parity-harness string diff will flag it. Recommend: match in-host
exactly, or downgrade the header claim to "logic-identical port; error string corrected to current
function name."

The rest of `approval-id.ts` (resolution order, `globalThis.crypto` → `node:crypto` → throw, the
`plan-` prefix, the v4-UUID `isPlanApprovalId` regex) **is** byte/behavior-identical. The plugin also
*adds* `isPlanApprovalId`, which the in-host `types.ts` does not export — an additive helper, fine.

### E-8 — `newPlanApprovalId` hard-refuse path untested (P2, test-gap)

`tests/helpers/approval-id.test.ts:12-16` explicitly defers the throw-on-missing-RNG test:
*"NOT covered here (deferred): Throw-on-missing-RNG fallback path."* The Wave-1 audit
(`S6-S13-S14-foundation.md:216,284,304`) already flagged this as the highest-leverage S14 gap. The
throw is a *security* contract (refuse to mint a weak token rather than silently degrade
plan-approval staleness protection). It remains untested. The hard-refuse path is reachable in a test
by stubbing both `globalThis.crypto` and the `node:crypto` import — awkward but not impossible with
`vi.mock`. This carried over un-actioned from Wave-1.

### E-9 — No test pins `index.ts` hook registration / degraded-state wiring (P2, test-gap)

`tests/p1-skeleton.test.ts` covers `resolveConfig` and `buildAdvisorySessionMessage` in isolation but
never calls `register(api)` with a fake `api`. So nothing asserts:

- All 5 hooks (`before_tool_call`, `before_model_resolve`, `before_agent_finalize`,
  `before_prompt_build`, `session_start`) are actually registered.
- `before_model_resolve` is registered **only when `config.planTierModel` is set** (`index.ts:504`) —
  a conditional registration with no test.
- `enabled: false` skips all wiring (`index.ts:170-177`).
- The session-extension namespace is registered.

A fake-`api` test that records `api.on` / `api.registerTool` / `api.registerCommand` calls would close
this. The Wave-1 S13 section flagged "manifest accepts, implementation no-ops" as the dominant prior
failure mode — registration is exactly where that bug class lives, and it has no net.

### E-10 — `attemptIndex` never wired; cross-cycle counter staleness untested (P2, test-gap)

`escalating-retry.ts`'s `TurnSignal.attemptIndex` drives the FIRM/FINAL escalation. But
`src/index.ts:542-547` constructs the signal **without** `attemptIndex`, so it always defaults to 0 —
the plugin always emits the *standard* instruction and never escalates to FIRM/FINAL in production.
The escalation resolvers are unit-tested in isolation (`escalating-retry.test.ts:406-458`) but the
*integration* — "does the plugin ever actually escalate?" — is not, and the answer with current wiring
is **no**. The SDK enforces `maxAttempts` via `idempotencyKey`, but the *instruction text* never
escalates because the plugin never feeds back the attempt count. Either the host exposes a retry-count
the plugin should read, or the escalation tiers are effectively dead code. This is a real
parity/behavior gap dressed as a test gap — flagging P2 because the standard instruction still
functions; the escalation is just inert.

### E-11 — Grant-ledger correlation is write-only (P2, parity-gap)

`src/index.ts:255-277` calls `grantLedger.record(...)` on pending-approval transitions and
`grantLedger.prune(...)` on terminal states. But **nothing in `src/` ever calls `grantLedger.get(...)`**
— the lookup the whole class exists for. `grant-ledger.ts:22-23` states the ledger's purpose is *"a
CHEAP lookup by approvalId-only ... useful in hot paths like debug-log emit where the caller has an
approvalId ... and wants to enrich the event with approvalRunId."* That enrichment never happens:
`logPlanModeApprovalTransition` (`index.ts:244-251`) is called with `event.prev`/`event.next` directly
and never consults the ledger. So S11's grant-ledger is currently a correctly-implemented, fully-tested
data structure that is **wired in but never read** — pure overhead. Either wire the `get`-based
enrichment into the debug-log emit path (the documented intent), or document the ledger as
"infrastructure for a future correlation feature, not yet consumed." The process-local nature
(resets on restart) is fine and matches the documented intent — the canonical data lives on the session
row; the ledger is only a cache. No finding on persistence.

---

## `host_ref:` citation audit

All cluster files carry `host_ref:` comments. Findings:

- `escalating-retry-constants.ts` — citations present and **accurate** (verified line ranges).
- `escalating-retry.ts` — present; line range `151-265` is over-broad (see E-3).
- `plan-tier-model.ts` — present and **honest** ("in-host has no centralized model-override file").
- `debug-log.ts` — present but the **"verbatim" claim is false** (see E-2). `host_ref:` line numbers
  (`63-141`, `210-227`, `234-247`, `260-287`) are roughly right but the *content* diverges.
- `grant-ledger.ts` — `host_ref: plan-mode-debug-log.ts:46-62` points at the C7 design-notes comment;
  reasonable since the ledger is a plugin-only construct with no direct in-host counterpart.
- `types.ts` — every type has a `host_ref:`; all verified accurate against in-host `plan-mode/types.ts`.
- `approval-id.ts` — present; "byte-identical" claim is **false by one error string** (see E-7).
- `payload-hash.ts` — `host_ref: exit-plan-mode-tool.ts:353-362` — verified **exact**.
- `sanitize.ts` — `host_ref: plan-mode/types.ts:158-160` — verified **exact**.

No `host_ref: TBD` anywhere (Guardrail #1 satisfied).

---

## Severity roll-up

| Severity | Count | IDs |
|---|---|---|
| **P0** | 0 | — |
| **P1** | 3 | E-1, E-2, E-6 |
| **P2** | 8 | E-3, E-4, E-5, E-7, E-8, E-9, E-10, E-11 |

**Total: 11 findings.**

No P0: the constants are byte-perfect, the helpers are sound, and the gates this cluster touches are
not in scope (S5/S12 are other slices). The P1s are: a stale deferral that has become a silent
divergence (E-1), a false "verbatim" parity claim with a real operator-facing taxonomy mismatch (E-2),
and an unverified-semantics proxy that the entire S7 detector mechanism depends on (E-6).

## Honest-limitation vs silent-divergence ledger (per task spec)

- **Honest limitation (acceptable):** S7 coarse detection collapsing ~7 in-host detectors into 3 — the
  doc block (`escalating-retry.ts:40-59`) and test header own this explicitly. `plan-tier-model.ts`
  being a plugin-invented feature — `host_ref` says so. Grant-ledger process-local — documented.
- **Silent divergence (a finding):** E-1 (deferral rationale expired), E-2 ("verbatim" is false),
  E-4 (provider gating dropped, not in the limitation list), E-6 (`stopHookActive` asserted to mean
  tool-call with no SDK backing), E-7 ("byte-identical" false). E-10 (escalation tiers inert in
  production despite being unit-tested as live).
