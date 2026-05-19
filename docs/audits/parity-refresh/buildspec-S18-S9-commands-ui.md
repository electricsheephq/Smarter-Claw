# Build-spec S18 + Parity audit S9 — per-channel `/plan` routing & UI surfaces

**Date:** 2026-05-19
**Plugin:** Smarter-Claw (OpenClaw plan-mode plugin)
**Host SDK:** `openclaw` `2026.5.18` (npm, `node_modules/openclaw/dist`)
**In-host reference:** `/Users/lume/repos/openclaw-pr70071-rebase` @ `ea04ea52c7` (worktree on `test-env/beta4-base`; plan-mode files present at that commit)

Scope:

- **Part 1 — S18 build-spec:** does `/plan` / `/plan-mode` actually work on every channel (webchat / Telegram / Slack)?
- **Part 2 — S9 audit:** parity of `src/ui/sidebar-descriptor.ts`, `src/ui/session-actions.ts`, `src/ui/sweep-command.ts`.

---

# Part 1 — S18 build-spec: per-channel `/plan` command routing

## 1.1 Verdict (TL;DR)

**`/plan` works on webchat: YES. On Telegram: YES, with one real silent-failure risk (the 100-command limit). On Slack: UNKNOWN — almost certainly works via the universal text path, but cannot be confirmed because `@openclaw/slack` is not installed in this plugin's `node_modules`.**

The plugin's `slash-commands.ts` header claim — *"Registered without a `channels` filter → available on every channel surface (webchat, Telegram, Slack, etc.)"* — is **substantially correct but for the wrong reason**, and it papers over the Telegram limit. The reason `/plan` is universal is **not** the absence of a `channels` filter; it is that `api.registerCommand` commands are dispatched by the host's **auto-reply text-command pipeline** (`handlePluginCommand`, the first handler in `loadCommandHandlers()`), which runs on every channel that routes inbound text through auto-reply. The `channels` filter only *narrows* that universal default.

## 1.2 How OpenClaw 2026.5.18 routes `registerCommand` commands

There are **TWO independent dispatch paths** for a plugin-registered command. This is the single most important fact for S18.

### Path A — universal auto-reply text pipeline (the one that makes `/plan` work everywhere)

`dist/commands-handlers.runtime-DiUdB82z.js`:

- `loadCommandHandlers()` (line 6132) returns a handler array whose **first entry is `handlePluginCommand`**.
- `handlePluginCommand` (line 4502) calls `matchPluginCommand(command.commandBodyNormalized, { channel: command.channel })` then `executePluginCommand({ ..., sessionKey: params.sessionKey, ... })`.
- This handler chain runs inside `get-reply` (`dist/get-reply-CXtCkTsR.js`) — the auto-reply core used by **every** channel, webchat included. `sessionKey` is in scope there and is threaded through (`get-reply` lines 221, 4517).

Gating: `shouldHandleTextCommands` (`dist/commands-text-routing-CDXX9zWn.js`):

```js
function shouldHandleTextCommands(params) {
  if (params.commandSource === "native") return true;
  if (params.cfg.commands?.text !== false) return true;     // <-- default ON
  return !isNativeCommandSurface(params.surface);
}
```

`cfg.commands.text` defaults to `undefined` → `!== false` → **`true`**. So body-text command dispatch is **enabled on every channel by default**. A user typing `/plan accept` as a normal message gets matched here, on webchat, Telegram, Slack, Discord, CLI — identically.

This is exactly how the in-host shipped it. The in-host `handlePlanCommand` was a dedicated built-in handler in the *same* `loadCommandHandlers()` chain (`src/auto-reply/reply/commands-handlers.runtime.ts`), with the comment: *"PR-11: universal /plan slash commands work on every channel (Telegram, Discord, Signal, iMessage, Slack, CLI)."* The plugin's `/plan` rides the generic `handlePluginCommand` slot instead of a bespoke handler — **functionally equivalent universality**.

### Path B — native slash-command surface (the menu / `bot.command()` registration)

This is the Telegram "/" autocomplete menu and Telegram's per-command runtime handler. `dist/command-specs-B-5P366Q.js`:

