# Smarter Claw 🦞

Plan Mode, Auto-Plan Mode, and every mode for [OpenClaw](https://github.com/openclaw/openclaw).

Your OpenClaw will now track what they are doing, build plans on their own, update them, and save them to your `/docs/` to be ingested into your memory tools. Adds plan-then-execute workflow with archetype prompting, mutation gate, ack-only retry, and cross-channel `/plan` slash commands. Universal across the Pi runner (`openai/*`, `openai-codex/*`) and the native Codex app-server harness (`codex/*`).

## Status

`v0.1.0` — initial extraction from the OpenClaw `feat/plan-channel-parity` branch ([PR-7…PR-11 history](https://github.com/openclaw/openclaw/pulls?q=is%3Apr+plan-mode)). Built against OpenClaw `>=2026.4.22` plugin SDK.

## What it adds

| Surface | What |
|---|---|
| **Tools** | `enter_plan_mode`, `exit_plan_mode`, `ask_user_question`, `plan_mode_status` |
| **Modes** | Plan, Plan (auto-approve), plus the existing Default / Ask each mutation / Accept edits / Bypass |
| **Slash commands** | `/plan accept`, `/plan accept edits`, `/plan revise <feedback>`, `/plan auto on|off`, `/plan status`, `/plan view`, `/plan restate` — universal across Telegram, Discord, Signal, iMessage, Slack, Matrix, web chat, CLI, etc. |
| **Approval card** | Inline plan card in the Control UI with approve / revise / view-full-plan controls. Cross-channel rendering for chat surfaces. |
| **Archetype prompt** | System-prompt fragment that steers GPT-5.x toward decision-complete plans (analysis, assumptions, risks, verification, references). |
| **Mutation gate** | Blocks write/edit/exec tool calls while the session is in plan mode so plans propose without executing. |
| **Ack-only retry** | Detects when the agent produces planning text without calling `exit_plan_mode` and injects a `[PLANNING_RETRY]` synthetic message to nudge action. |
| **Cron nudges** | Optional cron job that re-surfaces stale plans in the user's heartbeat queue. |

## Install

```bash
# In your OpenClaw extensions directory:
pnpm openclaw plugins install @electricsheephq/smarter-claw

# Or from a local checkout (during development):
pnpm openclaw plugins install /path/to/Smarter-Claw

# Enable in your OpenClaw config:
pnpm openclaw plugins enable smarter-claw

# Restart your gateway:
pnpm openclaw gateway restart
```

After install, the plugin appears as `smarter-claw` in `pnpm openclaw plugins list` and its tools (`enter_plan_mode`, `exit_plan_mode`, `ask_user_question`, `plan_mode_status`) appear in the agent's tool catalog.

## Configure

In your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "smarter-claw": {
        "enabled": true,
        "config": {
          "archetype": { "enabled": true, "minStepCount": 3 },
          "mutationGate": { "enabled": true },
          "retry": { "enabled": true, "limit": 2 },
          "autoApprove": { "default": false },
          "snapshot": { "persist": true, "maxStepsRendered": 100 },
          "debugLog": false
        }
      }
    }
  }
}
```

All keys are optional — defaults apply when omitted. See `openclaw.plugin.json` for the full schema and per-key UI hints.

## Use

### Enter plan mode

In the Control UI, click the mode chip (bottom-left) and select **Plan mode** (Ctrl+4) or **Plan (auto-approve)** (Ctrl+5). Or type `/plan on`. Or have the agent call `enter_plan_mode` itself.

### Approve, revise, or auto-approve plans

When the agent proposes a plan via `exit_plan_mode`, an inline approval card renders:

- Click **Approve** → agent begins execution
- Click **Revise** → opens an inline textarea for feedback; agent reworks the plan
- Click **View full plan** → opens the full plan in the right sidebar
- Toggle **Auto-approve** (the ⚡ chip) → next plan auto-executes without confirmation

Or via slash command, on any channel:

```
/plan accept                      # approve as-is
/plan accept edits                # approve and accept any pending edits
/plan revise narrow the timeout window to 5s and skip steps 4-6
/plan auto on                     # enable auto-approve for this session
/plan auto off
/plan status                      # show current plan state
/plan restate                     # re-render the last plan checklist
```

### Ask the user a question

The agent can call `ask_user_question` with 2-6 multiple-choice options (and an optional free-text "Other" field). The card renders inline; the user's answer routes back as a `[QUESTION_ANSWER]: <text>` synthetic user message and plan mode stays armed.

## Architecture

Smarter Claw is a pure OpenClaw plugin — it lives entirely outside the OpenClaw tree. It depends only on the public plugin SDK (`openclaw/plugin-sdk/*`) and a small core extension (`SessionEntry.pluginMetadata` namespace, available in OpenClaw `>=2026.4.22` once the upstream PR lands).

The plugin attaches to OpenClaw via:

| OpenClaw seam | What we do |
|---|---|
| `api.registerTool(...)` | Register the four agent-runtime tools |
| `api.registerHook("before_prompt_build", ...)` | Inject the plan archetype prompt fragment |
| `api.registerHook("tool_result", ...)` | Run the mutation gate / accept-edits gate |
| `api.registerHook("agent_end", ...)` | Ack-only detection → `[PLANNING_RETRY]` synthetic injection |
| `api.registerCommand({ name: "plan", ... })` | Wire the `/plan` slash command surface |
| `SessionEntry.pluginMetadata['smarter-claw']` | Persist plan-mode session state (planMode, planApproval, autoApprove, lastPlanSteps, etc.) |

This means the plugin is harness-agnostic: the same code runs whether the agent is on the Pi runner (`openai/*`, `openai-codex/*`) or the native Codex app-server (`codex/*`).

UI components (the mode-switcher chip + plan approval card + slash-command executor) live in OpenClaw core (`ui/src/ui/`) — bundled UI for Control UI shows the plan cards, mode dropdown, and Ctrl+1–6 keyboard shortcuts. Once the upstream `registerUIComponent()` SDK seam exists, the UI can move into this plugin too.

## Develop

```bash
git clone https://github.com/electricsheephq/Smarter-Claw.git
cd Smarter-Claw
pnpm install
pnpm test            # vitest run
pnpm build           # tsc → dist/

# Install your local dev build into a local OpenClaw:
pnpm openclaw plugins install $(pwd)
```

## Compatibility

| OpenClaw | Smarter Claw |
|---|---|
| `>=2026.4.22` | `0.1.x` |

Requires the `SessionEntry.pluginMetadata` namespace landed in OpenClaw upstream. If your OpenClaw version pre-dates that, install the patched OpenClaw branch (PR link TBD).

## License

[MIT](./LICENSE) © 2026 Electric Sheep HQ
