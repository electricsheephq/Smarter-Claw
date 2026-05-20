# Wave 1 — Consolidated Findings Catalog

**Date**: 2026-05-13
**Plan**: parity-refresh + release-readiness, Wave 1.
**Inputs**: 5 slice-audit reports (A–E), 3 build-specs (S16/S17/S18+S9), 1 benchmark.
**Audit base**: plugin `main` post-#93 post-Wave-0; in-host source-of-truth `ea04ea52c7`; host `2026.5.18`.

This catalog is the actionable input to **Wave 3 (Fix)**. Findings are
grouped by **file-cluster** so Wave 3 can sequence PRs without merge
collisions.

---

## Headline

| Severity | Count | Meaning |
|---|---|---|
| **P0** | 2 | user-visible breakage class — both UX, neither a correctness/security regression |
| **P1** | 17 | real, bounded — mostly "ported but never wired" + cross-platform gaps |
| **P2** | ~30 | polish, test-gaps, stale citations |

**Zero P0 correctness or security regressions.** The gates are
byte-identical to in-host; the 10 `persistApprovalRequest` invariants
are all present + correct; the system-prompt block is byte-identical
(verified by execution-diff). The security + state core is sound.

**The dominant defect class: "ported but never wired."** Five separate
findings (A5, C-1, D1, E-10, E-11) are in-host functions copied
byte-faithfully into the plugin and then *never called* — or wired to
the wrong consumer. This is the precise "port not done correctly"
pattern: file-level copying without integration.

**Two withdrawn findings** (prior audits were wrong):
- Wave-1 "S12 P0 #2" (plain-Accept bypasses the accept-edits gate) —
  **misdiagnosis**. In-host `sessions-patch.ts:982-993` confirms plain
  Accept does NOT grant `acceptEdits` either. PR #90's trigger fix is
  correct in-host parity. Withdrawn.
- The `plan-resume` "visible continue-message leak on text channels" —
  **verified false**. `resumePendingPlanInteraction` is webchat-only
  and uses `deliver: false`. Withdrawn.

---

## P0 findings

| ID | Type | Cluster | Description | Fix |
|---|---|---|---|---|
| **W1-P0-1** (BENCH-F1) | missing-feature | ui/session-actions | A pending plan sits `pending` with NO notification — the reference card even suppresses `[PLAN_NUDGE]` while pending. Codex shows action-required terminal titles + mobile push; Claude Code rings a bell. On Telegram/Slack the user gets no signal a plan is waiting. | **Deferred — SDK blocker.** See `blocker-W1-F1.md`. The audit's "no SDK seam needed" is incorrect on `2026.5.18`: every push-to-channel SDK seam (`sendSessionAttachment`, `emitAgentEvent` on `approval` stream) rejects 3P plugins with `origin !== "bundled"`. Plugin already declares the sidebar surface (covers Codex desktop / webchat) + persists the plan markdown (W1-F2 — the building block a future notifier would attach). Telegram/Slack gap remains until a host capability is added (R1: lift bundled gate behind a manifest capability; R2: add `sendActionRequiredNotice`; R3: host emits on plugin's behalf). |
| **W1-P0-2** (BENCH-F2) | bug | prompt | The archetype prompt + reference card tell the model its `title` becomes a persisted `plan-YYYY-MM-DD-<slug>.md` file. **No code writes that file.** The prompt lies to the model. | Either write the markdown file on approval, OR remove the persistence claim from the prompt. Prefer writing it (matches in-host intent). |

---

## P1 findings — grouped by file-cluster

### Cluster: tools (`src/tools/*`, `src/plan-mode/tool-descriptions.ts`, `auto-enable.ts`)

