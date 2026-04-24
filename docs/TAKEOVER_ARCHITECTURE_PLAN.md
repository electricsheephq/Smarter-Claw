# Smarter-Claw Full Takeover Architecture Plan

Status: active takeover plan.
Owner: Codex project manager and integration owner.
Initial execution branch: `takeover/parity-architecture-plan`.
Source of truth: OpenClaw PR #70071 behavior, implemented as plugin-owned canonical state plus an exact PR #70071 compatibility projection.

## Summary

Takeover goal: make Smarter-Claw a usable OpenClaw plugin with 100% behavioral parity against the working in-core OpenClaw PR #70071 plan-mode implementation, while avoiding code-for-code copying where a plugin-native architecture is clearly better.

Architectural decision: use plugin-owned namespaced state as canonical, but expose an exact PR #70071 compatibility projection to OpenClaw UI/session/gateway boundaries. This is the 95%-confidence better path for a plugin: it preserves uninstall isolation and future OpenClaw compatibility, while still requiring the host-visible contract to be identical to the proven integrated implementation.

Current live state at takeover start:

- Repo `electricsheephq/Smarter-Claw` is on clean `main` at `b982518`.
- PRs `#39` CI, `#40` tarball/bin, `#41` atomic manifest write, and `#42` license are merged.
- No open PRs. No current `v0.2.0-beta` blockers.
- Remaining risk is runtime parity, host adapter correctness, timing/debuggability, and installer release confidence.

## Takeover Operating Model

Codex takes over as project manager and integration owner. Other AI builders may continue, but work is routed through scored issues, narrow PRs, and parity acceptance tests.

Sub-agent process:

- Parity architect: compare every feature against PR #70071 and maintain the contract matrix.
- Host/installer architect: own patch-plan shape, session-store write seam, rollback, verify, uninstall, tarball install.
- Observability architect: own timing logs, correlation IDs, failure signatures, and live-debug runbooks.
- GitHub/release manager: own labels, milestones, release gates, issue consolidation, branch protection.
- Test architect: own unit, contract, host-applied, UI, timing/e2e, and packed-tarball acceptance.

Rules for builders:

- No direct commits to `main`.
- Every P0/P1 issue gets acceptance criteria and at least one contract test before merge.
- Every host patch PR carries `risk/host-patch`.
- Every timing-sensitive PR adds logs using shared correlation IDs.
- Every merged PR updates the parity scorecard.

## Architecture Plan

Core state contract:

- Keep plugin metadata canonical, but create one tested adapter that projects exact PR #70071 host/UI shape.
- Do not keep split vocabulary. UI/gateway must see `approval: "none" | "pending" | "approved" | "edited" | "rejected" | "timed_out"`.
- Do not add an `executing` enum. Preserve the working `mode: "plan" | "normal"` model and represent post-approval execution via `recentlyApprovedAt`, `recentlyApprovedCycleId`, injections, and close-on-complete.
- Adapter owns approval vocabulary, pending interaction shape, question fields, plan steps, approval IDs, and top-level session row fields.

Host patch boundaries:

- Patch only the seams required for parity: session row forwarding, session patch actions, approval/question event bridge, safe metadata write, and runner-adjacent injection delivery.
- Replace broad `updateSessionStoreEntry` with a narrower `updatePluginMetadata` or equivalent scoped write seam once parity is stabilized.
- Add missing row forwarding for `planMode`, `pendingInteraction`, pending question fields, and last plan steps so refresh/sidebar/slash context work.

Approval lifecycle:

- Fix approval ID split-brain first. The same approval ID must be persisted, emitted, rendered, submitted, and validated.
- Map plugin `awaiting-approval` to host/UI `pending`; no raw plugin vocabulary crosses into OpenClaw UI.
- Port approve/edit/reject semantics from PR #70071 behaviorally: stale guards, terminal guards, edit vs approve distinction, reject feedback, rejection count, approved plan-step injection, and accept-edits permission.
- Add approval-side subagent gate with persisted IDs, live IDs where available, settle grace, fail-closed behavior, and clear error codes.

Question lifecycle:

- Wire `ask_user_question` end to end: event bridge, pending question metadata, UI card, slash `/plan answer`, and `sessions.patch` `answer`.
- Validate approval ID, optional question ID, option membership, and free-text policy.
- Sanitize answer text and feedback server-side before injection.

Injection delivery:

