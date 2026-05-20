# Blocker — W1-F3 (P1) multi-surface approval push on Telegram/Slack

**Status:** **blocked — same SDK gap as W1-F1.** The audit's claim
"Inline cards are upstream-SDK-blocked; a channel ping is not" rests
on a delivery affordance that does not exist for 3P plugins. The only
SDK seams that would let the plugin push an action-required
notification to Telegram/Slack — `sendSessionAttachment` and
`emitAgentEvent` on host-owned streams (`approval`, `lifecycle`,
`assistant`, etc.) — both reject 3P plugins at call time on
`openclaw@2026.5.18`. F3 inherits the W1-F1 verdict.

**Issue:** W1-F3 in `wave-1-catalog.md` line 98.

**Decision date:** 2026-05-20.

**Investigator:** parity-refresh Wave-4 worker (read-only against
in-host `/Users/lume/repos/openclaw-pr70071-rebase` tip `ea04ea52c7`
via the openclaw-1 worktree; plugin against the working tree on the
same date; SDK `openclaw@2026.5.18` per
`/Users/lume/repos/Smarter-Claw/package.json:openclaw`).

## Audit's claim, restated

`wave-1-catalog.md` row W1-F3 (line 98):

> "**W1-F3** | missing-feature | No multi-surface approval —
> Approve/Edit/Reject buttons are sidebar-only. Telegram/Slack users
> get no interactive card. (Inline cards are upstream-SDK-blocked; a
> channel ping is not.)"

The first half (no inline buttons → upstream-SDK-blocked) is
**correct** — `docs/audits/parity-refresh/buildspec-S16-channel-native.md`
§2 already documents the missing
`registerChannelInteractiveHandler` seam. The Path-A spec there
(rich text-command UX + attachment bridge) is the shippable scope.

The second half (a channel ping IS unblocked) is **wrong** on the
same SDK as W1-F1. The "ping" the audit envisions (a synchronous
"plan ready for your approval" message pushed to the Telegram chat /
Slack workspace at the moment the plan goes pending) needs the SAME
two SDK affordances W1-F1 needs, and runs into the SAME two
restrictions. The investigation below records what was checked, the
empirical evidence in the installed runtime, and a recommendation
that consolidates with the W1-F1 / S16-U upstream PR work.

## What the in-host does today