```js
function getPluginCommandSpecs(provider, options) {
  ...
  if (providerName && (getLoadedChannelPlugin(providerName)?.commands ?? commandDefaults)
        ?.nativeCommandsAutoEnabled !== true) return [];      // <-- gate
  return listProviderPluginCommandSpecs(provider);
}
```

A plugin command appears on a channel's **native** surface only if that channel plugin sets `nativeCommandsAutoEnabled: true`.

- Telegram: `dist/channel.setup-DOFx9Q1W.js:972` → `nativeCommandsAutoEnabled: true`. **Telegram opts in.**
- Discord: `dist/shared-CnbIV8Bu.js:133` → `nativeCommandsAutoEnabled: true`.
- Slack: external plugin `@openclaw/slack` — **not installed here**, value unknown.

`listProviderPluginCommandSpecs` filters via `pluginCommandSupportsChannel(cmd, provider)` which (`dist/types-BaOU_7l0.js:330`) returns `true` whenever `command.channels` is empty/absent. So `/plan` (no `channels`) **is** eligible for every native surface.

### Effect of the type's other fields

`OpenClawPluginCommandDefinition` (`dist/plugin-sdk/src/plugins/types.d.ts:1601`):

| Field | Plugin `/plan` sets it? | Effect if omitted |
|---|---|---|
| `channels?: readonly string[]` | **No** | Command available on every channel (correct intent). |
| `nativeNames?: { default?, <provider>? }` | **No** | Native menu uses the bare `name` (`/plan`). No native alias needed — `/plan` is already a valid Telegram command name (`a-z0-9_`, ≤32 chars). **Not a defect.** |
| `acceptsArgs?: boolean` | **Yes — `true`** | **Load-bearing.** `matchPluginCommand` (`dist/commands-BdI3fczN.js:37`): `if (args && !command.acceptsArgs) return null`. Without `acceptsArgs: true`, `/plan accept` (anything with args) would silently fail to match on **both** paths. The plugin sets it correctly. |
| `requireAuth?: boolean` | **No** (defaults `true`) | `executePluginCommand` (`commands-BdI3fczN.js:83`) blocks unauthorized senders. Plan-mode controls *should* be operator-gated, so the `true` default is correct. Worth an explicit note (see §1.5). |
| `requiredScopes?: OperatorScope[]` | **No** | No gateway-scope gate. Fine — chat-surface command owners would satisfy it anyway. |

**Conclusion on routing:** the plugin's "no `channels` filter" is the right choice. `/plan` reaches every channel via Path A unconditionally, and additionally shows in the Telegram native menu via Path B — *unless the menu is full*.

## 1.3 THE Telegram 100-command-limit risk (the reported "doesn't work on Telegram")

`dist/bot-deps-CiCNa5m4.js`:

```js
const TELEGRAM_MAX_COMMANDS = 100;
...
fitTelegramCommandsWithinTextBudget(allCommands.slice(0, maxCommands), maxTotalChars)
```

`dist/bot-BRuINTsq.js:731` builds the menu list as:

```js
allCommands: [
  ...nativeCommands.map(...),     // host built-ins FIRST
  ...nativeEnabled ? pluginCatalog.commands : [],   // plugin commands SECOND
  ...customCommands               // operator custom commands THIRD
]
```

then `buildCappedTelegramMenuCommands` does `allCommands.slice(0, 100)` — **keeps the first 100, drops the rest**, and logs:

> `Telegram limits bots to 100 commands. 122 configured; registering first 100…`

The gateway log the user already observed (*"telegram limits bots to 100 commands; 122 configured; registering first 100"*) is this exact path firing.

**Risk analysis — split into the two paths:**

| Path | Affected by the 100-cap? | Consequence |
|---|---|---|
| **B — native menu (`setMyCommands`)** | **YES.** Plugin commands are appended *after* all host `nativeCommands`. With 122 configured, the last 22 are dropped. `/plan` + `/plan-mode` are 2 plugin commands sitting in that tail region. | If `/plan` falls past slot 100, it **disappears from Telegram's "/" autocomplete menu**. The user types `/pl…` and sees nothing — looks broken. |
| **B — native runtime handler (`bot.command()`)** | **NO.** `dist/bot-BRuINTsq.js:1064` registers `bot.command()` for **`pluginCatalog.commands`** (the *uncapped* plugin list from `buildPluginTelegramMenuCommands`), not the capped `commandsToRegister`. | The handler is still wired even past slot 100. A user who *types `/plan accept` anyway* still hits a working handler. |
| **A — universal text pipeline** | **NO.** Independent of the menu entirely. | `/plan accept` as a plain message always works on Telegram. |

