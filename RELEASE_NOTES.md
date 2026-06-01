# Smarter-Claw Release Notes

## 1.0.0-port.21 — Release-artifact runtime dependency gate for OpenClaw v2026.6.1-beta.1 (2026-06-01)

This follow-up release supersedes `1.0.0-port.20`. The new release-artifact
scenario smoke found that the published `.20` tarball imported `typebox` at
runtime while listing it only in `devDependencies`. Source and CI tests passed
because the workspace had dev dependencies installed, but a production consumer
could fail while loading the shipped plugin entrypoint.

Install spec:

```text
https://github.com/electricsheephq/Smarter-Claw/releases/download/v1.0.0-port.21/electricsheephq-smarter-claw-1.0.0-port.21.tgz
```

### What changed since `1.0.0-port.20`

- Bumped the package to `1.0.0-port.21`.
- Moved `typebox` to production `dependencies` because the shipped tool modules
  import it at runtime.
- Added `scripts/release-artifact-scenario-smoke.mjs`, which validates the
  packed or published tarball with dev dependencies omitted before importing
  the shipped `dist/` plugin entrypoint.
- Added a dispatchable `release-artifact-scenarios` GitHub workflow so the
  published tarball can be re-smoked remotely by URL.

### Validation

- Release gating for this port includes the source checks from `.20` plus the
  release-artifact scenario smoke: production dependency install, plugin
  registration surface, plan approve, reject/revise, cancel, managed TaskFlow
  visibility, and the OpenClaw 6.1 active-session host-seam release gate.

## 1.0.0-port.20 — GitHub-tarball install spec for OpenClaw v2026.6.1-beta.1 (2026-06-01)

This follow-up release keeps the `v2026.6.1-beta.1` runtime target from
`1.0.0-port.19` and fixes the distribution metadata: the package is not
published to npm in this environment, so `package.json#openclaw.install.npmSpec`
now points at the GitHub release tarball instead of the absent npm package.

Install spec:

```text
https://github.com/electricsheephq/Smarter-Claw/releases/download/v1.0.0-port.20/electricsheephq-smarter-claw-1.0.0-port.20.tgz
```

### What changed since `1.0.0-port.19`

- Bumped the package to `1.0.0-port.20`.
- Replaced `package.json#openclaw.install.npmSpec` with the GitHub release
  tarball URL so OpenClaw-compatible installers can fetch the exact artifact
  without npm registry credentials.
- Added release metadata coverage so a GitHub-only release fails CI if it
  points at an unpublished npm package again.

### Validation

- Release gating for this port is the release PR plus final tag checks:
  host-version parity, release metadata tests, runtime gate, full Vitest, build,
  pack, extracted tarball metadata smoke, and GitHub PR checks before tagging.

## 1.0.0-port.19 — OpenClaw v2026.6.1-beta.1 release target (2026-06-01)