- Replace `appendSystemContext` as the parity path for plan decisions. Use a host runner seam or SDK hook that prepends pending injections to the next user/model turn like the integrated implementation.
- Drain injections atomically: each item must be drained exactly once, expired, capped/dropped, or logged as clear-failed.
- Approved/edited injections include the full approved plan steps, not only `[PLAN_DECISION]`.

Snapshot, completion, and retry:

- Choose one snapshot persister path and remove duplicated partial behavior.
- Persist `update_plan` snapshots, last plan steps, terminal completion, and `[PLAN_COMPLETE]`.
- Auto-close only after an approved/edited cycle or safe recently-approved fallback.
- Keep ack-only retry state-aware and runner-adjacent; enrich host hook payloads if plugin events lack necessary metadata.

Auto-approve and nudges:

- Wire `autoApprove.default` and `/plan auto` to the real approval lifecycle.
- Auto-approve only after pending state and matching approval ID are visible.
- Replace the global recurring nudge with PR #70071-style per-session one-shot nudges, persisted as job IDs and cleaned up on approve/edit/reject/off/complete.

Mutation and accept-edits gates:

- Fix `mutationGate.enabled:false` so it disables only mutation blocking, not unrelated hooks.
- Honor config knobs or remove/document them before release.
- Wire accept-edits permission after edited approval, then revoke it after use or completion.

Installer and release architecture:

- Keep PR #39-#42 improvements.
- Harden force reinstall, failed reinstall, uninstall `--force`, shadow symlink verify, and drift recovery.
- Add packed-artifact install smoke in CI.
- Align `package.json` version, `patch-plan.json` target version, README, and release docs before beta.

## Scored Backlog

| Rank | Issue / Work Item | Priority | Score | Source |
|---:|---|---|---:|---|
| 1 | Contract-lock adapter: exact PR #70071 session/UI projection | P0 | 100 | Runtime parity audit |
| 2 | Fix approval ID split-brain and approval vocabulary | P0 | 99 | `tool-state-helpers`, exit event patch |
| 3 | Add host row forwarding for plan/question state | P0 | 97 | Missing `session-utils` patches |
| 4 | Wire `ask_user_question` event + `answer` patch action | P0 | 96 | Question lifecycle gap |
| 5 | Move plan injections to runner/turn boundary | P0 | 95 | Timing/parity gap |
| 6 | Full approve/edit/reject reducer semantics | P0 | 94 | PR #70071 sessions patch |
| 7 | Approval-side subagent gate + settle grace | P1 | 92 | Missing approval gate |
| 8 | Snapshot persister + close-on-complete | P1 | 90 | Partial persister |
| 9 | Auto-approve and per-session nudges | P1 | 88 | Config advertised, not wired |
| 10 | Timing/debug log parity | P1 | 87 | Live debugging requirement |
| 11 | Installer transaction hardening | P1 | 86 | Shadow/force/rollback gaps |
| 12 | CI packed artifact + no empty test suite | P1 | 84 | Release confidence |
| 13 | Consolidate `#15/#25/#26` diff parser correctness | P1 | 82 | Existing issues |
| 14 | Consolidate `#17/#18` slash security hardening | P1 | 80 | Existing issues |
| 15 | Consolidate `#16/#20` runtime import/error boundary | P2 | 76 | Existing issues |
| 16 | Fix `plan_mode_status` blocking subagent visibility | P2 | 74 | Observability gap |
| 17 | Consolidate `#23/#24` host discovery reliability | P2 | 70 | Existing issues |
| 18 | Modularize `index.ts` registration and hook policy docs | P3 | 58 | `#21/#27` |
| 19 | Clean stale approval ID ESM fallback | P3 | 43 | `#19` |

## GitHub Process

Create or update labels:

- `release-gate`
- `risk/host-patch`
- `risk/public-api`
- `area/runtime`
- `area/installer`
- `area/slash-command`
- `area/ci-release`
- `area/observability`
- `status/ready`
- `status/blocked`
- `status/soaking`

Create `v0.2.0-beta` release-gate issues:

- `[release-gate] v0.2.0-beta.1 readiness + Eva canary tracker`
- `[runtime] Contract-lock PR #70071 compatibility adapter`
- `[runtime] Fix approval ID and pending approval vocabulary`
- `[runtime] Wire question approval and answer lifecycle`
- `[runtime] Deliver pending injections at turn boundary`
- `[observability] Timing/debug parity for live plan-mode diagnosis`
- `[ci-release] Fail CI on zero tests and add packed artifact install smoke`