| ID | Type | Description | In-host ref |
|---|---|---|---|
| **W1-A5** | parity-gap | `evaluateAutoEnableForMatch` (`src/plan-mode/auto-enable.ts`) is a byte-identical port but is **never called** anywhere in `src/`. A configured `agents.defaults.planMode.autoEnableFor` does nothing. The file header falsely claims it "restores that capability." | in-host wires it into the cron isolated-agent path |
| **W1-A3** | parity-gap | `ask_user_question` tool description is a ~70-word paraphrase. In-host `describeAskUserQuestionTool()` is a 7-clause structured description (USE FOR / DO NOT USE FOR lists, `allowFreetext` pointer). Same drift class PR #87 fixed for enter/exit. | `tool-description-presets.ts` |
| **W1-A1** | parity-gap | `exit_plan_mode`'s tool description PROMISES "the runtime rejects submission … listing pending child run ids" if subagents are in flight. The plugin has NEITHER the tool-side subagent gate NOR a gateway-side one. The description lies. | `exit-plan-mode-tool.ts` subagent gate |

### Cluster: state (`src/state/store.ts`)

| ID | Type | Description | In-host ref |
|---|---|---|---|
| **W1-C1** | parity-gap | `applyApprovalAction` (`store.ts:571`) calls `resolvePlanApproval(current, action, feedback)` with the 4th arg `expectedApprovalId` **omitted**. The plugin re-ported `resolvePlanApproval` byte-identically *including* its stale-event guard — but the mutators never thread the approval token, so the guard is dead code. A stale/cross-surface Approve resolves regardless of which `approvalId` the UI event carried. | `sessions-patch.ts:940` passes it |

### Cluster: prompt + injection (`src/prompt/*`, `src/runtime/injection-writer.ts`, `src/ui/session-actions.ts`)

| ID | Type | Description | In-host ref |
|---|---|---|---|
| **W1-D1** | parity-gap | The plugin emits `[PLAN_DECISION]: rejected` via `buildPlanDecisionInjection` — a byte-faithful port of an in-host function that has **zero non-test callers**. The in-host runtime reject path (`sessions-patch.ts:1045-1050`) builds a thinner 2-line form with raw (not JSON-quoted) feedback + `@channel`/`<@` mention-stripping. The plugin's runtime emitter is not in-host-parity. | `sessions-patch.ts:1045-1050` |
| **W1-D2** | bug | `planStepsToInjectionLines` (`session-actions.ts:69-79`) appends each step's `status` enum; the in-host (`sessions-patch.ts:1002-1004`) appends `activeForm` (the gerund). The plugin reads the wrong field. Outputs coincide only for fresh all-`pending` plans — they diverge for any resumed/re-approved plan. | `sessions-patch.ts:1002-1004` |
| **W1-D3** | test-gap | No byte-fixture test pins the prompt artifacts against in-host bytes. Docstrings reference a `tests/parity/archetype-prompt-parity.test.ts` that **does not exist**. Every prompt test is `.toContain()` or a wide length window — a paraphrase ships green. | — |

### Cluster: runtime + foundation (`src/runtime/*`, `src/index.ts`)

| ID | Type | Description | In-host ref |
|---|---|---|---|
| **W1-E6** | bug | The 3-detector escalating-retry mechanism keys off `madeToolCall`, which `index.ts:539` derives as `event.stopHookActive === true`. `stopHookActive` signals hook re-entrancy, **not** whether a tool ran. A real tool-call turn gets `madeToolCall=false` → spurious retry on a turn that already acted. The new `messages[]` field on `before_agent_finalize` (2026.5.18) is the correct signal. | `incomplete-turn.ts` |
| **W1-E1** | parity-gap | The S6 turn-limit watchdog is documented as "deferred — needs `registerSessionSchedulerJob`". That seam **now ships** (`2026.5.18` `types.d.ts:1982`, `api.session.workflow`). The deferral is stale; the unbounded auto-mode-rejection loop it prevents is a marketed use case. | — |
| **W1-E2** | bug | `debug-log.ts` claims a "verbatim port" of the in-host event union but 4 of 8 kinds diverge: `nudge_event`→`nudge_phase`, `toast_event`→`ui_toast`, `tool_call` drops `runId` (breaks C7 correlation), `approval_event` dropped entirely. | `plan-mode-debug-log.ts` |

### Cluster: ui-surfaces (`src/ui/*`)