This maintenance pass moves the recovery line from `2026.5.x` to the
OpenClaw GitHub release
[`v2026.6.1-beta.1`](https://github.com/openclaw/openclaw/releases/tag/v2026.6.1-beta.1)
at commit `2fc497e67b9cf40b2c12a9355afd785e7f8672dc`.

### Compatibility truth

- `openclaw@2026.6.1-beta.1` is not published on npm. The package keeps
  `package.json#openclaw.target.version`, `openclaw.plugin.json`
  `minHostVersion`, `peerDependencies.openclaw`, and
  `package.json#openclaw.install.minHostVersion` pinned to
  `2026.6.1-beta.1`, while install/typecheck uses the nearest published
  npm beta SDK, `openclaw@2026.5.31-beta.4`.
- Stock `v2026.6.1-beta.1` still rejects third-party active-session
  attachments with `session attachments are restricted to bundled plugins`.
  Native Telegram buttons and Markdown delivery stay best-effort; typed
  `/plan` commands, sidebar actions, and persisted Markdown plan paths are
  the supported fallback.
- Stock `v2026.6.1-beta.1` does not include the chat-stream renderer seam
  from upstream PR `openclaw/openclaw#80982`. Inline plan cards, input-bar
  suppression, and the mode-switcher chip remain upstream-gated.

### What changed since `1.0.0-port.18`

- Bumped the package to `1.0.0-port.19`.
- Bumped the runtime/install compatibility target to
  `2026.6.1-beta.1` and added explicit GitHub-release target metadata.
- Updated the host-version parity gate so a GitHub-only OpenClaw release can
  use an explicitly declared npm SDK fallback without hiding drift.
- Added release-gate classification for the stock 6.1 active-session
  attachment block. The runtime now logs the specific host seam gate and
  names the `/plan`/Markdown fallback instead of treating the block as a
  generic delivery failure.
- Added a best-effort managed TaskFlow bridge. When OpenClaw exposes
  `api.runtime.tasks.managedFlows` (or the legacy `api.runtime.taskFlow`
  alias), Smarter-Claw creates a managed TaskFlow for pending plan approval
  and finishes or updates it when the plan is approved, edited, or rejected.
  This makes pending plans visible to the 6.1 task/workboard affordances
  without making TaskFlow availability a hard install requirement.
- Added focused release-gate tests for target metadata, attachment seam
  classification, and TaskFlow visibility.

### Validation and remaining host limitations

Release validation completed on merged PR
[`#124`](https://github.com/electricsheephq/Smarter-Claw/pull/124):

- GitHub `ci`, `installer-roundtrip`, CodeQL, Socket Project Report,
  Socket Pull Request Alerts, and CodeRabbit passed on the release branch.
- GitHub Codex and CodeRabbit review threads were fixed and resolved before
  merge.
- Local Lexar-backed validation passed from
  `/Volumes/LEXAR/repos/Smarter-Claw-v2026.6.1-beta.1`: `pnpm runtime-gate`,
  `pnpm parity-harness`, full Vitest (`43` files / `889` tests), `pnpm pack`,
  and extracted tarball metadata smoke.
- Crabbox was built locally and inspected, but no Crabbox provider was
  available in this environment: Docker/local-container had no daemon, the
  broker was unauthenticated, and Hetzner direct mode had no
  `HCLOUD_TOKEN`/`HETZNER_TOKEN`.

1. **Full native active-session attachment parity** requires an OpenClaw
   host change that lets trusted third-party plugins declaring
   `contracts.sessionAttachments: ["active-session"]` send active-session
   presentations.
2. **Inline chat-stream UI parity** remains blocked on upstream PR
   `openclaw/openclaw#80982` or an equivalent public renderer seam.

## 1.0.0-port.18 — OpenClaw 26.5.19 latest-stable bump (2026-05-21)

This maintenance pass moves the recovery candidate from stable
`openclaw@2026.5.18` to npm `latest`, `openclaw@2026.5.19`.

### What changed since `1.0.0-port.17`

- Bumped the SDK/test target to `openclaw@2026.5.19`.
- Bumped `openclaw.plugin.json` `minHostVersion` to `2026.5.19`.
- Bumped canonical `package.json#openclaw.install.minHostVersion` to
  `>=2026.5.19` and `peerDependencies.openclaw` to `>=2026.5.19`.
- Bumped the package candidate to `1.0.0-port.18`.
- Raised the package Node engine floor to `>=22.19.0`, matching
  OpenClaw 2026.5.19's published package engine requirement.
- Kept the same compatibility truth: stock `openclaw@2026.5.19` still
  rejects third-party active-session attachments, so typed `/plan`
  commands and persisted Markdown paths remain the stable fallback until
  the trusted host seam lands.

## 1.0.0-port.17 — OpenClaw 26.5.18 recovery candidate (2026-05-20)

This recovery pass makes the plugin honest and testable on stable
`openclaw@2026.5.18` while adding the consumer side of the Telegram
native-button UX.

### What changed since `1.0.0-port.16`

- Added `openclaw.plugin.json` `contracts.tools` for
  `enter_plan_mode`, `exit_plan_mode`, and `ask_user_question`, plus
  `contracts.sessionAttachments: ["active-session"]`.
- Added canonical `package.json#openclaw.install` and
  `package.json#openclaw.build` metadata. The install floor is the
  OpenClaw-required semver form `>=2026.5.18`, while the manifest keeps
  the stable runtime target `2026.5.18`. Added a CI
  `pnpm runtime-gate` that loads the built plugin and fails on missing
  tool contracts, CLI descriptors, slash commands, session actions,
  Control UI, or Telegram interactive handler registrations.
- Registered `openclaw plan-clear` with explicit descriptor metadata so
  OpenClaw can lazy-load/advertise it without guessing.
- Added Telegram interactive namespace `smarter-claw-plan`:
  approval cards expose Approve, Revise, Reject, Cancel buttons; question
  cards expose option buttons; callbacks enforce sender authorization and
  stale approval/question guards, then clear buttons after resolution.
- `exit_plan_mode` now returns the persisted Markdown plan path in tool
  details and best-effort sends the Markdown file plus rich approval
  presentation through `api.session.workflow.sendSessionAttachment`.
- `ask_user_question` now best-effort sends native option buttons through
  the same active-session presentation path.
- Fixed drift-cron's missing `tsx` dependency by using Node 22
  `--experimental-strip-types` or the existing parity harness path.

### Host compatibility truth

Stock `openclaw@2026.5.18` still blocks third-party active-session
attachments, so the plugin falls back to persisted Markdown paths and
typed `/plan` commands there. Full Markdown attachment plus Telegram
button parity requires the narrow OpenClaw host seam that allows trusted
plugins declaring `contracts.sessionAttachments: ["active-session"]` to
send active-session presentations.

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
