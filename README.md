# Smarter Claw 🦞

Plan Mode for [OpenClaw](https://github.com/openclaw/openclaw) — plan-then-execute workflow with archetype prompting, mutation gate, ack-only retry, and cross-channel `/plan` slash commands.

Universal across the Pi runner (`openai/*`, `openai-codex/*`) and the native Codex app-server harness (`codex/*`).

## Status

**`v1.0.0`** — first feature-complete release. Full parity with the original openclaw-1 in-core plan-mode (PR-7 through PR-11 history) extracted into a standalone external plugin + reversible host installer (Spicetify pattern).

- 7 lifecycle hooks wired (4 tools + 5 hooks via the public SDK)
- 36-patch installer for UI components from upstream PR #70071
- 470 unit tests across 15 files
- 6 P0 blockers from a 38-finding adversarial review fixed
- Verified end-to-end on a sandboxed gateway: `enter_plan_mode` → state persists → mutation gate blocks `write` → `exit_plan_mode` → markdown audit-trail lands at `~/.openclaw/agents/<id>/plans/`

## What it adds

| Surface | What |
|---|---|
| **Tools** | `enter_plan_mode`, `exit_plan_mode`, `ask_user_question`, `plan_mode_status` |
| **Slash commands** | `/plan accept`, `/plan accept edits`, `/plan revise <feedback>`, `/plan auto on\|off`, `/plan status`, `/plan view`, `/plan restate`, `/plan answer <text>` — universal across Telegram, Discord, Signal, iMessage, Slack, Matrix, web chat, CLI, etc. |
| **Approval card** | Inline plan card in the Control UI with approve / revise / view-full-plan controls (added by the installer's UI patches). |
| **Archetype prompt** | System-prompt fragment that steers GPT-5.x toward decision-complete plans (analysis, assumptions, risks, verification, references). Injected only when planMode === "plan". |
| **Mutation gate** | Blocks write/edit/exec/bash/etc tool calls while the session is in plan mode. Default fail-CLOSED on session-store errors (security gate). Read-only exec/bash prefixes (`ls`, `git status`, `cat`, etc.) allowed. |
| **Subagent gate** | `exit_plan_mode` refuses to submit while research subagents are still in flight (so post-approval tool calls aren't poisoned by stale child results). |
| **Plan persistence** | Every `exit_plan_mode` writes the canonical `~/.openclaw/agents/<id>/plans/plan-YYYY-MM-DD-<slug>.md` audit-trail file with title, summary, analysis, plan checklist, assumptions, risks, verification, references. |
| **Pending-injection queue** | `[PLAN_DECISION]: approved\|edited\|rejected`, `[QUESTION_ANSWER]: ...`, `[PLAN_MODE_INTRO]: ...`, `[PLANNING_RETRY]: ...` synthetic messages drained into the system context on the next turn. |
| **Ack-only retry** | When the agent ends a turn in plan mode without calling `exit_plan_mode`, queues a `[PLANNING_RETRY]` injection nudging it to actually submit. |
| **Cron heartbeat** | Optional gateway cron that nudges sessions stuck in plan mode > 30 min with no activity (registered when the host exposes `getCron()`). |
| **First-time intro** | One-shot `[PLAN_MODE_INTRO]` synthetic message on first plan-mode entry per session. |

## Install

Smarter-Claw v1.0 ships as a plugin AND an installer that patches the host's UI for plan-card / mode-dropdown / approval-card rendering. Both are needed for the full UX; the plugin alone (without the installer) gives you tools + archetype prompt + mutation gate but no UI affordances.

```bash
# 1. Install the plugin (npm, or local clone):
pnpm openclaw plugins install --dangerously-force-unsafe-install /path/to/Smarter-Claw

# 2. Run the installer to patch your OpenClaw host:
node /path/to/Smarter-Claw/installer/bin/install.mjs --host=/path/to/openclaw

# 3. Rebuild the host (the installer modifies src/ files):
cd /path/to/openclaw && pnpm build

# 4. Enable the plugin in your config:
pnpm openclaw plugins enable smarter-claw

# 5. Restart your gateway:
pnpm openclaw gateway restart
```

The `--dangerously-force-unsafe-install` flag is needed because the installer's `locate-host.mjs` uses `child_process` (for `npm root -g` discovery), which OpenClaw's plugin scanner flags as a dangerous pattern. The flag opts out of that scan for this trusted plugin.

After install, verify with:

```bash
pnpm openclaw plugins list  # smarter-claw should be loaded
node /path/to/Smarter-Claw/installer/bin/verify.mjs --host=/path/to/openclaw  # all 36 patches OK
```

## Uninstall

```bash
node /path/to/Smarter-Claw/installer/bin/uninstall.mjs --host=/path/to/openclaw
cd /path/to/openclaw && pnpm build  # rebuild after un-patching
pnpm openclaw plugins uninstall smarter-claw
```

The installer's manifest at `<hostPath>/.smarter-claw-install-manifest.json` records every patched file's expected SHA so uninstall reverses cleanly. Drift detection refuses to revert files that have been independently modified (use `--force` to override at your own risk).

## Configure

In your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "smarter-claw": {
        "enabled": true,
        "config": {
          "archetype": { "enabled": true },
          "mutationGate": { "enabled": true, "gateFailureMode": "closed" },
          "retry": { "enabled": true },
          "debugLog": false
        }
      }
    }
  }
}
```

All keys are optional — defaults apply when omitted. See `openclaw.plugin.json` for the full schema.

**Wired in v1.0:**
- `enabled` — master switch for the whole plugin
- `archetype.enabled` — toggle the archetype prompt injection
- `mutationGate.enabled` — toggle the before_tool_call mutation gate
- `mutationGate.gateFailureMode` — `"closed"` (default, secure) or `"open"` (transient-error tolerant)
- `retry.enabled` — toggle the agent_end ack-only retry
- `agents` — restrict the agent_end retry to specific agent ids (other handlers fall through to all-agents)
- `debugLog` — emit verbose plan-mode debug events to gateway logs

**Documented but v1.1 work** (config schema accepts but semantically no-op):
- `mutationGate.blockedTools`, `retry.limit`, `autoApprove.default`, `snapshot.persist`, `snapshot.maxStepsRendered`, `archetype.minStepCount`, full `agents` filter on every handler

See `index.ts:SmarterClawConfig` for the per-knob status comments.

## Use

### Enter plan mode

In the Control UI, click the mode chip and select **Plan mode**. Or type `/plan on`. Or have the agent call `enter_plan_mode` itself.

### Approve, revise, or auto-approve plans

When the agent proposes a plan via `exit_plan_mode`, an inline approval card renders. Click **Approve** / **Revise** / **View full plan**. Or via slash command on any channel:

```
/plan accept                      # approve as-is
/plan accept edits                # approve and accept any pending edits
/plan revise narrow timeout to 5s and skip steps 4-6
/plan auto on                     # enable auto-approve for this session
/plan auto off
/plan status                      # show current plan state
/plan restate                     # re-render the last plan checklist
/plan view                        # open the active plan in the side panel (Control UI only)
/plan answer 2                    # answer a pending ask_user_question (option 2)
```

### Ask the user a question

The agent can call `ask_user_question` with 2-6 multiple-choice options (and optional free-text). The card renders inline; the user's answer routes back as a `[QUESTION_ANSWER]: <text>` synthetic user message and plan mode stays armed.

## Architecture

Smarter-Claw is a Spicetify-style plugin: a pure OpenClaw plugin AT RUNTIME, but ships with a reversible installer that patches the host's UI files (so plan cards, mode dropdown, approval-card UI render natively in the Control UI without waiting for upstream PR #70071 to merge) and one tiny core diff (re-exports `updateSessionStoreEntry` so plugins can mutate session state).

### Plugin → SDK seams (no patcher required)

| OpenClaw seam | What we do |
|---|---|
| `api.registerTool(factory)` | Register the four agent-runtime tools as per-call factories so each dispatch sees the active `agentId` + `sessionKey` |
| `api.on("before_prompt_build", ...)` | Inject the plan archetype prompt + drain the pending-injection queue |
| `api.on("before_tool_call", ...)` | Run the mutation gate (default fail-CLOSED) |
| `api.on("session_start", ...)` | Fire the one-shot `[PLAN_MODE_INTRO]` injection |
| `api.on("subagent_spawning"\|"subagent_ended", ...)` | Track `blockingSubagentRunIds` for the exit_plan_mode subagent gate |
| `api.on("agent_end", ...)` | Detect ack-only turns and queue `[PLANNING_RETRY]` |
| `api.on("gateway_start", ...)` | Register the plan-nudge cron via `ctx.getCron()` (when available) |
| `api.registerCommand({ name: "plan", ... })` | Wire the `/plan` slash command surface |
| `SessionEntry.pluginMetadata['smarter-claw']` | Source of truth for plan-mode session state |

### Installer patches (host modification)

| Surface | Patches |
|---|---|
| **UI new files** (verbatim copies from PR #70071) | `ui/src/ui/chat/{plan-cards,mode-switcher,plan-resume}.ts` + tests, `ui/src/ui/views/plan-approval-inline.ts` + test, `ui/src/styles/chat/plan-cards.css` |
| **UI diffs** (additive mounts in existing files) | 13 i18n locale files (one key each), 2 CSS files, 6 `app-*.ts` files, 3 `chat/` files, `types.ts`, `views/chat.ts` |
| **Core diff** (1 file, 8 lines) | `src/plugin-sdk/session-store-runtime.ts` — re-export `updateSessionStore` and `updateSessionStoreEntry` so plugins can mutate session state |
| **Bundled-openclaw shadow** (synthetic) | At install time, swaps the plugin's `node_modules/openclaw` for a symlink to the host repo so dynamic `import("openclaw/plugin-sdk/...")` resolves to the host's PATCHED copy (and not the npm-published version that lacks `updateSessionStoreEntry`) |

This means UI patches AND the core diff are reversible via `installer/bin/uninstall.mjs` — every modification is recorded in `<hostPath>/.smarter-claw-install-manifest.json` with both `originalSha256` and `newSha256` so drift detection refuses to revert manually-modified files.

## Develop

```bash
git clone https://github.com/electricsheephq/Smarter-Claw.git
cd Smarter-Claw
pnpm install
pnpm test            # vitest run — 470 passing, 1 skipped
pnpm build           # tsc → dist/