| ID | Type | Description | In-host ref |
|---|---|---|---|
| **W1-S9-2** | bug | `session-actions.ts` `checkApprovalId` rejects any action when `approval !== "pending"`. But the re-ported `resolvePlanApproval` (`approval.ts:83`) treats `rejected` as **non-terminal** — re-approvable. The plugin's own session-action guard contradicts the state machine it dispatches to. | `approval.ts:83` |
| **W1-S9-1** | parity-gap | The sidebar `PluginControlUiDescriptor` schema omits 5 fields the store actually writes: `enteredAt`, `confirmedAt`, `updatedAt`, `approvalRunId`, `lastPlanPayloadHash`. | — |
| **W1-S18-1** | bug | Telegram caps its native slash menu at 100 commands; the gateway has 122 configured; plugin commands are in the dropped tail. `/plan` + `/plan-mode` may be **invisible** on Telegram's "/" autocomplete (functionality survives via the text pipeline). This is the most plausible match for the reported "doesn't work on Telegram." | — |
| **W1-B4** | test-gap | The accept-edits trigger predicate (`approval === "edited"`) has **zero CI-runnable test** — coverage is an Eva live-smoke not in CI. A refactor re-breaking the predicate (the exact thing PR #90 fixed) ships green. | — |

### Cluster: benchmark gaps (cross-cutting)

| ID | Type | Description |
|---|---|---|
| **W1-F3** | missing-feature | No multi-surface approval — Approve/Edit/Reject buttons are sidebar-only. Telegram/Slack users get no interactive card. (Inline cards are upstream-SDK-blocked; a channel ping is not.) **2026-05-20: DEFERRED — SDK blocker (same as W1-F1).** The "channel ping" parenthetical was over-optimistic — every push-to-channel SDK seam on `2026.5.18` is `bundled-plugin-only`. See `blocker-W1-F3.md`. Resolution path (`/plan accept|reject|cancel|edit|answer`) ALREADY works on every channel via the universal text pipeline; the PUSH (proactive "plan ready" message) is what's blocked. |
| **W1-F4** | bug | `/plan auto on` flips an `autoApprove` flag that **does nothing** — the runtime that fires auto-approve "lands at P-final". A non-functional safety-relevant control. Wire it or hide it. |
| **W1-F5** | parity-gap | `/plan answer` cannot resolve a pending `ask_user_question` on Telegram/Slack — needs plugin-side question-state tracking (also flagged as a known gap in #93). **2026-05-20: IMPLEMENTED.** Added `PendingQuestion` field to `PlanModeSessionState`; added `persistPendingQuestion` + `clearPendingQuestion` store mutators; wired `ask_user_question` tool to persist on success; wired `/plan answer <text>` in `slash-commands.ts` to read store + dispatch `plan.answer`. Membership guard (`allowFreetext === false` → answer must be in `options`) mirrors in-host `sessions-patch.ts:721-732`. Idempotency: store clears slot on dispatch success; injection-writer dedups on `questionId`. |

---

## P2 findings

~30 P2s across the 5 slice audits + S9 — stale `host_ref:` citations
(A: 3 misleading; D4; S9-3 cites a non-existent command), `apply_patch`
extractor called unconditionally (B1), filePath-extraction priority
drift (B2), `InMemoryGateway` lock granularity (C-2), no real-gateway
round-trip test (C-4), FIRM/FINAL escalation tiers inert because
`attemptIndex` is never fed (E-10), grant-ledger wired write-only —
`get` never called (E-11), idempotency-key `:${decision}` suffix vs
in-host upsert-by-`approvalId` (D5), etc. Full detail in the per-slice
reports. Wave 3 triages P2s (fix-now vs defer-with-issue).

---

## Build-specs (Wave 4 + Wave 5 inputs)

### S16 — channel-native approval (`buildspec-S16-channel-native.md`)

**Key reframe**: in-host PR-70071 itself **never rendered native
interactive buttons on Telegram/Slack** — PR-13 deferred it; the
in-host shipped a read-only markdown attachment + the universal
`/plan accept|revise` text commands. So "in-host parity" for
cross-platform = working `/plan` commands + a visible approval prompt,
NOT native buttons.

**SDK seam**: `ChannelApprovalCapability` exists on `2026.5.18` but is
the exec/tool-approval subsystem (`approvalKind: "exec" | "plugin"` —
no `"plan"`) and attaches only via channel ownership. True native
plan-approval buttons on built-in Telegram/Slack **need an upstream
OpenClaw PR**. Path A (shippable now, ~260-340 LOC): channel-aware
approval-prompt renderer + markdown bridge + reply-driven reject.

### S17 — webchat inline UI (`buildspec-S17-webchat-ui.md`)

The arch-v2 `10-UI_GAP_ANALYSIS.md` 25-element catalog is **still
valid** (LOC counts re-verified). 4 components: mode-switcher chip,
plan-cards, plan-approval-inline, plan-resume — **~2,595 LOC total**
(6-PR ladder). **Biggest risk**: upstream PR `#80982` is still OPEN
and its API drifted — the patcher manifest cherry-picks a stale
"3-named-surface" design; the live PR is now a `registerChatStreamRenderer`
seam. Also the content-hashed bundle names already rotated
(`2026.5.18` ships `loader-CxUWY2_6.js`, not the manifest's
`loader-DdN5GTsW.js`). The patcher MUST be regenerated and may need
re-porting when `#80982` merges.

**Wave 5 status: deferred → `blocker-W1-S17-webchat-ui.md`.** Wave-5
consolidation (2026-05-20) re-verified: PR #80982 still OPEN, no
review decision, last touched 2026-05-12 — unchanged since the
catalog tip. SDK at `2026.5.18` exposes only the
`"session" | "tool" | "run" | "settings"` Control-UI surfaces
(`node_modules/openclaw/dist/plugin-sdk/src/plugins/host-hooks.d.ts:72-74`);
no `chat-message`/`chat-input-bar`/`chat-input-toolbar-chip`, no
`registerChatStreamRenderer`. Existing patcher manifest targets
`loader-DdN5GTsW.js` + `protocol-BBwaRnfZ.js` — neither file exists
in the installed `2026.5.18` (both renamed via content-hash). Work
is upstream-blocked, tracked in
[electricsheephq/Smarter-Claw#78](https://github.com/electricsheephq/Smarter-Claw/issues/78).
**Interim posture**: the sidebar `PluginControlUiDescriptor`
(Wave 3, `src/ui/sidebar-descriptor.ts`) renders the approval card
on webchat/desktop; cross-surface `/plan` commands (Wave 3,
`src/ui/slash-commands.ts`) resolve a pending plan from any channel;
W3-F2 plan-markdown persistence is shipped. The webchat-inline gap
is a UX enhancement, not a correctness blocker.

### S18 — per-channel /plan routing (`buildspec-S18-S9-commands-ui.md`)

`/plan` works on webchat YES, Telegram YES (text pipeline, Path A),
Slack UNKNOWN (Slack plugin not installed locally to confirm — the
universal path almost certainly works). The Telegram-menu-visibility
risk is catalogued as W1-S18-1 above.

---

## What this means for the waves

- **Wave 3 (Fix)** closes the 2 P0 + 17 P1. The "ported but never
  wired" cluster (A5, C-1, D1, E-10, E-11) is fast — the code exists,
  it just needs connecting + a test. The behavioral bugs (D2, E-6,
  E-2, S9-2) are the careful ones.
- **Wave 4 (cross-platform)** uses the S16 build-spec — and now knows
  the honest target is `/plan` + markdown + a ping, with native
  buttons as a separate upstream-gated enhancement.
- **Wave 5 (webchat UI)** uses the S17 build-spec — and must resolve
  the `#80982` upstream-PR drift before the patcher work.
- **Benchmark verdict**: Smarter-Claw's enforcement core (mutation
  gate, accept-edits gate, escalating retry, archetype steering)
  genuinely beats Codex + Claude Code. It loses on the last-mile
  surface — notification, multi-surface, plan persistence. All but
  the inline cards are fixable without a new SDK seam.
