# Build-Spec S16 — Channel-Native Plan Approval

**Slice:** S16 (channel-native approval rendering)
**Target plugin:** Smarter-Claw (`/Users/lume/repos/Smarter-Claw`)
**Target host:** OpenClaw `2026.5.18`
**In-host source-of-truth:** `rebase/pr70071-onto-main-2026-04-25` @ `ea04ea52c7` in `/Volumes/LEXAR/repos/openclaw-pr70071-rebase`
**Date:** 2026-05-19
**Status:** SPEC — not implemented

> This is a **build-spec**, not a parity audit. The plugin has zero channel-native
> approval rendering today; this document specifies how to add it.

---

## 0. TL;DR / Verdict

| Question | Answer |
|---|---|
| Does the in-host PR-70071 system render native Approve/Reject **buttons** on Telegram/Slack? | **No.** It never did. PR-13 (native interactive buttons) was explicitly **deferred**. PR-14 shipped a **read-only markdown document attachment** + universal `/plan` **text-command** resolution. |
| Does OpenClaw `2026.5.18` SDK expose a `ChannelApprovalCapability` registration seam a plugin could use? | **Partially — and not for this use case.** `ChannelApprovalCapability` exists but is (a) the **exec/tool-approval** subsystem, `approvalKind: "exec" \| "plugin"` — *no `"plan"` kind*; and (b) only attachable via `ChannelPlugin.approvalCapability`, i.e. only when the plugin **owns the channel plugin**. Telegram/Slack are built-in channels the plugin does not own. **There is no plugin seam to add native interactive buttons to a built-in channel.** |
| Can native Approve/Reject buttons ship in the plugin today? | **No** — not as true inline buttons. The SDK exposes no inbound interactive-callback hook (`callback_query` / Slack `block_actions`) for plugins. Two viable paths exist (§3); the recommended path is a **slash-command UX wrapper + a clarified attachment**, with the true-button path filed as an upstream PR. |
| Does the plan-resume "continue" leak exist on non-web channels? | **No — verified false.** The visible-`continue`-message risk is **webchat-only** and even there `deliver: false` suppresses it. Non-web channels never send a resume message. See §4. |
| LOC estimate (recommended path) | **~260–340 LOC** plugin code across 3 sub-PRs. True-button path adds an upstream PR of unknown size (host-side). |

---

## 1. In-host mechanism — how plan approval works end-to-end

The in-host PR-70071 plan-mode approval flow, traced through the source:

### 1a. Event emission (`exit_plan_mode` → approval event)

`src/agents/pi-embedded-subscribe.handlers.tools.ts` (the `toolName === "exit_plan_mode"` branch, ~line 1838):

1. Agent calls `exit_plan_mode(title, plan, analysis, assumptions, risks, …)`.
2. Runtime mints an `approvalId` via `newPlanApprovalId()` (`crypto.randomUUID()`, ~122 bits — security token).
3. `persistPlanApprovalRequest()` writes `approvalId` + `title` + `lastPlanSteps` **synchronously** to `SessionEntry.planMode` *before* emitting the event (race-fix `1081067476` — eliminates empty-injection race; also de-dupes via `lastPlanPayloadHash`).
4. Runtime emits an `AgentApprovalEventData` with `kind: "plugin"`, `phase: "requested"`, `status: "pending"`, the `approvalId`, the full plan + archetype fields. This is delivered two ways:
   - `emitAgentApprovalEvent(...)` → the structured agent-event bus (webchat / Control-UI overlay subscribe here).
   - `ctx.params.onAgentEvent?.({ stream: "approval", data })` → the inline run-event stream.

> **Plan approval rides the `kind:"plugin"` approval channel, NOT the `kind:"exec"` channel.** The two are distinct: exec-approval is the tool/command-permission subsystem; plan-approval reuses the *event envelope* but is resolved through a different RPC (`sessions.patch { planApproval }`, not the exec-approval gateway).

### 1b. Channel render — **attachment, not buttons**

`src/agents/plan-mode/plan-archetype-bridge.ts` (`dispatchPlanArchetypeAttachment`, void-fired from the same `exit_plan_mode` branch, PR-14):

