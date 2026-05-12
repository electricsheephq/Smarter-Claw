# Smarter Claw 🦞

Plan Mode plugin for [OpenClaw](https://github.com/openclaw/openclaw) — plan-then-execute workflow with archetype prompting, mutation gate, escalating retry, accept-edits hard-constraint gate, and `/plan` session actions.

## Status

**`1.0.0-port.14` — v0.x internal-release prep (2026-05-12).**

End of the backend-first ladder. All 14 backend PRs (P-1 through P-14)
have shipped. The plugin is **internally usable** against
`openclaw@2026.5.10-beta.5`+; sidebar UI + slash commands work
end-to-end. **551 tests pass across 26 test files.**

`v1.0` public release is gated on upstream OpenClaw SDK seams (chat-stream
rendering) — see [RELEASE_NOTES.md](./RELEASE_NOTES.md) "deferred to v1.0"
table.

For implementation history + the architecture rationale see
[architecture-v2-planning](https://github.com/electricsheephq/Smarter-Claw/tree/architecture-v2-planning/architecture-v2)
(17 architecture artifacts, ~9,800 lines).

The prior `0.2.0-dev` attempt is preserved under `legacy/` for reference;
**do not install it** — it predates the SDK seams.

## Required Operator Config

The plugin's full plan-mode behavior (archetype injection, escalating
retry, plan-tier model override) requires the conversation-access flag:

```yaml
plugins:
  entries:
    smarter-claw:
      hooks:
        allowConversationAccess: true
      # Optional: route plan-mode turns to a specific model.
      planTierModel: anthropic/claude-opus-4
      # Optional: structured plan-mode debug log.
      debug: false
```

The mutation gate (`before_tool_call`) works without this flag, but most
of the plugin requires it. An advisory message fires on every new session
start when the flag is missing.

Minimum host version: `openclaw >= 2026.5.10-beta.5` (declared via
`minHostVersion` in `openclaw.plugin.json`).

## What works in 1.0.0-port.14

| Feature | Status |
|---|---|
| `enter_plan_mode` / `exit_plan_mode` / `ask_user_question` tools | ✅ |
| Plan-mode session-extension state (`plan-mode` namespace) | ✅ |
| 10-invariant `persistApprovalRequest` race-fix | ✅ |
| Mutation gate (`before_tool_call`, 116 adversarial cases) | ✅ |
| Plan-archetype prompt injection (`before_prompt_build`) | ✅ |
| Plan reference card | ✅ |
| Pending-injections compose contract | ✅ |
| Plan-tier model override (`before_model_resolve`) | ✅ |
| Escalating retry (3 detectors, `before_agent_finalize`) | ✅ |
| Rejection cycle tracking + deescalation hint at ≥3 | ✅ |
| Plan-decision + question-answer injection writers | ✅ |
| Sidebar UI descriptor (`registerControlUiDescriptor`) | ✅ |
| Session actions: `plan.accept` / `edit` / `reject` / `cancel` / `answer` / `auto.toggle` | ✅ |
| `openclaw plan-clear` CLI sweep command | ✅ |
| Accept-edits constraint gate (72 adversarial cases) | ✅ |
| `autoApprove` toggle (state mutator) | ✅ |
| Approval grant ledger + structured debug log | ✅ |
| Parity harness (Layer 1, 2, 3-cron) | ✅ |

## Deferred to v1.0 (upstream-blocked)

- **Inline chat-stream UI** — mode-switcher chip, inline plan cards, input-bar suppression on pending approval. Needs upstream `registerChatStreamRenderer` (or equivalent) SDK seam.
- **Mass `plan-clear --all-sessions` sweep** — needs upstream session-enumeration seam.

## v0.x dev install

```yaml
plugins:
  entries:
    smarter-claw:
      source: file:/path/to/this/clone
      hooks:
        allowConversationAccess: true
```

Then restart the gateway. ClawHub publication is deferred to v1.0.

## Source-of-truth parity

Every plugin module's `host_ref:` comment points at the in-host
counterpart at `/Users/lume/repos/openclaw-pr70071-rebase` commit
`ea04ea52c7` (the PR #70071 work + 8 fix commits including the
empty-plan-body race-fix at commit `1081067476`).

## Plugin → SDK seams

The plugin attaches to OpenClaw via plugin-SDK seams only — no host
patches required. Every line of plugin code is defensible by pointing
at the in-host code it mirrors (see `host_ref:` comments in each file).

| OpenClaw seam | What we do |
|---|---|
| `api.session.state.registerSessionExtension` | Reserves the `plan-mode` namespace; plugin owns ALL state writes through `PlanModeStore` typed mutators |
| `api.registerTool` (×3) | `enter_plan_mode`, `exit_plan_mode`, `ask_user_question` |
| `api.on("before_tool_call")` | Layer 1: mutation gate (plan mode); Layer 2: accept-edits constraint gate (post-approval) |
| `api.on("before_prompt_build")` | Archetype injection + reference card via `appendSystemContext` (prompt-cached) |
| `api.on("before_model_resolve")` | Optional plan-tier model override |
| `api.on("before_agent_finalize")` | Escalating retry (PLAN_YIELD / PLAN_ACK_ONLY / PLANNING_RETRY) |
| `api.on("session_start")` | Degraded-state advisory when `allowConversationAccess` missing |
| `api.session.controls.registerSessionAction` (×6) | `plan.accept` / `plan.edit` / `plan.reject` / `plan.cancel` / `plan.answer` / `plan.auto.toggle` |
| `api.session.controls.registerControlUiDescriptor` | Sidebar widget descriptor |
| `api.session.workflow.enqueueNextTurnInjection` | `[PLAN_DECISION]:` and `[QUESTION_ANSWER]:` writers |
| `api.registerCli` | `openclaw plan-clear` rollback drain command |

## Develop

```bash
git clone https://github.com/electricsheephq/Smarter-Claw.git
cd Smarter-Claw
pnpm install
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest run — 551 tests across 26 files
pnpm build           # tsc → dist/
```

## Compatibility

| OpenClaw | Smarter Claw |
|---|---|
| `2026.5.10-beta.5` and later | `1.0.0-port.14` (current v0.x dev) |

`minHostVersion` is enforced via `openclaw.plugin.json`. Earlier host
versions don't have the required SDK seams.

## Known limitations

See [RELEASE_NOTES.md](./RELEASE_NOTES.md) "Known limitations" section.

## License

[PolyForm Noncommercial 1.0.0](./LICENSE) © 2026 Electric Sheep HQ.

**TL;DR**: free for noncommercial use — personal, hobby, research, education, public-interest, government. Commercial use (integrating Smarter-Claw into a paid product, hosted service, internal tooling at a for-profit company, or anything else where you make money from it) requires a separate paid commercial license. Open an issue at https://github.com/electricsheephq/Smarter-Claw/issues with the subject `[commercial]` to start that conversation.

The name "Smarter Claw" is a trademark of Electric Sheep HQ — see [TRADEMARK.md](./TRADEMARK.md) for what you can and can't do with the name (you can fork the code freely under the license; you just can't ship the fork under the same or a confusingly similar name).
