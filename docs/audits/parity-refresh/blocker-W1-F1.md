# Blocker — W1-F1 (P0) action-required notification on pending plan

**Status:** **blocked — fix requires an SDK change.** The audit's claim
"wire an action-required signal in the session-action layer (no SDK
seam needed)" rests on an SDK affordance that does not exist for 3P
plugins. Every push-to-channel seam the in-host uses to surface a
pending plan to Telegram/Slack/etc. is gated `bundled-plugin-only`.
Smarter-Claw is a 3P plugin and is silently rejected by the host at
call time. A faithful fix needs **one of three** SDK changes (listed
in § Recommendation). This doc records what was searched, why the
existing seams don't fit, and a minimal interim posture that does NOT
overpromise.

**Issue:** W1-F1 in `wave-1-catalog.md` + `benchmark-codex-claude-code.md` F1.

**Decision date:** 2026-05-20.

**Investigator:** parity-refresh W1-F1 worker (read-only against
in-host `/Users/lume/repos/openclaw-pr70071-rebase` tip `ea04ea52c7`;
plugin against working tree on the same date; SDK `openclaw@2026.5.18`
per `package.json`).

## Audit's claim, restated

`benchmark-codex-claude-code.md` F1 (lines 80-100) says:

> "**Recommendation: ADOPT.** Highest-leverage, lowest-risk gap. (a)
> Set an 'action-required' terminal/window title or emit an OS bell on
> `persistApprovalRequest`. (b) On channel surfaces (Telegram/Slack),
> send a short 'Plan ready for your approval — /plan accept | reject'
> message when the approval is persisted. This needs no new SDK seam
> — the session-action layer already knows the moment the plan goes
> pending. **Wave-1 priority: P0.**"

Premise (a) ("OS bell / terminal title") is correct for an in-host
runtime — `pi-embedded-runner` writes the terminal title directly.
The plugin runs **inside** the host process; it has no terminal of
its own and no SDK affordance for the OS bell. Out of scope unless the
host adds a `notifyOperator({ kind: "action-required" })` seam (#
recommendation R3).

Premise (b) ("channel surfaces, no new SDK seam needed") is **wrong**
on the available SDK. Detail below.

## What the in-host does today

`/Users/lume/repos/openclaw-pr70071-rebase` at `ea04ea52c7`:

- **Cross-channel push for plan-pending lives in
  `src/agents/plan-mode/plan-archetype-bridge.ts:124-200`** —
  `dispatchPlanArchetypeAttachment`. The contract:
  1. Renders the plan archetype as markdown
     (`renderFullPlanArchetypeMarkdown`).
  2. Persists it to `~/.openclaw/agents/<agentId>/plans/` (always).
  3. Reads `deliveryContext` for the originating session. If channel
     is **`telegram`** AND `to` is present, calls
     `sendDocumentTelegram(dctx.to, absPath, { caption, parseMode:
     "HTML" })`. The caption includes `/plan accept | /plan accept
     edits | /plan revise <feedback>`.
  4. **All other channels (Slack, Matrix, Discord, etc.) — falls
     silent at the `dctx.channel !== "telegram"` guard.**
- **Call site**: `src/agents/pi-embedded-subscribe.handlers.tools.ts:1925-1949`
  void-fires `dispatchPlanArchetypeAttachment` immediately after
  `emitAgentApprovalEvent`. The approval event itself goes to UI
  subscribers (Codex app-server, webchat); channels are NOT subscribed
  to the `approval` stream (verified — `git grep -E "onAgentEvent|
  registerAgentEventSubscription" extensions/telegram/`,
  `extensions/slack/`, `src/channels/`: 0 matches).
- **There is no in-host "action-required" terminal title for plan-mode
  approvals.** `git grep -i "action.required\|actionRequired"` across
  `src/agents/plan-mode/`, `src/agents/pi-embedded-runner/`,
  `src/auto-reply/`, `src/channels/`, `src/notify*`: 0 matches in the
  plan-mode subtree (matches in `infra/exec-approval-*.ts` belong to
  the exec-approval routing path, a separate `ChannelApprovalKind`).
  The audit's "Codex shows action-required terminal titles" is true
  for Codex CLI but **not present in the in-host plan-mode runner** —
  the in-host's user-visible notification mechanism is the Telegram
  document push above, full stop.