**Net:** even in the worst case, `/plan` is not *broken* on Telegram — it is **invisible** (no autocomplete entry, no menu hint). Users who don't memorize the command, or who rely on the "/" menu to discover it, will report "it doesn't work on Telegram." That is the most plausible match for the user's report. The functionality (Path A) survives; the **discoverability** does not.

A secondary, harder failure: Telegram can reject the whole `setMyCommands` payload with `BOT_COMMANDS_TOO_MUCH` (`isBotCommandsTooMuchError`, `bot-deps` line 110) if even the capped+budgeted set is too large; the retry path (`formatTelegramCommandRetrySuccessLog`) drops more commands. Under that path `/plan` is even more likely to be cut.

## 1.4 `PluginCommandContext.sessionKey` per channel

`/plan` needs `sessionKey` — `dispatchAction` and `handleEnter` in `slash-commands.ts` both bail with a user-facing error if `ctx.sessionKey` is falsy.

`PluginCommandContext` (`types.d.ts:1539`) declares `sessionKey?: string` — **optional**. Whether it is populated depends on the caller:

- **Webchat (Path A):** `get-reply` resolves `sessionKey` for the active conversation and threads it into `handlePluginCommand` → `executePluginCommand({ sessionKey: params.sessionKey })`. **Present.**
- **Telegram native (Path B):** `bot-BRuINTsq.js:1147` calls `executePluginCommand({ ..., sessionKey: route.sessionKey, ... })` where `route` comes from `resolveCommandRuntimeContext` (a Telegram conversation→agent route resolution, line 1103). **Present** for any chat bound to an agent route.
- **Telegram text (Path A):** same `get-reply` pipeline as webchat; the Telegram inbound message resolves a route → `sessionKey`. **Present.**
- **Slack:** **UNKNOWN** — `@openclaw/slack` not installed. Slack channel plugins that resolve an agent route per conversation will supply `sessionKey` identically; the SDK type permits it. No reason to expect otherwise, but it is unverified.

Edge case worth a regression test: a `/plan` issued from a Telegram chat that is **not** bound to any agent route (e.g. a brand-new group before activation) — `route.sessionKey` could be empty, and `/plan` would correctly return its "requires a session context" reply. That is graceful, not a crash. **Not a defect**, but document it.

## 1.5 S18 findings

| # | Finding | Class | Sev |
|---|---|---|---|
| S18-1 | **Telegram native-menu drop.** With >100 total Telegram commands, `/plan` + `/plan-mode` (plugin commands, appended after host built-ins) can be sliced off the `setMyCommands` menu. Functionality survives via the universal text pipeline + the uncapped `bot.command()` handler, but the command vanishes from "/" autocomplete → users perceive it as broken on Telegram. This is the most likely cause of the reported "doesn't work on Telegram." | parity-gap | **P1** |
| S18-2 | **Misleading header rationale.** `slash-commands.ts` lines 38-41 attribute universality to the *absence of a `channels` filter*. The real mechanism is the auto-reply `handlePluginCommand` text pipeline. The comment also makes no mention of the Telegram menu cap. Misleads future maintainers into thinking native-menu presence is guaranteed. | parity-gap | P2 |
| S18-3 | **Slack unverified.** `@openclaw/slack` is not in `node_modules`; native-menu behavior + `sessionKey` population on Slack cannot be confirmed from this tree. Universal text path (A) almost certainly works, but S9/S18 "works on Slack" is **unverified**, not "yes." | test-gap | P2 |
| S18-4 | **No native discoverability fallback.** Because `/plan` is two registrations (`plan`, `plan-mode`), it consumes *two* of the scarce native-menu slots, doubling the chance one is dropped, and offers no `agentPromptGuidance` so the agent can't tell the user "type /plan accept" when the menu entry is missing. | missing-feature | P2 |
| S18-5 | **`acceptsArgs: true` is correct and load-bearing** — verified against `matchPluginCommand` (`commands-BdI3fczN.js:37`). No action; recorded so a future refactor does not drop it. | (ok) | — |