# Install your local dev build into a local OpenClaw:
pnpm openclaw plugins install --dangerously-force-unsafe-install $(pwd)
node ./installer/bin/install.mjs --host=/path/to/openclaw
```

## Compatibility

| OpenClaw | Smarter Claw |
|---|---|
| `2026.4.22` | `1.0.x` |

The installer's UI patches and the one core diff are pinned to v2026.4.22 SHAs. Newer OpenClaw versions need a Smarter-Claw patch refresh — patches will refuse to apply on drifted source (drift detection is a feature, not a bug).

## Known limitations / v1.1 backlog

- **Slash-command dispatch via channel** is verified for the read-only subcommands (`/plan status`, `/plan restate`, etc); mutating subcommands work end-to-end but were verified via direct `applyPatchToState` unit tests, not a live channel-message round-trip.
- **`tool_result_persist` / `before_message_write` hooks don't fire** for plugin-registered tools through Pi (only fire for tools wrapped by `session-tool-result-guard`). The plan-markdown audit-trail write happens in the tool body itself as a workaround.
- **Multi-agent `agents` filter** is honored on the `agent_end` retry handler; other handlers fall through to all-agents behavior.
- **Per-cycle retry limit** (`retry.limit`) is documented but the queue's per-id dedup gives an effective limit of 1 today.
- **23 P1/P2/P3 review findings** are tracked at https://github.com/electricsheephq/Smarter-Claw/issues — the v1.1 sprint will close the remaining tech debt (install lock, perf cache, SHA TOCTOU hardening, etc.).

## License

[MIT](./LICENSE) © 2026 Electric Sheep HQ