- **Plan-nudge crons** (`src/agents/plan-mode/plan-nudge-crons.ts`)
  schedule MODEL-FACING nudges (10/30/60 minutes) that wake the agent
  if it stalls. **`buildActivePlanNudge`
  (`src/infra/heartbeat-runner.ts:749`) EXPLICITLY SUPPRESSES the
  nudge when `planMode.approval === "pending"`** (line 769-772, PR-12
  Bug A2: "Otherwise the cron fires an agent turn that interrupts the
  user's resolve-the-card flow"). The plugin's reference card
  (`src/prompt/reference-card.ts:61, 93`) accurately documents this
  suppression. So `[PLAN_NUDGE]` is **not** an action-required signal
  — it is the opposite, an agent self-prod that is muted while the
  user owns the next move.

**Net**: in-host action-required for plan-mode = "send a Telegram
document via `sendDocumentTelegram` to the originating chat." Full
stop. Nothing else. Slack / Matrix / Discord users on the in-host
**also** get no signal — the audit's "On Telegram/Slack the user gets
no signal" is half-right (Telegram has a signal in-host; Slack does
not, even in-host).

## What SDK seams are available to the plugin

`node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts` and
`host-hooks.d.ts` (SDK `2026.5.18`):

### 1. `api.session.workflow.sendSessionAttachment` — bundled-only

- **Type** (`host-hooks.d.ts:186-204`): accepts `sessionKey`, `files:
  PluginSessionAttachmentFile[]` (REQUIRED, ≥1), `text` (caption),
  `channelHints` (Telegram parseMode, Slack threadTs). Result is
  `{ ok: true, channel, deliveredTo, count } | { ok: false, error }`.
- **Runtime** (`/Users/lume/repos/openclaw-pr70071-rebase/src/plugins/host-hook-attachments.ts:213-218`):
  > ```ts
  > if (params.origin !== "bundled") {
  >   return { ok: false, error: "session attachments are restricted to bundled plugins" };
  > }
  > ```
- Confirmed in the installed runtime:
  `grep -E "session attachments are restricted" node_modules/openclaw/dist/loader-*.js`
  → matches the literal error string.
- Smarter-Claw's `PluginOrigin` is `global` or `workspace` (set by
  loader at install-time, NEVER `bundled` for a 3P plugin). Call would
  return `{ ok: false }` 100% of the time.

### 2. `api.agent.events.emitAgentEvent` — host streams reserved

- **Type** (`host-hooks.d.ts:128-134`): `{ runId, stream, data, sessionKey? }`.
- The in-host emits `stream: "approval"` for plan submits
  (`src/infra/agent-events.ts:668-677` —
  `emitAgentApprovalEvent`). UI subscribers (Codex app-server,
  webchat) listen to this stream.
- **Runtime gating**
  (`/Users/lume/repos/openclaw-pr70071-rebase/src/plugins/agent-event-emission.ts:64-72`):
  > ```ts
  > if (params.origin !== "bundled" && HOST_OWNED_AGENT_EVENT_STREAMS.has(stream)) {
  >   return { emitted: false, reason: `stream ${stream} is reserved for bundled plugins` };
  > }
  > if (params.origin !== "bundled" && !isPluginOwnedAgentEventStream(params.pluginId, stream)) {
  >   return {
  >     emitted: false,
  >     reason: `stream ${stream} must be scoped to plugin ${params.pluginId}`,
  >   };
  > }
  > ```
- `HOST_OWNED_AGENT_EVENT_STREAMS` = `{lifecycle, tool, assistant,
  error, item, plan, approval, command_output, patch, compaction,
  thinking, model}`. **`approval` is host-owned.** 3P plugins can
  only emit `stream: "smarter-claw"` or `stream: "smarter-claw.*"`,
  which UI surfaces do not subscribe to.
- The plugin DOES already declare the sidebar surface
  (`src/ui/sidebar-descriptor.ts` →
  `api.session.controls.registerControlUiDescriptor`). That covers the
  webchat / Codex desktop surface. **It does NOT push to Telegram /
  Slack** — those don't poll Control UI descriptors.

### 3. `api.session.workflow.scheduleSessionTurn` — fires future agent turns

- **Type** (`host-hooks.d.ts:213-232`): `{ sessionKey, message, at |
  delayMs | cron, agentId?, deliveryMode?: "none" | "announce", ... }`.
- This **fires a future agent turn** with `message` injected. The
  agent reads the message, generates a response, and **the response is
  delivered to whatever channel the session is bound to**. So
  technically, scheduling a turn that says "post a one-line
  notification that the plan is awaiting approval" WOULD reach the
  channel — via the agent's outbound reply.