Consolidate existing issues:

- `#15/#25/#26`: installer diff parser.
- `#17/#18`: slash command security.
- `#16/#20`: runtime import and error handling.
- `#23/#24`: host discovery.
- `#21/#27`: registration refactor and hook-chain docs.
- `#19`: approval ID ESM cleanup.

PR ladder:

1. Governance/documentation PR: save this plan, labels, milestone cleanup, issue templates.
2. Runtime contract PR: adapter, vocabulary, session row forwarding, contract tests.
3. Approval lifecycle PR: approval ID, event bridge, approve/edit/reject semantics.
4. Question lifecycle PR: `ask_user_question`, `answer`, validation, UI/slash parity.
5. Injection/snapshot PR: runner-boundary drain, approved steps, close-on-complete.
6. Subagent/auto/nudge PR: approval gate, settle grace, auto-approve, per-session nudges.
7. Observability PR: timing log taxonomy, correlation IDs, failure signatures, live runbook.
8. Installer/CI PR: shadow symlink verify, force rollback, installer tests, packed tarball gate.
9. Beta readiness PR: docs, version alignment, canary checklist, release notes.

## Observability Plan

Treat Smarter-Claw as a timing system. A single session log should reconstruct: enter plan mode, mutation gate, proposal, pending approval, UI/slash action, injection queue, next-turn delivery, execution, snapshot, completion.

Correlation IDs on every relevant log:

- `sessionKey`
- `agentId`
- `runId`
- `cycleId`
- `approvalId`
- `questionId`
- `toolCallId`
- `injectionId`
- `childRunId`
- `nudgeJobId`

Log families:

- `register.*`
- `state.*`
- `persist.*`
- `gate.*`
- `queue.*`
- `hook.*`
- `snapshot.*`
- `retry.*`
- `ui_bridge.*`
- `timing.*`

Acceptance for logs:

- No silent lifecycle skips; every skip includes a reason.
- Every queued injection has one terminal log outcome.
- Every approval can be traced from proposal to user decision to next-turn delivery.
- Debug logs use bounded previews and never dump secrets or full long plans by default.

## Test Plan

Unit tests:

- Plugin entry registration, including `enabled:false` and `mutationGate.enabled:false`.
- Adapter projection for plan approval, question approval, plan steps, top-level UI mirror, and stale-field clearing.
- Approval reducer: approve, edit, reject, stale ID, terminal state, accept-edits.
- Question reducer: answer ID checks, option checks, free text, sanitization.
- Injection queue: priority, dedupe, cap, expiry, atomic drain expectations.
- Snapshot: terminal plan completion, `[PLAN_COMPLETE]`, idempotency.
- Lifecycle: intro once, subagent spawn/end, retry suppression, cron idempotency.

Installer/host tests:

- Apply `patch-plan.json` to a clean OpenClaw target.
- Verify schema accepts `answer`.
- Verify UI row hydration has exact fields.
- Verify approval ID consistency after exit event.
- Verify stale approval actions fail safely.
- Verify install/verify/uninstall/force/rollback/shadow symlink behavior.
- Verify packed tarball installs and CLI bins load.

UI/timing tests:

- Approval card renders after exit.
- Refresh hydrates pending plan/question cards.
- `/plan accept`, `/plan revise`, `/plan answer`, `/plan auto` work.
- Hidden resume/send fires after approval.
- Subagent blocks exit and approval until settled.
- Ack-only retry and nudges are observable.
- Completed `update_plan` auto-closes only after approval.

Manual canary:

- Clean OpenClaw v2026.4.22 install.
- Install Smarter-Claw packed artifact.
- Run full browser workflow: enter, blocked mutation, propose, approve, edit, reject, ask/answer, refresh, subagent gate, auto-approve, nudges, completion.
- Run 48h Eva canary before beta tag.

## Assumptions

- "100% parity" means behavioral parity, state contract parity, UI/session parity, and debugging parity, not line-for-line source replication.
- PR #70071 remains the source of truth for expected plan-mode behavior.
- OpenClaw target remains v2026.4.22 unless a new target is explicitly chosen.
- The plugin architecture should stay uninstallable and namespaced; host patches are allowed only where current OpenClaw SDK seams cannot express the proven behavior.
- The first permitted execution action is saving this plan to `/Users/lume/repos/Smarter-Claw/docs/TAKEOVER_ARCHITECTURE_PLAN.md`, then filing the release-gate and P0 runtime issues.
