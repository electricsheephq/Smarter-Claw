# Blocker — W1-E6 (`madeToolCall` derived from wrong signal)

**Status:** deferred — fix requires an SDK change. The plugin alone
cannot derive a reliable "this turn made a tool call" signal from the
`before_agent_finalize` event as it ships in openclaw
`2026.5.18` and `2026.5.10-beta.5`.

**Issue:** #102 (W1-E6)

**Decision date:** 2026-05-20.

## Audit's claim, restated

`wave-1-catalog.md` row W1-E6 + `slice-audit-E-runtime.md` § E-6
asserted:

1. `madeToolCall = event.stopHookActive === true` is semantically wrong
   — `stopHookActive` indicates hook re-entrancy, not tool-use.
2. The "new `messages[]` field on `before_agent_finalize` (2026.5.18)
   is the correct signal" — i.e. the plugin can inspect the final
   message array for a tool-call entry instead.

Claim (1) is **correct**. Claim (2) is **partially wrong**: the field
is declared in the SDK type, but the runtime does not populate it.

## What I searched

**SDK type** (canonical):

- `node_modules/openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts:139-151`
  — `PluginHookBeforeAgentFinalizeEvent` declares `messages?: unknown[]`.
  Type contract: optional, opaque element shape, no JSDoc.
- Same definition repeats verbatim at the bundled
  `node_modules/openclaw/dist/hook-types-DRn8L7j8.d.ts` (re-export
  bundle).

**Event-construction call-sites** (in-host source-of-truth
`/Users/lume/repos/openclaw-pr70071-rebase` tip `ea04ea52c7`):

- `src/agents/harness/native-hook-relay.ts:967-1005` —
  `runNativeHookRelayBeforeAgentFinalize`. The **only** call-site in
  the in-host that fires `before_agent_finalize`. The event payload it
  constructs (lines 973-988) omits `messages` entirely. It also omits
  `transcriptPath` as a means of recovering messages (passes the path
  but never reads the file).
- `src/agents/harness/native-hook-relay.ts:1303-1346` —
  `normalizeCodexHookMetadata`. Defines the full set of fields lifted
  out of the codex Stop-hook JSON payload: `hook_event_name`, `cwd`,
  `model`, `turn_id`, `transcript_path`, `permission_mode`,
  `stop_hook_active`, `last_assistant_message`, `tool_name`,
  `tool_use_id`. **No `messages`-equivalent field.** Claude Code's
  Stop hook spec does not emit messages either.
- `src/plugins/hooks.before-agent-finalize.test.ts` and
  `src/agents/harness/lifecycle-hook-helpers.test.ts` — the in-host
  test fixtures never populate `messages`. Confirms the field is
  unused.

**Installed runtime** (bundled JS): grep of
`node_modules/openclaw/dist/native-hook-relay-BGuJNohn.js` — same
event constructor; `messages` not written.

**Plugin test suite**:
- `tests/runtime/escalating-retry.test.ts` — directly sets
  `madeToolCall` on the `TurnSignal`; never exercises the
  event-to-signal derivation. Wrong derivation has zero current
  coverage.

**Gateway logs**: `~/.openclaw/logs/gateway.log` and Archive — zero
  `before_agent_finalize` event captures present. Cannot verify
  behavior against a real payload.

**`AgentMessage` shape** (would be the canonical type for `messages[]`
elements if they were populated; for the SDK-change proposal below):

- Defined in `@earendil-works/pi-agent-core/dist/types.d.ts:247`:
  `AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]`.
- `Message` from `@earendil-works/pi-ai/dist/types.d.ts`:
  `UserMessage | AssistantMessage | ToolResultMessage`.
- `AssistantMessage.content: (TextContent | ThinkingContent | ToolCall)[]`.
- `ToolCall = { type: "toolCall"; id: string; name: string; arguments }`.
- `ToolResultMessage = { role: "toolResult"; toolCallId; toolName; … }`.

So if `messages[]` were populated with `AgentMessage[]`, the canonical
"did the turn make a tool call?" derivation would be:

```ts
const last = messages[messages.length - 1];
const madeToolCall =
  last?.role === "assistant" &&
  Array.isArray(last.content) &&
  last.content.some((c) => c?.type === "toolCall");
// OR, scanning after the last user message:
//   any subsequent message with role === "toolResult"
```

That logic is straightforward — it just can't run today, because
`messages` is undefined.

## What the missing seam is

One of:

**Option A — populate `messages` (or the discriminant) on the event.**
Patch `src/agents/harness/native-hook-relay.ts:967-988` and
`normalizeCodexHookMetadata` (`:1303-1346`) so the event carries either:
- (A1) `messages: AgentMessage[]` synthesized from `transcript_path`
  (parse the JSONL session transcript, take the last turn). Requires
  filesystem read; adds latency.
- (A2) `madeToolCall: boolean` derived gateway-side from the codex
  payload (codex knows whether the model emitted a `ToolUse` block;
  the `tool_name` field is even already extracted). Single boolean;
  zero parse cost.

(A2) is cleaner: zero new contract surface, just one field plumbed
through the existing normalizer. The plugin would consume
`event.madeToolCall ?? false`.

**Option B — expose a separate seam.** Add `getLastTurnToolCalls()`
to `PluginHookAgentContext` — a function the plugin can call from any
conversation hook. Heavier surface, but reusable.

**Smallest unblocking change:** Option (A2). One field added to
`PluginHookBeforeAgentFinalizeEvent`:

```ts
// Whether the agent's last turn emitted a tool call. True iff the
// final assistant message in the turn carried a tool-use content
// block. Always populated by the codex native-hook-relay. Other
// providers may leave this undefined; consumers should treat
// undefined as "unknown" rather than false.
madeToolCall?: boolean;
```

Plus one read in `normalizeCodexHookMetadata` — the codex Stop-hook
JSON does not expose this directly, but the **`hook_event_name`** does:
`Stop` after a tool-use turn comes through a different relay path
(`hook_event_name: "PostToolUse"` precedes; `hook_event_name: "Stop"`
fires after the LLM's final no-tool turn). The cleanest signal is on
the codex side: emit `madeToolCall: true` whenever Stop fires within a
turn that included any `PreToolUse` invocation. That requires turn-
scoped state in the relay, but the state already exists (turn IDs are
already extracted).

## Is the current proxy genuinely wrong, or coarse-and-conservative?

**Wrong, not conservative.**

Per Claude Code's documented Stop-hook spec, `stop_hook_active` is
`true` only when the Stop hook is being re-invoked (the previous Stop
hook fired and the agent has another loop iteration). It is `false`
on the normal first-pass Stop event regardless of tool-use. So:

- Normal tool-using turn: `stopHookActive = false` →
  `madeToolCall = false` → detector wrongly fires "you didn't act"
  retry on a turn that DID act.
- Chat-only turn: `stopHookActive = false` →
  `madeToolCall = false` → detector correctly fires.

The proxy collapses both cases to the same value. Net effect:
spurious "you didn't act" retries every time the agent uses tools in
plan-mode or post-approval execution. That is the dominant case — the
plugin's whole value-prop is making the agent use tools after plan
approval — so the bug is in the hot path.

The audit's catalog correctly notes "spurious retry on a turn that
already acted." Confirmed.

## What the plugin should do *until* the SDK seam ships

Two options, neither great:

1. **Leave the proxy in place** and accept that escalating-retry
   over-fires after approval. The retry instruction is "you must
   call a tool"; the agent's next pass complies (re-issuing the same
   tool call it already issued). Wastes a turn, doesn't break
   correctness. **Status quo.**

2. **Disable the post-approval `PLAN_YIELD` detector** until
   `madeToolCall` is reliable. The yield detector is the most
   destructive — fires "you didn't execute the plan" on turns that
   actually did execute. `PLAN_ACK_ONLY` and `PLANNING_RETRY` add
   `lastAssistantMessage`-based text guards (`PLANNING_ONLY_COMPLETION_RE`,
   `isPlanningOnlyNarrationText`) that partly compensate; `PLAN_YIELD`
   has only the (broken) `madeToolCall`. **Defensible interim.**

Neither is shipped here. The W1-E6 finding remains open, awaiting the
SDK change.

## Action

- File against openclaw: add `madeToolCall?: boolean` (Option A2 above)
  to `PluginHookBeforeAgentFinalizeEvent`, populate from the codex
  native-hook-relay using existing turn-scoped state. **Cite this doc.**
- Once that ships, this issue can close in two commits:
  - Replace `madeToolCall = event.stopHookActive === true` with
    `madeToolCall = event.madeToolCall ?? false` (or `?? true` if we
    want fail-OPEN on unknown — i.e. skip the retry rather than
    spuriously fire it).
  - Add tests in `tests/runtime/escalating-retry.test.ts` covering both
    the `true` and `false` paths from a representative
    `before_agent_finalize` event.

- Until then, leave the proxy in place (per "neither is great" — the
  status quo is the smaller bug than disabling `PLAN_YIELD` outright).
  Add a comment at `src/index.ts:535-539` referencing this doc and
  #102 so the next reader doesn't reinvent the investigation.
