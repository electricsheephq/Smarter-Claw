# Smarter-Claw Release Notes

## 1.0.0-port.15 — surgical re-port to byte-identical in-host parity (2026-05-12)

Five surgical PRs (#86, #87, #88, #89, #90) re-ported load-bearing
plan-mode code verbatim from in-host commit `ea04ea52c7`, closing
**32 P0 drifts** identified in the Wave-1 audit. The plugin is now
byte-identical to the in-host on every model-facing surface
(tool descriptions, system prompts, retry instructions, approved-plan
preambles, state-machine transitions).

### Why this version exists

The Wave-1 audit (10 parallel slice reports, 138 unique findings)
found that the v1.0.0-port.14 baseline had diverged from the in-host
source-of-truth on multiple critical surfaces — descriptions had been
paraphrased (~70% drift on enter/exit tool desc), the system-prompt
inline injection was missing the ACTION CONTRACT and Investigation
Phase blocks, the approved-plan injection was a bare opener instead
of the full preamble, the escalating-retry detector had no FIRM/FINAL
tiers, and the accept-edits trigger over-fired on autoApprove.

This release closes all 32 P0 drifts that could be addressed without
new SDK seams. Remaining ~10 P0s are either shared bugs in both
plugin and in-host (would require divergent fix; tracked as upstream
follow-ups) or gateway-side concerns needing new SDK seams (tracked
in epic #77 / blocker #78).

### What changed (per PR)

| PR | Slice | Surgical action |
|---|---|---|
| #86 | S8 | `resolvePlanApproval` verbatim port (state machine); typed mutators (`recordApproval`, `recordRejection`, new `recordTimeout`) delegate via reference-equality no-op detection |
| #87 | S1 | `enter_plan_mode` + `exit_plan_mode` description + schema + validation re-port; title required + 80-char clamp + 5 archetype fields + parser + archetype field echoing |
| #88 | S4/S5 | system-prompt injection verbatim (ACTION CONTRACT + Investigation Phase + PLAN MODE AVAILABLE); `plan.accept` emits full `buildApprovedPlanInjection`; `plan.edit` (no body) emits full `buildAcceptEditsPlanInjection`; auto-enable matcher ported |
| #89 | S7 | all retry instruction constants + regex constants verbatim; FIRM/FINAL escalation tiers per `resolveEscalatingPlanningRetryInstruction`; COMPLETION_RE guard added |
| #90 | S12 | accept-edits trigger fixed (drop `autoApprove === true` over-fire — now `approval === "edited"` only, matching in-host `postApprovalPermissions.acceptEdits`); 23 positive tests for coded-but-untested patterns (P0 #4-#10) |

### Confidence assessment

**HIGH (95%+)**: state machine, tool surface, system-prompt, injection
text, retry instructions, gate algorithm + trigger predicate.

**MODERATE (~70-85%)**: coarse-grained retry detection (the in-host
inspects toolMetas + replayMetadata; the plugin uses turn-boundary
signals only — SDK doesn't expose runner internals).

**Needs live-gateway verification**: real LLM behavior under the new
injection texts; concurrent approval flows under realistic load;
operator UX with the trigger-predicate fix.

### Test footprint at 1.0.0-port.15

`pnpm test`: **~700 tests pass across 30+ test files** (up from 615
at 1.0.0-port.14 — 86 new tests pinning in-host parity).

### Recommendation

Per Wave-1.5 audit (`docs/audits/wave-1.5-post-surgical-summary.md`):
**PROCEED to live-gateway testing.** All audit findings that can be
fixed without new SDK seams are closed; the plugin is byte-identical
to in-host on every model-facing surface.

### Known limitations (carried over from 1.0.0-port.14 + new)

1. Same as 1.0.0-port.14 — no persistent grant ledger, no inline UI,
   plan-clear single-session, etc.

2. **`bash -c "rm -rf"` quoted body bypass**: SHARED with in-host.
   The gate doesn't analyze command bodies inside quoted strings.
   Fix requires shell-aware parser; would need to land in-host first
   to preserve parity.

3. **Trailing-slash path normalization bypass**: SHARED with in-host.
   `~/.openclaw/` normalizes to `~/.openclaw` which fails the
   startsWith check against `~/.openclaw/`. Same `normalizeCandidatePath`
   function in both.

4. **Command-chain bypass**: SHARED with in-host. `ls && rm -rf` etc.
   not caught — prefix match anchors at start-of-command.

5. **Gateway-side toolMeta detection gaps**: the in-host's retry
   detector uses `EmbeddedRunAttemptResult.toolMetas` to count
   plan-only vs real tool calls. SDK doesn't expose this; the plugin
   uses coarser turn-boundary signals. Documented in
   `src/runtime/escalating-retry.ts` file-level docstring.

---

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
