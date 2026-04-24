# Smarter Claw 🦞

Plan Mode for [OpenClaw](https://github.com/openclaw/openclaw) — plan-then-execute workflow with archetype prompting, mutation gate, ack-only retry, and cross-channel `/plan` slash commands.

Universal across the Pi runner (`openai/*`, `openai-codex/*`) and the native Codex app-server harness (`codex/*`).

## Status

**`0.2.0-dev`** — sandbox-verified, beta deployment pending.

This is dev-grade software. The code works in a sandboxed OpenClaw gateway,
but it has not yet been validated in real production use. The current commit
is in active development; the package is not yet published to npm; CI gating
is being set up; the first real release is the upcoming `0.2.0-beta.1` after
the operator's primary agent ("Eva") runs it for a defined soak period.

## Honesty section — what works, what doesn't, what's deferred

**Works in sandbox** (verified end-to-end on `/Users/lume/repos/sc-smoke-host`,
a clean v2026.4.22 worktree with the installer applied):

- 4 plan-mode tools (`enter_plan_mode`, `exit_plan_mode`, `ask_user_question`,
  `plan_mode_status`) registered via factory pattern with per-call session context
- Archetype prompt + injection-queue drain via `before_prompt_build`
- Mutation gate via `before_tool_call` (default fail-CLOSED on session-store IO errors)
- 3-detector × 7-level escalating-retry suite (PLAN_MODE_ACK_ONLY, PLAN_APPROVED_YIELD,
  PLANNING_ONLY) ported byte-perfect from openclaw-1
- Subagent gate inside `exit_plan_mode` (reads `blockingSubagentRunIds`)
- Snapshot persister with close-on-complete + `[PLAN_COMPLETE]` injection
- Plan-archetype markdown written to `~/.openclaw/agents/<id>/plans/plan-YYYY-MM-DD-<slug>.md`
- 41-patch installer with strict-context drift detection + reversible uninstall
- 570 unit tests across 19 files, all passing

**NOT yet validated:**

- Real-world soak under Eva's actual workload (sandbox ≠ production)
- npm publish path (package has never been pushed to the registry)
- Webchat inline-button approval routing under live UI traffic (logic ported
  + sandbox-tested, no real-user-clicks evidence yet)
- Multi-host installer behavior (only tested against the single sandbox worktree)

**Deferred to future milestones** (15 open issues tracked at
[github.com/electricsheephq/Smarter-Claw/issues](https://github.com/electricsheephq/Smarter-Claw/issues)):

- Per-session plan-nudge crons (today: global interval cron with payload-side filtering)
- Atomic manifest write (`writeManifest` is currently fsync-then-rename pending fix)
- Slash-command `/plan revise` input sanitization hardening
- 13 P2/P3 quality issues from the adversarial review

**Tagging history**: earlier commits in this repo carry `v1.0.0` and `v2.0.0`
tags. Those were dev-snapshot tags that were inappropriately framed as
"releases." They have been deleted; the work they marked is preserved as
`dev-snapshot-2026-04-24` and the version reset to `0.2.0-dev`. The first real
release will be `0.2.0-beta.1` after the Eva soak validates.

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

Smarter-Claw ships as a plugin AND an installer that patches the host's UI for plan-card / mode-dropdown / approval-card rendering. Both are needed for the full UX; the plugin alone (without the installer) gives you tools + archetype prompt + mutation gate but no UI affordances.

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
node /path/to/Smarter-Claw/installer/bin/verify.mjs --host=/path/to/openclaw  # all 41 patches OK
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

**Wired today:**
- `enabled` — master switch for the whole plugin
- `archetype.enabled` — toggle the archetype prompt injection
- `mutationGate.enabled` — toggle the before_tool_call mutation gate
- `mutationGate.gateFailureMode` — `"closed"` (default, secure) or `"open"` (transient-error tolerant)
- `retry.enabled` — toggle the agent_end ack-only retry
- `agents` — restrict the agent_end retry to specific agent ids (other handlers fall through to all-agents)
- `debugLog` — emit verbose plan-mode debug events to gateway logs

**Schema-accepted, no-op today** (tracked as open issues for a future milestone):
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

Smarter-Claw is a Spicetify-style plugin: plugin-owned runtime state plus a reversible installer that patches the host seams required for PR #70071 parity. The installer patches UI files for plan cards, mode dropdown, and approval-card rendering, and patches a narrow set of core gateway/session seams that current plugin hooks cannot express at 100% parity.

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
| **Core diffs** (6 files) | `plugin-sdk/session-store-runtime.ts` write seam; `gateway/protocol/schema/sessions.ts` and `gateway/sessions-patch.ts` plan approval actions; `gateway/session-utils*.ts` row forwarding; `agents/pi-embedded-subscribe.handlers.tools.ts` approval event bridge |
| **Bundled-openclaw shadow** (synthetic) | At install time, swaps the plugin's `node_modules/openclaw` for a symlink to the host repo so dynamic `import("openclaw/plugin-sdk/...")` resolves to the host's PATCHED copy (and not the npm-published version that lacks `updateSessionStoreEntry`) |

This means UI patches and core diffs are reversible via `installer/bin/uninstall.mjs` — every modification is recorded in `<hostPath>/.smarter-claw-install-manifest.json` with both `originalSha256` and `newSha256` so drift detection refuses to revert manually-modified files.

## Develop

```bash
git clone https://github.com/electricsheephq/Smarter-Claw.git
cd Smarter-Claw
pnpm install
pnpm test            # vitest run — 570 passing, 1 skipped
pnpm build           # tsc → dist/

# Install your local dev build into a local OpenClaw:
pnpm openclaw plugins install --dangerously-force-unsafe-install $(pwd)
node ./installer/bin/install.mjs --host=/path/to/openclaw
```

## Compatibility

| OpenClaw | Smarter Claw |
|---|---|
| `2026.4.22` | `0.2.x-dev` (target for first beta release) |

The installer's UI patches and core diffs are pinned to v2026.4.22 SHAs. Newer OpenClaw versions need a Smarter-Claw patch refresh — patches will refuse to apply on drifted source (drift detection is a feature, not a bug).

## Known limitations (tracked as issues)

All non-blocker work is in [open issues](https://github.com/electricsheephq/Smarter-Claw/issues) with explicit milestones (`v0.2.0-beta`, `v0.3.0`, `v1.0.0-stable`). Highlights:

- **Slash-command dispatch via channel** — read-only subcommands (`/plan status`, `/plan restate`) verified; mutating subcommands proven via unit tests but not via a live channel-message round-trip.
- **`tool_result_persist` / `before_message_write` hooks don't fire** for plugin-registered tools through Pi. Plan-markdown audit-trail write happens in the tool body as a workaround.
- **Multi-agent `agents` filter** is honored on the `agent_end` retry handler; other handlers fall through to all-agents behavior.
- **Per-cycle retry limit** (`retry.limit`) — queue's per-id dedup gives an effective limit of 1 today; multi-injection cap is roadmap.
- **Per-session plan-nudge crons** — today uses a global interval cron with payload-side filtering; openclaw-1 used per-session one-shots scheduled inside `enter_plan_mode`.
- **15 open P2/P3 review findings** — install-lock, perf-cache, SHA-TOCTOU hardening, etc. None block the beta deployment plan.

## License

[PolyForm Noncommercial 1.0.0](./LICENSE) © 2026 Electric Sheep HQ.

**TL;DR**: free for noncommercial use — personal, hobby, research, education, public-interest, government. Commercial use (integrating Smarter-Claw into a paid product, hosted service, internal tooling at a for-profit company, or anything else where you make money from it) requires a separate paid commercial license. Open an issue at https://github.com/electricsheephq/Smarter-Claw/issues with the subject `[commercial]` to start that conversation.

The name "Smarter Claw" is a trademark of Electric Sheep HQ — see [TRADEMARK.md](./TRADEMARK.md) for what you can and can't do with the name (you can fork the code freely under the license; you just can't ship the fork under the same or a confusingly similar name).