`/Users/lume/repos/openclaw-pr70071-rebase` at `ea04ea52c7` (verified
via the `openclaw-1` worktree's `git show ea04ea52c7:<path>`):

- **Cross-channel push for plan-pending lives in
  `src/agents/plan-mode/plan-archetype-bridge.ts:124-200`** —
  `dispatchPlanArchetypeAttachment`. Mirror-image of the W1-F1
  blocker's §"What the in-host does today":
  1. Renders the plan archetype as markdown
     (`renderFullPlanArchetypeMarkdown`).
  2. Persists it to `~/.openclaw/agents/<agentId>/plans/` (always).
  3. Reads `deliveryContext` for the originating session. If channel
     is **`telegram`** AND `to` is present, calls
     `sendDocumentTelegram(dctx.to, absPath, { caption, parseMode:
     "HTML" })`. The caption ends with
     `/plan accept | /plan accept edits | /plan revise <feedback>`
     (built by `buildPlanAttachmentCaption` at lines 64-87).
  4. **All other channels (Slack, Matrix, Discord, etc.) — falls
     silent at the `dctx.channel !== "telegram"` guard.**
- **Call site**: `src/agents/pi-embedded-subscribe.handlers.tools.ts:1935-1949`
  void-fires `dispatchPlanArchetypeAttachment` immediately after
  `emitAgentApprovalEvent`. The approval event itself goes to UI
  subscribers (Codex app-server, webchat); channels are NOT subscribed
  to the `approval` stream (re-verified — `git show
  ea04ea52c7:extensions/telegram/` + `extensions/slack/` carry no
  `onAgentEvent` / `registerAgentEventSubscription` matches against
  the `approval` stream).
- **Slack on the in-host gets no signal either.** "Match in-host
  parity" for W1-F3 = matching Telegram (one channel) and inheriting
  the Slack/Matrix/Discord silence the in-host itself ships.

**Net**: in-host action-required for plan-mode on a messaging channel
= `sendDocumentTelegram` to the originating Telegram chat. Full stop.
Same conclusion as W1-F1.

## What SDK seams are available to the plugin

Re-verified against
`/Users/lume/repos/Smarter-Claw/node_modules/openclaw/dist/plugin-sdk/`
on `2026.5.18` (identical landscape to W1-F1; pointers below are
spot-checks, full taxonomy lives in `blocker-W1-F1.md` §"What SDK
seams are available to the plugin"):

### 1. `api.session.workflow.sendSessionAttachment` — bundled-only

- **Type** (`host-hooks.d.ts:186-204`):
  ```ts
  export type PluginSessionAttachmentParams = {
    sessionKey: string;
    files: PluginSessionAttachmentFile[];  // REQUIRED, ≥1
    text?: string;
    threadId?: string | number;
    forceDocument?: boolean;
    maxBytes?: number;
    captionFormat?: PluginSessionAttachmentCaptionFormat;
    channelHints?: PluginAttachmentChannelHints;  // telegram.parseMode, slack.threadTs
  };
  ```
- **Runtime gate** (installed loader at
  `node_modules/openclaw/dist/loader-CxUWY2_6.js`): confirmed via
  `grep -o "session attachments are restricted[^\"]*"` — literal
  error string `session attachments are restricted to bundled plugins`
  is in the shipped bundle.
- Smarter-Claw is a 3P plugin (`PluginOrigin = "global" | "workspace"`),
  call returns `{ ok: false, error }` 100% of the time. Same exact
  blocker that stops W1-F1 from sending the markdown.

### 2. `api.agent.events.emitAgentEvent` — `approval` stream reserved

- **Runtime gate** (installed loader): `HOST_OWNED_AGENT_EVENT_STREAMS`
  Set contains `approval` (+ `lifecycle`, `tool`, `assistant`, etc.) —
  re-verified via `grep -o "HOST_OWNED_AGENT_EVENT_STREAMS = new Set"`.
  Error message `reserved for bundled plugins` is in the shipped
  bundle.
- 3P plugins can only emit `stream: "smarter-claw"` / `"smarter-claw.*"`
  scoped streams. Telegram/Slack channel handlers do not subscribe to
  those — they would need new channel-side subscriptions, which is
  itself an upstream-SDK ask.

### 3. `api.session.workflow.scheduleSessionTurn` — wrong tool

- Same five-fold problem documented in `blocker-W1-F1.md` §3 (latency,
  token cost, probabilistic compliance, cooldown collision, no native
  push). Specifically for F3: scheduling a turn to "tell the user the
  plan is ready" would conflict with the plugin's
  `tool-descriptions.ts:71` rule that the agent must STOP after
  `exit_plan_mode`. Not a fit.

### 4. The plugin's existing surfaces — already used or inapplicable

- `registerControlUiDescriptor` — already wired
  (`src/ui/sidebar-descriptor.ts`). Covers webchat / Codex desktop;
  does not reach Telegram/Slack. This IS the "buttons are
  sidebar-only" observation the audit cites.
- `registerCommand` — already wired (`src/ui/slash-commands.ts`).
  `/plan accept|reject|cancel|edit|...` work on every channel via the
  universal text pipeline. This IS the resolution-side that the
  audit's parenthetical "channel ping is not [blocked]" was meant to
  complement. The resolution path works today; the PUSH (proactive
  "you have a plan waiting" signal) is what F3 asks for and is what's
  blocked.
- `registerAgentEventSubscription` — read-side, not write-side. The
  plugin can OBSERVE host-emitted events; it cannot emit on
  host-owned streams (#2 above).
- `registerChannel` — would register a new channel plugin
  (Smarter-Claw as a Telegram provider). Architecturally wrong and
  out of scope.

## Why the audit's "channel ping is not [blocked]" assumption fails

The audit's parenthetical relied on a model where the plugin can call
a "send a short message to this session's channel" method
synchronously, with no per-channel adapter glue, no bundled gate, and
no host-owned-stream restriction. **No such method exists in
`2026.5.18` for a 3P plugin.** Every plausible candidate either
rejects 3P origins (`sendSessionAttachment`), restricts the stream
(`emitAgentEvent` to `approval`/`lifecycle`/...), or is the wrong
tool (`scheduleSessionTurn` is a cron-driven agent-turn injector, not
a chat-message emitter; `enqueueNextTurnInjection` writes a synthetic
USER message into the next turn — the agent then has to choose to
RESPOND with a notification, same probabilistic / cooldown failure
mode as `scheduleSessionTurn`).

## What the plugin already does for visibility (W1-F2)

The W1-F2 markdown persister already lands at
`src/tools/exit-plan-mode.ts:627-648` (via
`persistPlanArchetypeIfConfigured` at line 799 → calls
`persistPlanArchetypeMarkdown` from
`src/plan-mode/plan-archetype-persist.ts`). The plugin DOES write the
`plan-YYYY-MM-DD-<slug>.md` audit artifact every approval cycle. What
it cannot do is PUSH that file (or a "your plan is ready" caption) to
the originating channel — that's exactly the W1-F1 / F3 gap.

The plugin's `src/tools/exit-plan-mode.ts:610-626` comment block
explicitly documents this asymmetry: "the persisted markdown WRITTEN
below is the building block a future host-side or bundled-capability
notifier would attach. Today, Telegram/Slack users get no signal —
the same gap the in-host has on non-Telegram channels."

## Recommendation

**Defer to the same upstream SDK changes as W1-F1.** Three options
ranked by plugin-side change footprint:

### R1 (preferred) — lift the `bundled` gate on `sendSessionAttachment`

- **Host change**: drop or soften the `origin !== "bundled"` rejection
  in the in-host `src/plugins/host-hook-attachments.ts:216-218`.
  Replace with a per-plugin capability that the operator opts into at
  install time (manifest field
  `capabilities: ["sendSessionAttachment"]`).
- **Plugin code unlocked by R1** (~40 LOC total, F1 + F3 combined):
  ```ts
  // In src/tools/exit-plan-mode.ts, right after persistPlanArchetypeIfConfigured:
  if (r.kind === "persisted" && opts.attachmentNotifier && absPath) {
    void opts.attachmentNotifier.send({
      sessionKey,
      files: [{ path: absPath }],
      text: buildPlanAttachmentCaption(title, summary),
      channelHints: { telegram: { parseMode: "HTML" } },
    });
  }
  ```
  Dedup is automatic (fires once per `r.kind === "persisted"` —
  matching the W1-F2 persister's once-per-cycle guard). Resume safety
  is automatic (W1-F2's existing in-cycle idempotency carries through).
  **Cooldown/dedup invariant**: the action-required signal fires
  exactly once per `approvalId` because `persistApprovalRequest`'s
  invariant 3 + 7 (`lastPlanPayloadHash` idempotency) returns
  `kind: "reused"` on a duplicate `exit_plan_mode` — the F3 push and
  the F2 persist share the same trigger boundary.
- **Result**: Telegram users get a Telegram document push (matches
  in-host today). Slack users get a Slack file upload (BETTER than
  in-host today). Webchat users still see the sidebar (unchanged).
  Both W1-F1 and W1-F3 close in the same PR.

### R2 — add a plan-specific approval-channel push seam

- New SDK method `api.session.workflow.sendActionRequiredNotice({
  sessionKey, kind: "plan_approval", message, actions?: [{label,
  command}] })`. Host adapter routes per-channel: Telegram → text
  message with HTML buttons; Slack → blocks API with action buttons;
  webchat → reuses the existing approval-card; CLI → terminal bell.
  The plugin emits ONE call; the host fans out.
- More host code than R1 (per-channel adapters) but avoids giving 3P
  plugins generic attachment access. Composes with the S16-U
  "interactive callback" upstream PR
  (`buildspec-S16-channel-native.md` §3 Path B) — R2's
  `actions: [{label, command}]` payload becomes the entry-point for
  true tappable buttons once S16-U lands.

### R3 — host emits the notification on the plugin's behalf

- Move the `dispatchPlanArchetypeAttachment` equivalent into the
  host, triggered when a `session.state` extension with
  `planMode.approval === "pending"` is written. The plugin owns
  state + tool; the host owns delivery. No plugin code change for F3.
- Highest decoupling, hardest to ship (cross-cuts host concerns the
  in-host today keeps in the plan-mode runtime).

### Interim posture this PR ships

**Pure documentation. No production code change for F3.**

1. **This blocker doc**. The honest record.
2. **The W1-F2 markdown persister stays.** It is the artifact that
   R1/R2/R3 would attach.
3. **The W1-F1 comment block in `src/tools/exit-plan-mode.ts:610-626`
   already covers F3.** Both findings deferred to the same set of
   upstream paths. No additional in-code comment needed.

User-facing reality today:
- **Resolution (response) works everywhere.** `/plan accept|edit|
  reject|cancel|auto` are routed through `src/ui/slash-commands.ts`
  and dispatch to the existing session-action handlers — works on
  Telegram, Slack, Discord, webchat, CLI via the universal text
  pipeline.
- **Push (proactive signal) only works on webchat.** Sidebar
  descriptor renders the approval card. Other channels see no
  "action-required" message at the moment the plan goes pending.
  Users on those channels must either (a) check the sidebar
  separately or (b) be told by the agent (the
  `agentPromptGuidance` field in `createPlanSlashCommand`
  documents `/plan accept | reject` so the agent can surface the
  commands in its assistant text, but the agent's
  `exit_plan_mode` tool description tells it to STOP AFTER the
  call — so there's no agent text in the same turn for the user
  to read).
- **R1 closes the gap with ~40 LOC of plugin code + a host PR.**
  The same upstream change unblocks both findings.

## Tracking

- W1-F3 row in `wave-1-catalog.md` (line 98): the wave-1 catalog
  already correctly classifies this as `missing-feature` P1. Severity
  is unchanged. The "channel ping is not [blocked]" parenthetical was
  the optimistic interpretation; this doc records the empirical
  refutation.
- `EXECUTION-STATUS.md`: mark W1-F3 as "deferred — SDK blocker (same
  as W1-F1)" with a link to this doc.
- **Upstream issue**: the SDK-change request filed for W1-F1 (R1) is
  the same change. **Do not file a separate upstream PR for F3** —
  they share the seam and the rationale. Add F3 as an additional
  consumer in the F1 issue's description.

## Lessons

- **`bundled-plugin-only` runtime gates cluster.** When one parity
  finding hits a `bundled-plugin-only` SDK seam, all sibling findings
  that depend on the same seam (push to channel, emit on host stream,
  decorate built-in channel) are blocked by the same change. Audit
  pass-2 should grep `origin !== "bundled"` in the installed loader
  bundle (`node_modules/openclaw/dist/loader-*.js`) up front and
  collect ALL findings that share the constraint.
- **The audit's "channel ping is not blocked" was a thinking shortcut
  that assumed a primitive the SDK doesn't expose.** Same as W1-F1's
  "no new SDK seam needed" — the parity audit needs an
  SDK-seam-feasibility pass on every "wire X" recommendation BEFORE
  the catalog rows are scoped as P0/P1.
- **In-host parity has a Telegram-shaped ceiling for F3.** "Match the
  in-host" means matching Telegram and inheriting Slack/Matrix/Discord
  silence. R2 (the new push seam) is the better long-term answer
  because it lifts the in-host's own ceiling. R1 (lift the bundled
  gate) is the cheapest answer that still gives Slack parity-or-better
  (Slack file upload >> in-host's Slack silence).