- **Why this is not a fix:**
  1. **Latency.** No delay shorter than the cron-runner granularity
     (~seconds). The audit's "moment the plan goes pending" requires
     synchronous push, not "1 minute later."
  2. **Token cost.** Each fire burns one full agent turn (model
     inference + token spend) just to produce a notification line.
  3. **Compliance is probabilistic.** The agent may not produce the
     terse notification the user needs; it may try to revise the plan
     instead, or argue, or stall. The plugin's own `enter_plan_mode`
     description tells the model "Do not ask the user for facts you can
     discover locally" — a notification-only turn cuts against the
     plugin's own steering.
  4. **Cooldown collision.** The model is meant to be IDLE while the
     user owns the approval (`buildActivePlanNudge` suppresses the
     existing plan-nudge for exactly this reason). Scheduling a turn
     re-engages the model just to wait for the user — interrupting the
     hand-off.
  5. **No native push.** Even when the turn fires and the agent
     replies, the message reaches the channel as a normal assistant
     message — Telegram's chat notification, but NOT a structured
     "action-required" marker / mobile push priority hint / inline
     reply-buttons attachment. Functionally identical to the agent
     having said "still waiting on you" — which the agent could already
     do via the existing tool-result text path **except** the plugin
     tells it to STOP AFTER `exit_plan_mode`
     (`src/plan-mode/tool-descriptions.ts:71` — "do NOT emit any
     further assistant text in the same turn"). Removing that hard-stop
     to enable notification would re-introduce the iter-2 Bug A class
     ("agent emits chat text after exit_plan_mode") the description
     was added to prevent.

### 4. `api.session.workflow.enqueueNextTurnInjection` — model-facing, not user-facing

- Already used by the plugin
  (`src/runtime/injection-writer.ts:144-188` —
  `enqueuePlanDecisionInjection`).
- Injects context into the agent's NEXT turn. **But `exit_plan_mode`
  is the END of the agent's turn** — the agent isn't running again
  until the user acts. The injection sits in the queue, drains the
  next time the session runs the agent. It is not a channel push.
- Even if the agent runs immediately (e.g. autoApprove fires), the
  user sees the agent's APPROVED-PLAN execution, not a "pending"
  notification.

### 5. `api.session.workflow.registerSessionSchedulerJob` — cleanup-only

- Already documented in `blocker-W1-E1.md`: cleanup metadata only, no
  fire / tick primitive. Not a scheduler.

### 6. `api.registerCommand` / `api.registerChannel` — won't help

- `registerCommand` creates user-callable slash commands. Already used
  by `src/ui/slash-commands.ts` for `/plan` (Telegram-eligible). A
  command is a USER-INITIATED entry point — it does not let the plugin
  push proactively.
- `registerChannel` declares a NEW channel plugin (the plugin would
  be a Telegram / Slack provider itself, not "a plugin that uses
  Telegram / Slack"). Out of scope and architecturally wrong for
  Smarter-Claw.

### 7. `displaySummary` / tool-result text — suppressed on channels

- The agent tool `exit_plan_mode` returns
  `content: [{ type: "text", text: "Plan submitted for approval..." }]`.
- In-host (`/Users/lume/repos/openclaw-pr70071-rebase/src/auto-reply/reply/dispatch-from-config.ts:917-926`):
  > "Group/native flows intentionally suppress tool summary text..."
- On Telegram/Slack the tool-result text is dropped at the auto-reply
  layer. Only assistant message text reaches the channel. Since the
  plugin's tool description tells the model to STOP AFTER the call,
  there is no assistant message after `exit_plan_mode` either.

## Why the audit's "session-action layer" path doesn't apply

The audit cites "the session-action layer already knows the moment
the plan goes pending." That is true — `src/state/store.ts ::
persistApprovalRequest` runs synchronously inside `exit_plan_mode`'s
tool-call body (`src/tools/exit-plan-mode.ts:579-585`). The plugin
KNOWS. The problem is the plugin has nothing to **call** with that
knowledge.

The "session-action layer" in `src/ui/session-actions.ts` handles
operator-INBOUND requests (`plan.accept`, `plan.reject`, ...). It is
not a push surface. Adding an outbound push to it would still need
one of the SDK seams above to deliver the message — which we just
ruled out.

## Recommendation

**Defer to issue, blocked on SDK change. Three options, ranked by
how much code the plugin can write today:**

### R1 (preferred) — lift the `bundled` gate on `sendSessionAttachment`

- **Change**: drop or soften the `origin !== "bundled"` rejection in
  `src/plugins/host-hook-attachments.ts:216-218`. The check exists to
  prevent random 3P plugins from sending files to arbitrary chats; a
  scoped permission (e.g. a manifest field
  `capabilities: ["sendSessionAttachment"]` + an operator opt-in at
  install time) would let trusted plugins like Smarter-Claw use the
  seam without removing the safety net entirely.
- **Plugin code that becomes possible** (~30 LOC):
  ```ts
  // In src/tools/exit-plan-mode.ts, right after persistPlanArchetypeIfConfigured:
  if (r.kind === "persisted" && opts.attachmentNotifier && absPath) {
    void opts.attachmentNotifier.send({
      sessionKey, files: [{ path: absPath }],
      text: `Plan ready for your approval — /plan accept | /plan revise <feedback>`,
      channelHints: { telegram: { parseMode: "HTML" } },
    });
  }
  ```
  Dedup is automatic (fires once per `persisted` outcome — same
  trigger as W1-F2's persister). Resume safety is automatic (the
  pre-existing W1-F2 code only writes once per cycle, so the notifier
  doesn't fire on resume either).
- **Result**: Telegram users get a Telegram document push (parity
  with in-host today). Slack users get a Slack file upload (BETTER
  than in-host today). Webchat users still see the sidebar (unchanged).

### R2 — add a plan-specific approval-channel push seam

- New SDK method, e.g.
  `api.session.workflow.sendActionRequiredNotice({ sessionKey,
  kind: "plan_approval", message, actions?: [{label, command}] })`.
- Host adapter routes per-channel: Telegram → text message with HTML
  buttons; Slack → blocks API with action buttons; webchat → reuses
  the existing approval-card; CLI → terminal bell. The plugin emits
  ONE call; the host fans out.
- More code than R1 (host needs per-channel adapters) but avoids
  giving 3P plugins generic attachment access.

### R3 — host emits the notification on the plugin's behalf

- Move the `dispatchPlanArchetypeAttachment` equivalent into the host
  itself, triggered when a `session.state` extension with
  `planMode.approval === "pending"` is written. The plugin owns state
  + tool; the host owns delivery. No plugin code change.
- Highest decoupling, hardest to ship (cross-cuts host concerns the
  in-host today keeps in the plan-mode runtime).

### Interim posture this PR ships

**Pure documentation. No production code change.**

1. **This blocker doc**. The honest record.
2. **A short comment near `persistPlanArchetypeIfConfigured`
   call-site** (`src/tools/exit-plan-mode.ts`, near line 609) noting
   that the persisted markdown is the BUILDING BLOCK an
   action-required notifier would attach — and that the notifier is
   blocked on R1/R2/R3.

The plugin **already** declares the sidebar surface (covers Codex
desktop / webchat). The Telegram/Slack gap is real and remains. The
plugin **already** persists the plan markdown (W1-F2), which is the
artifact a future notifier would attach.

A user-visible mitigation **outside** the plugin: the operator can
hand-wire a Telegram-bot script that polls `~/.openclaw/agents/<agentId>/plans/`
for new files and posts a "Plan ready" message to the bot's chat. Not
a fix; an interim if the user needs Telegram visibility before R1/R2/R3
lands.

## Tracking

- W1-F1 row in `wave-1-catalog.md`: needs severity + rationale update
  pointing here.
- `EXECUTION-STATUS.md`: move W1-F1 from "ready to implement" to
  "deferred — SDK blocker" with link to this doc.
- **Upstream issue**: file an SDK-change request for R1 (lift the
  bundled gate behind a manifest capability) on the openclaw repo. R1
  is the smallest change that unblocks both W1-F1 and the Wave-3 F2
  Telegram-bridge port (also blocked by the same `bundled`-only
  affordance).

## Lessons

- **The audit's "no new SDK seam needed" is too optimistic.** It
  conflated "the plugin can read the state" (true) with "the plugin
  can push to the channel" (false on `2026.5.18`).
- **`bundled-plugin-only` seams are second-class for parity.**
  Every in-host capability behind a `bundled` gate is **uncopyable**
  by a 3P plugin without an SDK change. The fact-finding step for any
  parity audit needs to grep `origin !== "bundled"` in the SDK runtime
  before claiming "no new seam needed."
- **The in-host's Telegram-only push is itself a limitation, not a
  ceiling.** "Match the in-host" for W1-F1 means matching Telegram and
  inheriting the Slack/Matrix/Discord gap. R2 above is the better
  long-term answer because it covers the in-host gap too.