## 1.6 S18 fix / build plan

**Goal:** keep `/plan` reliably reachable and discoverable on Telegram, and make the Slack story verified rather than assumed.

### Build step 1 — guarantee Telegram menu presence (addresses S18-1, P1)

The cap keeps the *first* 100; host built-ins are always first; plugin commands are appended. The plugin cannot reorder the host's array. Three viable mitigations, in preference order:

1. **(Recommended) Collapse two commands into one.** Drop the separate `/plan-mode` *native* registration; keep `/plan-mode` only as a text-pipeline alias (Path A) or document it as removed. This halves native-slot consumption (2 → 1) and the surviving `/plan` is the canonical surface. Implementation: still call `api.registerCommand` for both, **but give `plan-mode` a `channels` filter that excludes `telegram`** so it never enters `getPluginCommandSpecs("telegram")` — Path A still serves it on Telegram via text. Net: one Telegram menu slot, both commands still typeable everywhere.
2. **Add `agentPromptGuidance`** to the `/plan` definition (e.g. `["When plan mode is available, the user can type /plan accept | reject | edit <body> | cancel directly in chat."]`). The host injects this into the agent's system prompt (`listRegisteredPluginAgentPromptGuidance`), so even with no menu entry the agent can tell the user how to invoke it. Cheap, channel-agnostic, addresses S18-4.
3. **Document the operator escape hatch.** If a deployment genuinely runs >100 Telegram commands, the operator can set `channels.telegram.commands.native: false` (mentioned verbatim in the host's overflow log) — that disables the native menu entirely and forces *all* commands onto the text pipeline, where `/plan` always works. Add this to the plan-mode operator runbook.

### Build step 2 — correct the header (addresses S18-2, P2)

Rewrite `slash-commands.ts` lines 37-44 to state the real mechanism:

> `/plan` is dispatched by the host's auto-reply text-command pipeline (`handlePluginCommand`), which runs on every channel that routes inbound text — webchat, Telegram, Slack, Discord, CLI. The absence of a `channels` filter keeps it eligible for every channel's *native* command menu as well. NOTE: on Telegram the native menu is capped at 100 commands; if a deployment exceeds that, `/plan` may drop off the "/" autocomplete menu — it still works when typed, and `agentPromptGuidance` tells the agent how to prompt the user.

### Build step 3 — Slack verification (addresses S18-3, P2)

Add a CI/parity-harness step that installs `@openclaw/slack`, registers the plugin, and asserts (a) `getPluginCommandSpecs("slack")` includes `plan` (or that Slack lacks `nativeCommandsAutoEnabled` — either way, record the truth), and (b) a synthetic Slack inbound `/plan status` reaches `handlePluginCommand` with a non-empty `sessionKey`. Until then, S18/S9 status for Slack is "unverified," not "yes."

### Build step 4 — regression tests

- `matchPluginCommand("/plan accept", { channel: "telegram" })` → matches (guards `acceptsArgs`).
- `buildCappedTelegramMenuCommands` with 121 host commands + `plan` appended → assert `plan` is dropped, proving S18-1 is real and that step-1 mitigation (≤1 plugin slot) keeps it in.
- `handlePluginCommand` with `sessionKey: undefined` → `/plan accept` returns the graceful "requires a session context" reply, **not** a thrown error.

---

# Part 2 — S9 parity audit: UI surfaces

**In-host reality check (important framing):** at `ea04ea52c7` the in-host has **no** `registerControlUiDescriptor` call and **no** `session sweep --plan-mode-clear` CLI flag (`git grep` for `plan-mode-clear`, `registerControlUiDescriptor`, `sweep` under `src/cli/**` and `src/agents/plan-mode/**` all return nothing). The in-host plan-mode UI lived in webchat chip + approval-card surfaces driven by `sessions.patch`. Therefore:

- `sidebar-descriptor.ts` is a **plugin-specific construct** — there is no in-host sidebar to be at parity *with*. The audit target is *internal consistency* (does the declared schema match the plugin's own `PlanModeSessionState`?), not host parity.
- `sweep-command.ts`'s `host_ref` (`openclaw session sweep --plan-mode-clear`) **does not exist in-host**. The file's own comment hedges this ("referenced in P-12's spec"). The command is a net-new plugin operator tool, not a port.
- `session-actions.ts` *does* have a real in-host parity target: `resolvePlanApproval` (`src/agents/plan-mode/approval.ts:44-130`).

## 2.1 Findings table

| # | File | Finding | Class | Sev |
|---|---|---|---|---|
| S9-1 | `sidebar-descriptor.ts` | **Schema omits 5 real state fields.** The descriptor `schema.properties` declares `mode, approval, rejectionCount, approvalId, title, feedback, lastPlanSteps, autoApprove, __schemaVersion`. The actual payload (`types.ts` `PlanModeSessionState`, produced by `state/store.ts`) also carries **`enteredAt`, `confirmedAt`, `updatedAt`, `approvalRunId`, `lastPlanPayloadHash`**. `store.ts` demonstrably writes `enteredAt`/`updatedAt` (lines 349-350, 419, 657-674). A UI client doing strict schema validation against this descriptor would reject or silently drop those fields. The descriptor undersells the contract. | parity-gap | **P1** |
| S9-2 | `session-actions.ts` | **Terminal-state semantics diverge from the in-host on the `rejected` state.** In-host `resolvePlanApproval` (approval.ts:83) allows `approve`/`edit`/`reject` when `approval === "pending"` **OR `"rejected"`** — `rejected` is explicitly *non-terminal*, kept open for re-approval/re-rejection. The plugin's `checkApprovalId` (session-actions.ts:174-182) rejects with `NO_PENDING_APPROVAL` whenever `approval !== "pending"`. So `plan.accept`/`plan.reject` on a *rejected* plan that was never re-proposed fails in the plugin but succeeds in-host. In practice the agent normally re-fires `exit_plan_mode` (→ `pending`) after a rejection, masking this — but an operator clicking Approve on a still-`rejected` card hits the divergence. | parity-gap | **P1** |
| S9-3 | `sweep-command.ts` | **`host_ref` cites a non-existent in-host command.** `openclaw session sweep --plan-mode-clear` does not exist at `ea04ea52c7`. The command is fine as a plugin-only tool, but the `host_ref:` line (and the "In-host parity" section) imply a port that cannot be verified. Reclassify the comment as "plugin-specific operator tool; no in-host equivalent." | parity-gap | P2 |
| S9-4 | `sidebar-descriptor.ts` | **`lastPlanSteps.items` is loosely typed vs. the producer.** Schema sets `status: { type: "string" }` with no `enum`; the plugin's `PlanStep.status` is a free `string` so this is *technically* consistent, but the in-host normalizes status to a known enum set. `activeForm` is correctly optional. Minor — tighten only if a client needs the enum. | test-gap | P2 |
| S9-5 | `session-actions.ts` | **`plan.answer` is registered but unreachable from any user surface.** The 6th action exists and is correct, but `slash-commands.ts` deliberately does not wire `/plan answer` (no plugin-side question-state), and the sidebar descriptor exposes no question fields (`questionId`/`questionPrompt` absent from schema). So `plan.answer` can only be invoked by a UI client that already knows a `questionId` out-of-band — which nothing in this plugin provides. The action is effectively dead until question-state tracking lands. Known/tracked, but call it out as a coverage hole. | missing-feature | P2 |
| S9-6 | `sweep-command.ts` | **No `--all-sessions` and no list seam** — acknowledged in the file header as an SDK-gap deferral. Single-session sweep is the shipped scope. Correct for now; recorded so it is not mistaken for complete. | missing-feature | P2 |
| S9-7 | `session-actions.ts` | **`continueAgent` semantics are correct and match intent** — `plan.accept`/`edit`/`reject` set `continueAgent: true` (agent resumes/revises), `plan.cancel` sets `false` (user-driven next turn). Consistent with the in-host injection model. No action. | (ok) | — |
| S9-8 | `sidebar-descriptor.ts` | **`requiredScopes: []` (empty) on a state-*read* surface is acceptable** — the comment correctly notes mutation gating happens in the action handlers. No defect; the empty array is intentional and documented. | (ok) | — |

## 2.2 Severity roll-up

- **P0: 0**
- **P1: 2** — S9-1 (sidebar schema omits 5 fields), S9-2 (rejected-state terminal-guard divergence).
- **P2: 4** — S9-3, S9-4, S9-5, S9-6.
- Plus 2 OK confirmations (S9-7, S9-8).

**Worst finding: S9-2** — the `session-actions.ts` terminal-state divergence is the highest-impact because it is a *behavioral* parity break in the approval state machine (the most load-bearing surface in the plugin), not just a descriptor/metadata mismatch. S9-1 is tied on severity but is a contract-completeness issue (UI clients), not a wrong-behavior issue.

## 2.3 S9 fix plan

1. **S9-1:** add `enteredAt`, `confirmedAt`, `updatedAt`, `approvalRunId`, `lastPlanPayloadHash` to `sidebar-descriptor.ts` `schema.properties` (all `{ type: "integer" }` for the timestamps, `{ type: "string" }` for the two ids/hashes). Keep them optional (not in `required`). The schema should mirror `PlanModeSessionState` field-for-field; consider generating it from the type to prevent future drift.
2. **S9-2:** decide intentionally. Either (a) restore in-host parity — extend `checkApprovalId` to accept `approval === "pending" || approval === "rejected"`, matching `resolvePlanApproval`'s non-terminal `rejected` — or (b) document the plugin's stricter rule (rejected plans must be re-proposed before any action) as a deliberate divergence with a `host_ref` note explaining why. Option (a) is the lower-surprise choice and matches the cited parity contract in the file header.
3. **S9-3:** rewrite the `sweep-command.ts` `host_ref:` line and "In-host parity" section to state plainly that there is no in-host equivalent; it is a plugin-native operator tool.
4. **S9-5:** either wire a minimal `/plan answer` once question-state exists, or add `questionId`/`questionPrompt` to the sidebar schema so a UI client *can* drive `plan.answer` — currently neither surface can.
5. **S9-4 / S9-6:** no code change required; keep as recorded known-limitations.

---

# Appendix — key host evidence paths

- `dist/commands-handlers.runtime-DiUdB82z.js:6132` — `loadCommandHandlers()`, `handlePluginCommand` first.
- `dist/commands-handlers.runtime-DiUdB82z.js:4502` — `handlePluginCommand` (universal text dispatch, passes `sessionKey`).
- `dist/commands-text-routing-CDXX9zWn.js:21` — `shouldHandleTextCommands` (text commands default ON).
- `dist/commands-BdI3fczN.js:25,77` — `matchPluginCommand` (line 37 `acceptsArgs` guard) / `executePluginCommand`.
- `dist/command-specs-B-5P366Q.js:15` — `getPluginCommandSpecs` (`nativeCommandsAutoEnabled` gate).
- `dist/types-BaOU_7l0.js:330` — `pluginCommandSupportsChannel` (empty `channels` → true).
- `dist/bot-deps-CiCNa5m4.js:43` — `TELEGRAM_MAX_COMMANDS = 100`; `buildCappedTelegramMenuCommands` `slice(0,100)`.
- `dist/bot-BRuINTsq.js:731` — Telegram menu list ordering (host built-ins, then plugin, then custom); `:748` overflow log; `:1064` uncapped `bot.command()` handler registration; `:1147` `sessionKey: route.sessionKey`.
- `dist/channel.setup-DOFx9Q1W.js:972` — Telegram `nativeCommandsAutoEnabled: true`.
- In-host `openclaw-pr70071-rebase@ea04ea52c7`: `src/auto-reply/reply/commands-plan.ts` (universal `/plan`), `src/auto-reply/reply/commands-handlers.runtime.ts:38-70` (handler chain), `src/agents/plan-mode/approval.ts:44-130` (`resolvePlanApproval` terminal-state guard), `src/config/sessions/types.ts:274-385` (`planMode` session-entry shape).