1. `renderFullPlanArchetypeMarkdown(details)` → a full markdown document.
2. `persistPlanArchetypeMarkdown()` → writes to `~/.openclaw/agents/<agentId>/plans/` (durable audit trail).
3. If the originating session is on a file-attachment-capable channel (**Telegram today; Discord/Slack "later" — never built**), uploads the markdown as a **document attachment** with a short caption.
4. The caption (`buildPlanAttachmentCaption`) is **plain text** ending with:
   `Resolve with: /plan accept | /plan accept edits | /plan revise <feedback>`

The bridge header is explicit: *"Resolution stays text-based via PR-11's universal `/plan` slash commands. This bridge is read-only (visibility), no approval-id translator required — sidesteps the dual-id problem documented in the PR-13 deferral notes."*

A `git grep` of the entire branch for `callback_query` / `answerCallbackQuery` / Slack `block_actions` intersected with `plan`/`approval` returns **zero hits**. **The in-host has no native interactive plan-approval button on any messaging channel.**

### 1c. Button tap — **N/A** (no buttons exist)

There is no button-tap handler. The user types a text command instead.

### 1d. Resolve (`/plan accept` → `sessions.patch` → state machine)

`src/auto-reply/reply/commands-plan.ts` — the universal `/plan` `CommandHandler` (PR-11), cross-channel (Telegram, Discord, Slack threads, Signal, iMessage, CLI):

1. Parses `/plan accept [edits]` / `/plan revise <feedback>` / `/plan answer <text>` / `/plan on|off|status|view|restate|auto on|off`.
2. Authorizes via `resolveApprovalCommandAuthorization` (mirrors `/approve` — operator + `operator.approvals` scope for internal channels).
3. Pre-checks `planMode.approval === "pending"` and a non-null `approvalId` (PR-11 review M1 — avoids a confusing "stale approvalId" gateway error).
4. Calls `callGateway` → `sessions.patch { planApproval: { action, approvalId, feedback? } }`.
5. `src/gateway/sessions-patch.ts` (`"planApproval" in patch` branch, ~line 650) runs `resolvePlanApproval(next.planMode, action, feedback, expectedApprovalId)` — the state machine in `src/agents/plan-mode/approval.ts`:
   - Stale-id guard (mismatched/absent `approvalId` → no-op).
   - Terminal-state guard (`approved`/`edited`/`timed_out` are terminal).
   - `approve`/`edit` → `mode: "normal"`, clears feedback, resets `rejectionCount`.
   - `reject` → `mode` stays `"plan"`, increments `rejectionCount`.
6. On `approve`/`edit`, `sessions-patch.ts` appends a `[PLAN_DECISION]: approved|edited` synthetic injection to the session's injection queue (`appendToInjectionQueue`) via `buildApprovedPlanInjection` / `buildAcceptEditsPlanInjection`. **Single source of truth**: any caller of `sessions.patch { planApproval }` gets the injection — no per-channel wiring.

### 1e. Resume (continue the agent turn)

Two **distinct** resume mechanisms — this is the crux of §4:

- **Webchat:** `ui/src/ui/chat/plan-resume.ts::resumePendingPlanInteraction()` issues `chat.send { message: "continue", deliver: false, idempotencyKey }`. The injection is already persisted; this hidden send only *resumes the run*. **`deliver: false` ⇒ the "continue" text is not echoed into the chat transcript.**
- **Non-web channels (Telegram/Slack/etc.):** `commands-plan.ts` returns **`{ shouldContinue: true }`** from the command handler. The auto-reply / agent-runner pipeline then continues the turn naturally — the `[PLAN_DECISION]` injection is consumed at next turn-start. **No `chat.send "continue"` is ever issued on text channels.** (Pre-PR-11-review-fix, the handler returned `shouldContinue: false` and the agent stalled until an unrelated later message — fixed per Codex P1 #68939.)

---

## 2. SDK seam availability on `2026.5.18`

Verified against `/Users/lume/repos/Smarter-Claw/node_modules/openclaw/dist/plugin-sdk/`.

### 2a. `ChannelApprovalCapability` — exists, but wrong subsystem + wrong attach point

- **Type:** `plugin-sdk/src/channels/plugins/types.adapters.d.ts`:
  ```ts
  export type ChannelApprovalCapability = ChannelApprovalAdapter & {
    authorizeActorAction?: (params: { …; approvalKind: "exec" | "plugin" }) => …;
    getActionAvailabilityState?: (params: { …; approvalKind?: ChannelApprovalKind }) => …;
    getExecInitiatingSurfaceState?: …;
    resolveApproveCommandBehavior?: …;
  };
  ```
- **Resolver:** `plugin-sdk/src/channels/plugins/approvals.d.ts` →
  `resolveChannelApprovalCapability(plugin)` returns `plugin?.approvalCapability`.
- **Attach point:** `ChannelPlugin.approvalCapability` — a field on a **channel plugin object**. Re-exported from `plugin-sdk/src/channels/plugins/index.d.ts`.

**Two blockers:**

1. **Subsystem mismatch.** `approvalKind` is typed `"exec" | "plugin"` — there is **no `"plan"` kind**. The native-approval machinery (`describeDeliveryCapabilities`, `resolveOriginTarget`, `ChannelApprovalNativeRequest = ExecApprovalRequest | PluginApprovalRequest`) targets the exec/tool-permission flow. Plan-mode approval resolves through `sessions.patch { planApproval }`, an entirely separate RPC. `ChannelApprovalCapability` is **not** the plan-approval seam.
2. **Ownership mismatch.** A `ChannelApprovalCapability` is only consumed when it hangs off a `ChannelPlugin` *you registered*. Telegram and Slack are **built-in** channels. The plugin API exposes `registerChannel(...)` — which registers a *brand-new* channel — but **no API to decorate or extend a built-in channel's approval rendering.**

### 2b. The full plugin `register*` surface — no interactive-handler seam

`plugin-sdk/src/plugins/types.d.ts` — `OpenClawPluginApi` exposes exactly these registrars (lines 1972–2112):

`registerSessionExtension`, `registerSessionSchedulerJob`, `registerSessionAction`, `registerControlUiDescriptor`, `registerAgentEventSubscription`, `registerRuntimeLifecycle`, `registerTool`, `registerHook`, `registerHttpRoute`, `registerHostedMediaResolver`, **`registerChannel`**, `registerGatewayMethod`, `registerCli`, `registerNodeCliFeature`, `registerReload`, `registerNodeHostCommand`, `registerNodeInvokePolicy`, `registerSecurityAuditCollector`, `registerService`, `registerGatewayDiscoveryService`, `registerCliBackend`, `registerTextTransforms`, `registerConfigMigration`, `registerMigrationProvider`, `registerAutoEnableProbe`, `registerModelCatalogProvider`, `registerCommand`.

There is **NO** `registerInteractiveHandler`, `registerApprovalRenderer`, `registerChannelApprovalCapability`, `registerCallbackQueryHandler`, or equivalent. `registerHook(events, handler)` takes free-form event strings, but no documented inbound interactive-callback event (`channel.callback_query`, `slack.block_actions`, etc.) is exposed in the SDK type surface — the inbound-message hook literals found (`user_message`, `before_message_write`, …) are text-message hooks, not button-callback hooks.

### 2c. Seam verdict

> **The seam to render native interactive Approve/Reject buttons on a built-in channel (Telegram/Slack) and receive the button-tap callback is MISSING from the `2026.5.18` plugin SDK.**
>
> What *is* available to a plugin:
> - `registerCommand` — cross-channel text commands (already used: `/plan` merged in #93).
> - `registerHook` — text-message hooks (could intercept a typed reply).
> - `registerChannel` — a whole new channel plugin (not applicable to built-in Telegram/Slack).
> - `registerControlUiDescriptor` — webchat sidebar widget (already used).
>
> Native interactive buttons on Telegram/Slack require **either** an upstream OpenClaw PR adding a plugin-facing interactive-callback seam, **or** the plugin shipping its own Telegram/Slack channel plugin via `registerChannel` (a large, duplicative effort — out of scope).

---

## 3. Plugin implementation plan

Because the true-button seam is missing, S16 splits into a **shippable now** track (recommended) and an **upstream-blocked** track.

### Path A — RECOMMENDED: rich text-command approval UX (ship now)

Deliver the *best approval experience the SDK allows today*: webchat keeps its native buttons (already works via `registerControlUiDescriptor`); Telegram/Slack get a polished, discoverable, attachment-backed text-command flow that reaches feature-parity with the in-host (which also never had buttons). This is **not a downgrade** — it matches the in-host's actual shipped behavior.

#### Sub-PR ladder

**S16-1 — Channel-aware approval prompt renderer** (~120–150 LOC)
New file `src/channels/approval-prompt.ts`:
- `renderPlanApprovalPrompt(plan, opts)` — builds a per-channel approval message body:
  - **Webchat:** unchanged — the existing `registerControlUiDescriptor` sidebar + session-action buttons already render. The renderer returns a no-op marker so webchat keeps its native path.
  - **Telegram:** a formatted HTML message — plan title, summary, step checklist, then an explicit, copy-pasteable command block (`/plan accept`, `/plan accept edits`, `/plan reject <feedback>`). Mirrors `buildPlanAttachmentCaption` from the in-host bridge.
  - **Slack:** the same content as Slack `mrkdwn`.
- Subscribe to plan-approval emission via `api.registerAgentEventSubscription` (the plugin already uses `registerSessionExtension` / hooks) OR hook the plugin's existing `exit_plan_mode` tool path in `src/tools/exit-plan-mode.ts` — after the tool persists the approval, dispatch the channel prompt. The plugin already owns `exit-plan-mode.ts`, so this is the cleaner anchor: no new event bus needed.
- The prompt is delivered via the channel's normal outbound reply path (the plugin's tool result / hook can append a reply payload).

**S16-2 — Attachment bridge (optional parity nicety)** (~60–90 LOC)
New file `src/channels/plan-attachment-bridge.ts`:
- Port `dispatchPlanArchetypeAttachment` — render the full archetype markdown, persist under `~/.openclaw/<plugin-data>/plans/`, and (Telegram only, where the SDK outbound supports document attachments) attach it with the S16-1 caption.
- Slack: SDK outbound attachment support for Slack is unverified — gate behind a capability check; fall back to the inline S16-1 message if unsupported.
- This sub-PR is **independent** of S16-1 and can be deferred — S16-1 alone closes the "cannot approve on Telegram/Slack" gap, because `/plan accept` already works (merged in #93).

**S16-3 — Discoverability + reply-driven reject** (~80–100 LOC)
- `src/channels/approval-prompt.ts` extension: after a `reject`, the in-host convention is "the user's next plain text message = revision feedback." Wire a one-shot `registerHook('user_message', …)` armed per-session when `approval === "rejected"`, so a Telegram/Slack user can just type their feedback instead of `/plan reject <feedback>`. Disarm on consumption / on any `/plan` command / on new approval cycle.
- Ensure the S16-1 prompt's command block lists the exact `approvalId`-free commands the plugin's `slash-commands.ts` accepts (verify against `src/ui/slash-commands.ts`).

> All three sub-PRs wire to the **existing** `src/ui/session-actions.ts` handlers — `plan.accept` (`continueAgent: true`), `plan.edit`, `plan.reject` — through the **existing** `/plan` `registerCommand` dispatcher in `src/ui/slash-commands.ts`. **No resolution logic is re-implemented.** S16 is purely a *rendering + discoverability* layer in front of the merged #93 command surface.

### Path B — true native buttons (upstream-blocked)

**S16-U (upstream OpenClaw PR)** — add a plugin-facing interactive seam to the channel SDK:
- A `registerChannelInteractiveHandler({ channels, kind: "approval", render, onCallback })` API, where `render` returns channel-native interactive components (Telegram `inline_keyboard`, Slack `block_actions`) and `onCallback(payload)` receives the button tap.
- Extend `ChannelApprovalKind` to include `"plan"`, or define a parallel `plan-approval` capability so the existing native-approval delivery machinery (`describeDeliveryCapabilities`, `resolveOriginTarget`) can be reused.
- This is a **host-side** change; size unknown until scoped against OpenClaw `main`. File it as a tracked upstream issue referencing PR-13's original deferral.

**S16-B (plugin consumer, gated on S16-U landing)** — once the seam ships, a plugin file `src/channels/native-buttons.ts` registers the interactive handler, maps the tap to `session-actions.ts` handlers. ~120–180 LOC, but **do not start until S16-U merges and the plugin bumps its OpenClaw floor.**

---

## 4. The plan-resume "continue" leak — VERIFIED

**Planning-doc claim:** non-web channels may leak a visible "continue" message after approval.

**Verdict: the leak does NOT exist. Claim is false.**

Evidence (`/Volumes/LEXAR/repos/openclaw-pr70071-rebase` @ `ea04ea52c7`):

- `ui/src/ui/chat/plan-resume.ts::resumePendingPlanInteraction()` is the **only** code path that sends a "continue" message. It is imported solely by `ui/src/ui/chat/slash-command-executor.ts` and `app-chat.ts` / `app.ts` — **all webchat UI files**. No server-side / channel code calls it.
- Even on webchat, that call passes **`deliver: false`** — OpenClaw's documented semantics for a hidden run-resume that is *not* rendered into the chat transcript.
- Non-web channels resume via `commands-plan.ts` returning **`{ shouldContinue: true }`** — a control-flow signal to the auto-reply pipeline, **not a message**. The `[PLAN_DECISION]` injection is consumed silently at next turn-start (`appendToInjectionQueue` in `sessions-patch.ts`).

**Action for the plugin:** none required for a leak fix. The plugin's `plan.accept` handler already returns `continueAgent: true` (`src/ui/session-actions.ts:241`) — the plugin-equivalent of `shouldContinue: true`, the correct non-web pattern. **S16 must NOT introduce a `chat.send "continue"` call on any channel.** If S16-1/S16-3 ever need an explicit resume, use `continueAgent: true` from the action handler — never an outbound message.

One real adjacent concern (not a leak, but worth a one-line guard in S16-1): when S16-1 dispatches the approval *prompt* on Telegram/Slack, ensure it is sent **once** per `approvalId`. The in-host de-dupes via `lastPlanPayloadHash`; the plugin already has `src/helpers/payload-hash.ts` and `src/runtime/grant-ledger.ts` — reuse the hash to suppress a duplicate prompt if `exit_plan_mode` fires twice for the same payload.

---

## 5. LOC estimate + risks

### LOC (Path A — recommended, shippable now)

| Sub-PR | New file(s) | Est. LOC |
|---|---|---|
| S16-1 channel-aware approval prompt renderer | `src/channels/approval-prompt.ts` | 120–150 |
| S16-2 attachment bridge (optional/deferrable) | `src/channels/plan-attachment-bridge.ts` | 60–90 |
| S16-3 discoverability + reply-driven reject | extends `approval-prompt.ts` + a hook | 80–100 |
| **Total (Path A)** | | **~260–340 LOC** |

Path B adds an **upstream host-side PR (S16-U)** of unscoped size + a plugin consumer (S16-B, ~120–180 LOC) — **not estimable** here and **not shippable** in this slice.

### Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Seam genuinely missing** — stakeholders may expect literal tappable buttons; Path A delivers a text-command UX instead. | High (expectation) | This spec documents that the *in-host itself never shipped buttons*. Path A reaches in-host parity. Set expectations explicitly; file Path B upstream. |
| R2 | Slack outbound **attachment / `block_actions`** support via the plugin SDK outbound path is **unverified**. | Medium | S16-2 gates the attachment behind a runtime capability probe; falls back to the inline S16-1 message. Verify `ChannelDeliveryCapabilities` for Slack before S16-2. |
| R3 | Anchoring S16-1 on the plugin's `exit-plan-mode.ts` tool vs. an event subscription — if a future host emits plan-approval without routing through the plugin tool, the prompt is skipped. | Low | The plugin **owns** `enter/exit_plan_mode` (registered via `registerTool`); the approval always originates from the plugin's own tool. Safe anchor. |
| R4 | Duplicate approval prompt if `exit_plan_mode` fires twice. | Low | Reuse `src/helpers/payload-hash.ts` to de-dupe (§4). |
| R5 | Reply-driven reject (S16-3) hook could swallow an unrelated user message. | Medium | One-shot, per-session armed only while `approval === "rejected"`; disarm on any `/plan` command, on consumption, or on new cycle. Mirror the in-host "next message = feedback" convention exactly. |
| R6 | Authorization — text commands must enforce operator scope on internal channels (the in-host gates `/plan` on `operator.approvals`). | Medium | `/plan` resolution already merged in #93 — confirm its handler carries the auth gate; S16 adds rendering only, inherits #93's auth. |

### Recommendation

Ship **Path A, sub-PRs S16-1 → S16-3** (S16-2 optional, deferrable). This closes the stated gap — "on Telegram/Slack a user cannot approve a plan" — because `/plan accept` resolution already works (#93); S16 makes the approval **visible, discoverable, and well-formatted** on those channels, matching the in-host's actual shipped behavior. File **Path B (S16-U)** as a separate upstream OpenClaw issue/PR; do not block S16 on it.
