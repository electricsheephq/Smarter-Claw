# Smarter Claw 🦞

Plan Mode plugin for [OpenClaw](https://github.com/openclaw/openclaw) — plan-then-execute workflow with archetype prompting, mutation gate, escalating retry, accept-edits hard-constraint gate, and `/plan` session actions.

## Status

**`1.0.0-port.17` — OpenClaw 26.5.18 recovery candidate (2026-05-20).**

The 6-wave parity refresh closed all 2 P0 + 14/17 P1 Wave-1 findings,
built a 156-case mechanical parity-harness CI gate, and bumped the
minimum host version to `openclaw@2026.5.18`. Port `.17` adds the
stable-load contracts (`contracts.tools`), explicit CLI descriptors,
the runtime registration gate, and Telegram-native plan/question button
wiring. On stock `openclaw@2026.5.18`, the typed `/plan` fallback and
persisted Markdown plan path remain authoritative; Markdown attachment
delivery and native Telegram buttons activate when the host includes the
trusted `contracts.sessionAttachments: ["active-session"]` SDK seam.
See [`docs/audits/parity-refresh/FINAL-REPORT.md`](./docs/audits/parity-refresh/FINAL-REPORT.md)
for the full ship-readiness account.

`v1.0` public release is gated on the upstream OpenClaw chat-stream renderer
SDK seam — see [RELEASE_NOTES.md](./RELEASE_NOTES.md) "deferred to v1.0" +
[upstream draft PR `openclaw/openclaw#80982`](https://github.com/openclaw/openclaw/pull/80982).

For implementation history + the architecture rationale see
[architecture-v2-planning](https://github.com/electricsheephq/Smarter-Claw/tree/architecture-v2-planning/architecture-v2)
(17 architecture artifacts, ~9,800 lines covering parity catalog,
options analysis, adversarial review, parity-harness design, and the
final ship-ready verdict). [Epic #77](https://github.com/electricsheephq/Smarter-Claw/issues/77)
is the v1-port → v1.0.0 tracking issue.

The pre-v1 `0.2.0-dev` attempt (legacy installer-model plugin) has been
removed from `main` as of [PR #80](https://github.com/electricsheephq/Smarter-Claw/pull/80).
Anyone needing the legacy code can recover it from `main` history before
commit `47f3b73` — do not install it; it predates the SDK seams.

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

Minimum host version: `openclaw >= 2026.5.18` (declared via the canonical
`package.json#openclaw.install.minHostVersion` floor and mirrored in
`openclaw.plugin.json` for runtime metadata).

## Optional: chat-stream seam patch (for inline UI before upstream merges)

The plugin's v0.x sidebar UI works out of the box. For the v1.0 **inline UI** (mode-switcher chip, inline plan cards, input-bar suppression on pending approval), Smarter-Claw needs SDK seams that aren't in the upstream openclaw release yet — they're filed as draft PR [openclaw/openclaw#80982](https://github.com/openclaw/openclaw/pull/80982).

> **Status: upstream-blocked.** The patcher targets the `2026.5.10-beta.5`
> baseline; on the current `minHostVersion` (`2026.5.18`) the content-hashed
> bundle filenames the manifest keys on have rotated (`loader-DdN5GTsW.js`
> → `loader-CxUWY2_6.js`; `protocol-BBwaRnfZ.js` → `protocol-CdYy0xVK.js`
> + `protocol-B17omF7t.js`), so the patcher's SHA pre-flight refuses to
> apply (`process.exitCode === 3` / `4`). **Operators on `2026.5.18`
> should skip this section** — sidebar UI + `/plan` slash commands cover
> the supported UX. See [`docs/audits/parity-refresh/blocker-W1-S17-webchat-ui.md`](./docs/audits/parity-refresh/blocker-W1-S17-webchat-ui.md)
> for the full investigation and the upstream tracking
> ([electricsheephq/Smarter-Claw#78](https://github.com/electricsheephq/Smarter-Claw/issues/78)).
> Instructions below remain for completeness and for operators on the
> legacy `2026.5.10-beta.5` host baseline.

Until upstream PR [openclaw/openclaw#80982](https://github.com/openclaw/openclaw/pull/80982) merges + a regenerated manifest ships, you can (on a `2026.5.10-beta.5` host only) tactically apply the seam to your local `node_modules/openclaw/` via a small, reversible patcher:

```bash
# From the Smarter-Claw clone directory (host MUST be openclaw@2026.5.10-beta.5):
npm run patch:chat-stream-seam              # apply patch (with SHA pre-flight)
npm run patch:chat-stream-seam:verify       # check applied state
npm run patch:chat-stream-seam:uninstall    # restore originals
```

Or directly:

```bash
node scripts/install-chat-stream-seam.mjs --host /path/to/your/openclaw
```

What the patcher does:
- Validates the installed openclaw version matches the patcher's manifest (refuses on mismatch — `2026.5.18` exits 3)
- SHA256-checks the 2 dist files that will be replaced against the manifest's expected baseline (refuses on drift — use `--force` to override at your own risk)
- Backs up the originals into `node_modules/openclaw/.smarter-claw-backups/`
- Replaces 2 compiled JS bundle files with seam-built equivalents (~370KB total; ~80 lines of new code inside larger bundles)
- Writes a sentinel at `node_modules/openclaw/.smarter-claw-chat-stream-seam-applied.json`
- The plugin's startup advisory reports whether the patch is applied

The patch is a **temporary tactical unblock for the legacy `2026.5.10-beta.5` baseline**. When upstream openclaw merges PR #80982 into a published release, we'll bump `peerDependencies.openclaw` + drop the patcher.

## What works in 1.0.0-port.17

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
| Telegram-native approval/question buttons | ✅ with OpenClaw active-session attachment seam; `/plan` fallback on stock `26.5.18` |
| Markdown plan artifact persistence + attachment | ✅ persisted on stock `26.5.18`; attached when host seam is available |

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
| `api.registerInteractiveHandler` | `smarter-claw-plan` Telegram callback namespace for approve/revise/reject/cancel and option answers |
| `api.session.workflow.sendSessionAttachment` | Best-effort active-session plan/question presentation delivery; falls back when stock `26.5.18` blocks third-party attachments |
| `api.registerCli` | `openclaw plan-clear` rollback drain command |

## Develop

```bash
git clone https://github.com/electricsheephq/Smarter-Claw.git
cd Smarter-Claw
pnpm install
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest run
pnpm runtime-gate    # built-plugin registration contract smoke
pnpm build           # tsc → dist/
```

## Compatibility

| OpenClaw | Smarter Claw |
|---|---|
| `2026.5.18` and later | `1.0.0-port.17` (current recovery RC) |
| `2026.5.18` and later | `1.0.0-port.16` (parity-refresh RC; no Telegram-native button bridge) |
| `2026.5.10-beta.5` ... `<2026.5.18` | `1.0.0-port.15` (legacy; chat-stream patcher applies here only) |

Install-time compatibility is enforced via
`package.json#openclaw.install.minHostVersion`; runtime metadata is mirrored
in `openclaw.plugin.json`. Earlier host versions don't have the required SDK
seams.

## Known limitations

See [RELEASE_NOTES.md](./RELEASE_NOTES.md) "Known limitations" section.

## License

[PolyForm Noncommercial 1.0.0](./LICENSE) © 2026 Electric Sheep HQ.

**TL;DR**: free for noncommercial use — personal, hobby, research, education, public-interest, government. Commercial use (integrating Smarter-Claw into a paid product, hosted service, internal tooling at a for-profit company, or anything else where you make money from it) requires a separate paid commercial license. Open an issue at https://github.com/electricsheephq/Smarter-Claw/issues with the subject `[commercial]` to start that conversation.

The name "Smarter Claw" is a trademark of Electric Sheep HQ — see [TRADEMARK.md](./TRADEMARK.md) for what you can and can't do with the name (you can fork the code freely under the license; you just can't ship the fork under the same or a confusingly similar name).
