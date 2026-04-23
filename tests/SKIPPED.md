# Skipped tests from the openclaw-1 plan-mode corpus

Final port summary: 470 passing, 1 skipped, 0 failing across 15 files (Tiers
1–4). The skipped case + the file-level + within-file skips below explain why
each upstream surface didn't make the cut.

---


This file tracks openclaw-1 tests that were intentionally not ported, with the
reason. The port pulls ~189 tests / ~3,300 LOC from
`openclaw-1@feat/plan-channel-parity-eva-stable` into the Smarter-Claw plugin
tree. Where the API differs because Smarter-Claw is the trimmed plugin shape
(host I/O lives in the installer patch), the integration-style assertions are
either reshaped against the new API or skipped here.

## File-level skips (not ported at all)

- `src/agents/plan-mode/reference-card.test.ts` — does NOT exist in the
  openclaw-1 source corpus (only the `reference-card.ts` module exists).
  Listed in the port plan but no source to port.
- `src/agents/plan-mode/plan-nudge-crons.test.ts` — prohibitively coupled to
  the host runtime (cron registration, gateway lifecycle, host-side nudge
  delivery). Plan-nudge-crons logic has not been ported as a Smarter-Claw
  module surface yet.
- `src/agents/plan-mode/work-units.test.ts` — work-units module is not part
  of the Smarter-Claw plugin surface (it lives in the openclaw-1 host).
- `src/agents/plan-mode/execution-status-injection.test.ts` — execution-
  status-injection module is not part of the Smarter-Claw plugin surface.

## Within-file skips (selective)

These individual test cases or describe blocks were skipped within otherwise-
ported files because the corresponding code path is owned by the installer
patch (host I/O, session-store IO, agent-runner integration) rather than by
the plugin itself.

- `tests/injections.test.ts` — the openclaw-1 file's e2e
  `enqueuePendingAgentInjection` + `consumePendingAgentInjections(sessionKey)`
  tests assert a sessionKey-based async store path (with `vi.mock` of
  `config/io.js`, `config/sessions/paths.js`, `routing/session-key.js`).
  Smarter-Claw's `injections.ts` is the host-object-based pure helper layer;
  the store I/O and migration-from-legacy-scalar live in the installer patch.
  The pure helpers (sortAndCapQueue, upsertIntoQueue,
  composePromptWithPendingInjections, DEFAULT_INJECTION_PRIORITY,
  MAX_QUEUE_SIZE) ARE ported, plus a host-based round-trip suite that
  exercises the actual API surface the installer consumes.

  Specifically NOT ported from the openclaw-1 file:
   - `migrateLegacyPendingInjection` describe (legacy scalar migration —
     handled by installer patch, not the plugin module).
   - The full e2e `enqueuePendingAgentInjection + consumePendingAgentInjections
     (e2e)` describe block (sessionKey-based async store I/O).
   - The "consume drops captured entries when disk write fails (wave-1 fix)"
     test (sabotages the store path; lives with the installer patch).
- `tests/debug-log.test.ts` — the openclaw-1 file mocks
  `../../logging/subsystem.js` (a structured logger) and
  `../../config/io.js` (a `loadConfig` reader with a 30s TTL cache that the
  helper consults on every emit). Smarter-Claw's debug-log uses `console.error`
  directly with a `[smarter-claw/<kind>]` tag, and gates via either
  `OPENCLAW_DEBUG_PLAN_MODE=1` env var OR `setPlanModeDebugEnabled(true)`
  (called by the plugin entry on register from `pluginConfig.debugLog`). The
  test is reshaped to assert the new API; the openclaw-1
  `_resetIsPlanModeDebugEnabledCacheForTests` and `loadConfig`-based gate are
  not surfaced here.
- `tests/exit-plan-mode-tool.test.ts` — the openclaw-1 file's "subagent
  gate" describe block (7 tests asserting that the tool throws when the
  parent run has open subagent runs) is NOT ported. Smarter-Claw's
  `exit_plan_mode` intentionally drops the subagent gate (no
  `AgentRunContext` access through the plugin SDK yet); the file header
  documents the soft-steer in the tool description as the current
  enforcement.
- `tests/archetype-bridge.test.ts` — the openclaw-1 file mocked
  `plugin-sdk/telegram.js` + `config/sessions/store-read.js` to exercise
  the auto-detection of telegram sessions and the
  `sendDocumentTelegram` SDK call. Smarter-Claw's bridge takes a generic
  `sendAttachment` callback the installer wires per channel; the test
  is reshaped to verify the callback contract (delivers / declines /
  throws / null-returns) instead of telegram-specific routing.
- `tests/integration.test.ts` — the openclaw-1 file's "tool enablement
  gate" describe block (3 tests asserting on
  `isPlanModeToolsEnabledForOpenClawTools`) is wrapped in `describe.skip`
  with a TODO comment. The helper lives in the openclaw-1 host module
  `src/agents/openclaw-tools.registration.js` — the Smarter-Claw plugin
  is enabled/disabled via its plugin manifest + plugin config and has no
  equivalent helper to assert on. The "before-tool-call hook"
  assertions in the openclaw-1 file went through `runBeforeToolCallHook`
  (host module `src/agents/pi-tools.before-tool-call.js`) — they're
  reshaped to call `checkMutationGate` directly (the same logic the
  installer patch wires into the host's before_tool_call hook).
- `tests/slash-commands.test.ts` — the openclaw-1 file's
  `commands-plan.test.ts` mocked `gateway/call.js` (`callGateway`),
  `infra/channel-approval-auth.js`, the reply-handler internals, and
  asserted on `{ shouldContinue, reply }` shapes. Smarter-Claw's
  surface is `createPlanCommandHandler({ resolveSession, applyPlanPatch,
  ... })` — pure dep injection — and the handler returns
  `PluginCommandResult` (= `ReplyPayload` = `{ text }`) instead of the
  reply-handler shape. The `isAuthorizedSender` carve-out (status / view
  bypass auth) is host-only — the plugin handler doesn't gate on it.
- `tests/snapshot-persister.test.ts` — the openclaw-1 file imported
  `__testingPlanSnapshotPersister.persistApprovalMetadata` (private
  testing surface). Smarter-Claw exposes the public
  `startPlanSnapshotPersister(deps)` and the equivalent assertion is
  reshaped to drive the persister via a `subscribe` callback that emits
  an approval event with empty/whitespace runId. The persister's
  defensive guard catches the empty runId and surfaces it via the
  `log.warn` path instead of throwing through the synchronous boundary.
