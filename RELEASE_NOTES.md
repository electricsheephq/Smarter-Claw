# Smarter-Claw Release Notes

## 1.0.0-port.14 — v0.x internal-release prep (2026-05-12)

End of the backend-first ladder (P-1 through P-14). The plugin is
**internally usable** — Eva or any operator with `allowConversationAccess: true`
can install it against `openclaw@2026.5.10-beta.5`+ and run the full
plan-mode workflow via the sidebar UI + slash commands.

**Not yet public-release-ready.** v1.0 is gated on upstream OpenClaw
SDK seams (chat-stream rendering) that don't exist yet — see
[architecture-v2/15-CURRENT_STATE_FOR_EVA.md](https://github.com/electricsheephq/Smarter-Claw/blob/architecture-v2-planning/architecture-v2/15-CURRENT_STATE_FOR_EVA.md)
"Upstream SDK gaps" section.

### What works in 1.0.0-port.14

| Feature | Status |
|---|---|
| `enter_plan_mode` tool | ✅ |
| `exit_plan_mode` tool | ✅ |
| `ask_user_question` tool | ✅ |
| Plan-mode session-extension state (`plan-mode` namespace) | ✅ |
| 10-invariant `persistApprovalRequest` race-fix | ✅ |
| Mutation gate (`before_tool_call`, 116 adversarial cases) | ✅ |
| Plan-archetype prompt injection (`before_prompt_build`) | ✅ |
| Plan reference card | ✅ |
| Pending-injections compose contract | ✅ |
| Plan-tier model override (`before_model_resolve`) | ✅ |
| Escalating retry (3 detectors, `before_agent_finalize`) | ✅ |
| Rejection cycle tracking + deescalation hint | ✅ |
| Plan-decision + question-answer injection writers | ✅ |
| Sidebar UI descriptor (`registerControlUiDescriptor`) | ✅ |
| Session actions: `plan.accept` / `edit` / `reject` / `cancel` / `answer` / `auto.toggle` | ✅ |
| `openclaw plan-clear` CLI sweep command | ✅ |
| Accept-edits constraint gate (72 adversarial cases) | ✅ |
| `autoApprove` toggle (state mutator) | ✅ |
| Approval grant ledger (approvalId ↔ approvalRunId correlation) | ✅ |
| Plan-mode debug log (opt-in via env or `pluginConfig.debug`) | ✅ |
| Layer 1+2 parity harness | ✅ |
| Layer 3 drift cron (scheduled) | ✅ |

### What's deferred to v1.0 (upstream-blocked)

| Feature | Gating |
|---|---|
| Inline chat-stream UI (mode-switcher chip, inline plan cards) | Upstream `registerChatStreamRenderer` SDK seam |
| Input-bar suppression on pending approval | Same seam as above |
| Mass `plan-clear --all-sessions` sweep | Upstream session-enumeration seam |
| Hard-enforced startup operator-config validation | Upstream `registerStartupCheck` seam (medium priority — current session-start advisory works) |

### Operator setup

Required plugin config:
```yaml
plugins:
  entries:
    smarter-claw:
      hooks:
        allowConversationAccess: true
      # Optional (P-9): route plan-mode turns to a specific model.
      planTierModel: anthropic/claude-opus-4
      # Optional (P-14): opt-in structured debug logging.
      debug: false
```

Required host version: `openclaw@2026.5.10-beta.5` or later.

### Test footprint at the v0.x baseline

`pnpm test`: **551 tests pass across 26 test files**

### Source-of-truth parity

All implementations cite their in-host counterpart at
`/Users/lume/repos/openclaw-pr70071-rebase` commit `ea04ea52c7` (the
PR #70071 work + 8 fix commits including the empty-plan-body
race-fix at commit `1081067476`).

### Distribution

This release ships as a **direct-install plugin** — clone the repo
and point your operator's plugin entry at the workspace path:

```yaml
plugins:
  entries:
    smarter-claw:
      source: file:/path/to/Smarter-Claw
      hooks:
        allowConversationAccess: true
```

ClawHub publication is deferred to v1.0.

### Known limitations

1. **No persistent grant ledger**: the (approvalId, approvalRunId, sessionKey)
   correlation map is process-local. Plugin restart resets it. The
   canonical data still lives on the session row, so this only affects
   cross-restart debug-log enrichment.

2. **No inline UI**: the sidebar widget is the only UX surface in v0.x.
   Operators expecting in-chat plan cards should wait for v1.0.

3. **autoApprove runtime is partial**: `setAutoApprove` mutator lands at
   P-13 and the gate reads the flag; the runtime side that actually
   FIRES auto-approve on `exit_plan_mode` (skipping the pending state)
   lands at P-final alongside the inline UI work.

4. **plan-clear is single-session**: mass sweep needs an upstream
   session-enumeration seam.

---

## Earlier port versions

The pre-v1 `0.2.0-dev` attempt has been removed from `main` as of PR #80
(2026-05-12). It predated the SDK seams that landed in
`openclaw@2026.5.10-beta.5` and would not work against the current host.
Anyone needing the legacy code can recover it from git history before
commit `47f3b73`.
