# Smarter-Claw Release Notes

## 1.0.0-port.16 — parity refresh, host bump to 2026.5.18, Wave-6 finding fixes (2026-05-20)

The 6-wave Parity-Refresh closed the audit cycle and brought the plugin
to release-ready: 2/2 P0 + 14/17 P1 Wave-1 findings shipped (3 P1
deferred to documented upstream SDK blockers), 1.0.0-port.15's host
bumped from `openclaw@2026.5.10-beta.5` to `openclaw@2026.5.18`,
156-case Layer-1 parity-harness CI gate built around 8 load-bearing
surfaces, and the Wave-6 P1 findings (`wave-6-findings.md`) addressed
in this bump.

See [`docs/audits/parity-refresh/FINAL-REPORT.md`](./docs/audits/parity-refresh/FINAL-REPORT.md)
for the full ship-readiness account and per-wave summary.

### What changed since `1.0.0-port.15`

- **Host minimum bumped to `openclaw@2026.5.18`** (Wave-0; #97). Plugin
  is typecheck-clean + test-clean against the new SDK.
- **Parity-harness CI gate landed** (Wave-2; #118). 8 checks pin
  ~156 cases against vendored in-host references / byte fixtures at
  commit `ea04ea52c7`.
- **All Wave-3 fixes shipped** (#99, #108–#117). Closes W1-A1/A3/A5,
  W1-B4, W1-C1, W1-D1/D2, W1-E2, W1-F4/F5, W1-S9-1/S9-2, W1-S18-1 and
  both P0s (W1-F1 deferred-to-SDK; W1-F2 implemented).
- **Cross-surface build** (Wave-4; #119). W1-F5 closed via
  `PendingQuestion` store field + `/plan answer` cross-surface wiring.
- **Wave-6 P1 fixes** (this release):
  - **W6-1**: README + RELEASE_NOTES version drift corrected;
    chat-stream patcher framed honestly as upstream-blocked on
    `2026.5.18`; new CI assertion (`scripts/check-host-version-parity.mjs`)
    locks `openclaw.plugin.json` `minHostVersion` to `package.json`
    `devDependencies.openclaw`.
  - **W6-2**: `plan-render.ts` added to the parity-harness with a new
    `plan-render` byte-fixture check that diffs the plugin's
    `renderFullPlanArchetypeMarkdown` against a vendored in-host
    reference across a curated input matrix. Closes the
    "byte-faithful claim, no byte-fixture pin" antipattern.

### Test footprint at `1.0.0-port.16`

`pnpm test`: 868+ tests pass across 39+ test files; parity-harness
9+ checks / 160+ cases parity-clean against in-host `ea04ea52c7`.

### Known limitations

Carried over from `1.0.0-port.15`:

1. **W1-F1 / W1-F3 (push notifications)** — `bundled-plugin-only` SDK
   seams; resolution path works on every channel via `/plan` commands,
   but the proactive push is blocked. See [`blocker-W1-F1.md`](./docs/audits/parity-refresh/blocker-W1-F1.md)
   and [`blocker-W1-F3.md`](./docs/audits/parity-refresh/blocker-W1-F3.md).
2. **W1-S17 (webchat inline UI)** — upstream PR #80982 still open +
   drifted; chat-stream patcher does NOT apply on `2026.5.18`
   (content-hashed bundle names rotated). Sidebar approval card +
   `/plan` slash commands are the supported UX. See
   [`blocker-W1-S17-webchat-ui.md`](./docs/audits/parity-refresh/blocker-W1-S17-webchat-ui.md).
3. **W1-E6 (incomplete-turn detector)** — SDK declares `messages?: unknown[]`
   on `before_agent_finalize` but the runtime does NOT populate it;
   status-quo `stopHookActive` proxy stays (wastes a turn on tool-using
   turns; doesn't break correctness). See [`blocker-W1-E6.md`](./docs/audits/parity-refresh/blocker-W1-E6.md).
4. **W6 P2 carryovers** — `grantLedger.get()` still unconsumed (W6-5 /
   E-11), escalating-retry `attemptIndex` never plumbed (W6-7 / E-10),
   `event.provider`/`event.model` not threaded through `TurnSignal`
   (W6-6 / E-4), `register(api)` not invoked in CI (W6-4 / E-9),
   grant-ledger pruned on `rejected` despite re-approvable state
   (W6-3, latent). All non-blocking; tracked for next maintenance
   cycle. See [`wave-6-findings.md`](./docs/audits/parity-refresh/wave-6-findings.md).

### Recommendation

**PROCEED to live-gateway smoke + tag.** The release candidate is
parity-clean against the in-host source-of-truth on every load-bearing
surface the harness covers, including the new `plan-render.ts` pin
added in this release. All P0 / P1 Wave-1 + Wave-6 findings that can
be addressed without new SDK seams are closed.

---

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
