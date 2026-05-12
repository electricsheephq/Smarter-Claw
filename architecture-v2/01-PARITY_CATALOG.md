# Plan-Mode Parity Catalog

**Source-of-truth contract for the plugin port.**
**Zero divergence acceptable; the plugin SHIPS with all 12 features or it doesn't ship.**

- **Worktree:** `/Users/lume/repos/openclaw-pr70071-rebase`
- **Branch:** `rebase/pr70071-onto-main-2026-04-25` (tip `ea04ea52c7`)
- **Base tag:** `v2026.4.24`
- **Empty-plan-body race fix commit:** `1081067476` — `pi-embedded-subscribe.handlers.tools.ts::persistPlanApprovalRequest` writes `lastPlanSteps + title` synchronously
- **Diff statistic:** 232 files changed, +43,145 / −1,315 LOC (full repo); plan-mode-relevant subset enumerated below

---

## Table of Contents

1. [Filtered file inventory](#filtered-file-inventory) — every plan-mode-touching file, one line each
2. Feature subsections (12 total):
   - [F1. enter_plan_mode / exit_plan_mode tools](#f1-enter_plan_mode--exit_plan_mode-tools)
   - [F2. Mutation gate](#f2-mutation-gate)
   - [F3. Plan-approval-request persistence (sessions.patch + race fix)](#f3-plan-approval-request-persistence)
   - [F4. planMode runtime context propagation](#f4-planmode-runtime-context-propagation)
   - [F5. Plan archetype + ask_user_question + auto mode (PR-10)](#f5-plan-archetype--ask_user_question--auto-mode-pr-10)
   - [F6. Plan title + turn limit (32→500 floor + configurable) (PR-9)](#f6-plan-title--turn-limit-pr-9)
   - [F7. Auto-continue + escalating retry (GPT-5.4 planning parity)](#f7-auto-continue--escalating-retry)
   - [F8. Rejection UX with feedback + cycle tracking (PR-11)](#f8-rejection-ux-with-feedback--cycle-tracking-pr-11)
   - [F9. Mode-switcher UI + plan cards (split sidebar OR popup-during-exec)](#f9-mode-switcher-ui--plan-cards)
   - [F10. Exec allowlist (newline/dangerous-flag/env block)](#f10-exec-allowlist)
   - [F11. Approval grant ledger / approvalRunId / approvalId correlation (C7)](#f11-approval-grant-ledger--approvalrunid--approvalid-correlation-c7)
   - [F12. Shell-escape layered defense + approvalRunId silent-bypass guard (C4)](#f12-shell-escape-layered-defense--approvalrunid-silent-bypass-guard-c4)
3. [Summary table: feature → # files / # LOC / # tests / # hook integration points](#summary-table)
4. [Must-Have gate-list](#must-have-gate-list)

---

## Filtered file inventory

Each line: `path — feature(s) it implements`. The 232 changed files filtered to plan-mode-relevant only.

### Plan-mode core library (`src/agents/plan-mode/`)

- `src/agents/plan-mode/types.ts` — F1, F3, F8, F11, F12 — PlanMode/PlanApprovalState/PlanModeSessionState types; `newPlanApprovalId()` (UUID-secure); `buildPlanDecisionInjection()` (rejected/expired/timed_out with feedback-sanitizer that defeats `[/PLAN_DECISION]` injection)
- `src/agents/plan-mode/index.ts` — F1, F2, F3 — barrel re-export: `PlanMode`, `PlanApprovalState`, `PlanModeSessionState`, `DEFAULT_PLAN_MODE_STATE`, `buildPlanDecisionInjection`, `newPlanApprovalId`, `checkMutationGate`, `MutationGateResult`, `resolvePlanApproval`, `buildApprovedPlanInjection`, `buildAcceptEditsPlanInjection`, `DEFAULT_APPROVAL_CONFIG`, `MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE`, `SUBAGENT_SETTLE_GRACE_MS`, `PlanApprovalConfig`
- `src/agents/plan-mode/mutation-gate.ts` — F2, F10 — `checkMutationGate(toolName, currentMode, execCommand)`; MUTATION_TOOL_BLOCKLIST, PLAN_MODE_ALLOWED_TOOLS (includes ask_user_question, enter_plan_mode, plan_mode_status, sessions_yield, lcm_grep, lcm_expand_query, sessions_spawn, sessions_list, sessions_history), READ_ONLY_EXEC_PREFIXES, DANGEROUS_FLAGS regex with word boundaries (-delete/-exec/-execdir/--delete/-rf/--output/-fprint*); shell compound operator regex `[;|&`\n\r]|\$\(|>>?|<\(|>\(`
- `src/agents/plan-mode/approval.ts` — F1, F3, F8, F11 — `resolvePlanApproval(current, action, feedback, expectedApprovalId)` state machine; terminal-state guards; stale-approvalId silent-no-op guard (both-defined check); `buildApprovedPlanInjection`, `buildAcceptEditsPlanInjection`; SUBAGENT_SETTLE_GRACE_MS = 10_000ms; MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE = 1
- `src/agents/plan-mode/accept-edits-gate.ts` — F2, F12 — `checkAcceptEditsConstraint()` (fail-open); DESTRUCTIVE_EXEC_PREFIXES (rm/rmdir/unlink/shred/trash/truncate/diskutil); DESTRUCTIVE_SQL_PATTERNS (DROP TABLE/DATABASE/SCHEMA, DELETE FROM, TRUNCATE, FLUSHALL/FLUSHDB); DESTRUCTIVE_FIND_FLAGS (-delete / -exec rm / -execdir rm); DESTRUCTIVE_ESCAPE_PATTERNS (env-var indirection `$RM`, backtick subshell, `$()` subshell, quote concatenation, `\xNN` hex, octal `\NNN`); SELF_RESTART_PATTERNS (gateway stop/restart/kill + launchctl/systemctl/pkill/killall + pipe-chained termination); CONFIG_CHANGE_PATTERNS (openclaw config set/delete/unset + doctor --fix); PROTECTED_CONFIG_PATH_PREFIXES (~/.openclaw/, ~/.claude/, ~/.config/openclaw/, /etc/openclaw/, /usr/local/etc/openclaw/); `normalizeCandidatePath()` handles both ~ and $HOME forms; `extractApplyPatchTargetPaths()` parses Update/Add/Delete File + Move to:
- `src/agents/plan-mode/auto-enable.ts` — F5 — `evaluateAutoEnableForMatch(modelId, patterns)` with compiled-regex cache; malformed-pattern returns null; `__resetCompiledPatternCacheForTests`
- `src/agents/plan-mode/injections.ts` — F3, F5, F7, F8, F11 — pending-injection queue: `enqueuePendingAgentInjection`, `consumePendingAgentInjections`, `appendToInjectionQueue`, `migrateLegacyPendingInjection`, `sortAndCapQueue`, `upsertIntoQueue`, `composePromptWithPendingInjections`; DEFAULT_INJECTION_PRIORITY {plan_decision:10, plan_complete:9, question_answer:8, subagent_return:5, plan_intro:3, plan_nudge:1}; MAX_QUEUE_SIZE = 10; deterministic localeCompare tiebreaker
- `src/agents/plan-mode/plan-archetype-bridge.ts` — F5 — `dispatchPlanArchetypeAttachment()` orchestrator (renders markdown → persists to disk → reads SessionEntry deliveryContext → sends to Telegram document); `buildPlanAttachmentCaption()` HTML caption; `loadSessionEntryReadOnly()`
- `src/agents/plan-mode/plan-archetype-persist.ts` — F5 — `persistPlanArchetypeMarkdown()` to ~/.openclaw/agents/<agentId>/plans/ with atomic O_CREAT|O_EXCL ("wx"); MAX_COLLISION_SUFFIX = 99; path-traversal rejection; symlink rejection at agent + plans dir; PlanPersistStorageError class (ENOSPC/EACCES/EIO)
- `src/agents/plan-mode/plan-archetype-prompt.ts` — F5 — `PLAN_ARCHETYPE_PROMPT` (decision-complete plan standard, ~120 lines); `buildPlanFilenameSlug(title, maxLen=50)` (NFKD + diacritic strip + kebab); `buildPlanFilename()` → plan-YYYY-MM-DD-<slug>.md
- `src/agents/plan-mode/plan-mode-debug-log.ts` — F11 — `PlanModeDebugEvent` discriminated union (state_transition, gate_decision, tool_call (enter/exit/update/ask_user_question), synthetic_injection, nudge_event, subagent_event, approval_event, toast_event, approval_transition); `logPlanModeDebug`, `logPlanModeApprovalTransition`, `isPlanModeDebugEnabled` (env-wins-over-config + 30s TTL cache); env-var = `OPENCLAW_DEBUG_PLAN_MODE=1`; emits at `info` level
- `src/agents/plan-mode/plan-nudge-crons.ts` — F5, F7 — `schedulePlanNudges()` (defaults [10, 30, 60] min one-shot crons); `cleanupPlanNudges()`; PLAN_NUDGE_NAME_PREFIX = "plan-nudge:"; calls `assertSafeCronSessionTargetId` for safety; jobName format `plan-nudge:Nmin:<sessionKey>`; payload kind "agentTurn"; `[PLAN_NUDGE]:` prefix
- `src/agents/plan-mode/reference-card.ts` — F1, F5, F11 — `PLAN_MODE_REFERENCE_CARD` constant (state diagram + tool contract + tag taxonomy + slash command surface + pitfalls + debug tips, ~140 lines)

### Plan-mode tools (`src/agents/tools/`)

- `src/agents/tools/enter-plan-mode-tool.ts` — F1 — `createEnterPlanModeTool({runId})`; schema {reason?: string} additionalProperties:false; returns `{status: "entered", mode: "plan", reason?}` + nudge text
- `src/agents/tools/exit-plan-mode-tool.ts` — F1, F3, F6, F11, F12 — `createExitPlanModeTool({runId})`; schema {title (required ≤80 chars), plan (≥1 step), summary?, analysis?, assumptions[]?, risks[{risk,mitigation}]?, verification[]?, references[]?}; `readPlanSteps()` with at-most-one in_progress validation; `readPlanArchetypeFields()`; payload-hash via createHash("sha1") prefix(12); subagent gate (openSubagentRunIds > 0 → ToolInputError); SUBAGENT_SETTLE_GRACE_MS check; always-on `agents/exit-plan-gate` subsystem logger
- `src/agents/tools/ask-user-question-tool.ts` — F5 — `createAskUserQuestionTool({runId})`; schema {question, options 2-6, allowFreetext?} additionalProperties:false; duplicate-option rejection; questionId = `q-${toolCallId}` (deterministic for cache stability)
- `src/agents/tools/plan-mode-status-tool.ts` — F11 — `createPlanModeStatusTool({runId, sessionKey, storePath})`; schema {} additionalProperties:false; reads via `loadSessionStore(skipCache:true)`; returns {inPlanMode, approval, title, approvalRunId, planStepCount, openSubagentCount, openSubagentRunIds.slice(0,10), recentlyApprovedAt, pendingAgentInjectionPreview, planModeIntroDeliveredAt, autoApprove, debugLogEnabled, sessionKey, runId, sessionStoreReadOk, sessionStoreReadError?}
- `src/agents/tools/update-plan-tool.ts` — F6 — modified: exports `PLAN_STEP_STATUSES`, `PlanStepStatus`; closure-gate fields (acceptanceCriteria, verifiedCriteria); 410 LOC

### Plan-store + plan-render + plan-hydration

- `src/agents/plan-store.ts` — F6, F11 — `PlanStore` class for cross-session plan namespacing (CLAUDE_CODE_TASK_LIST_ID style); namespace validation regex `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/`; Windows reserved name reject; O_NOFOLLOW symlink reject; realpath-based confinement; file-level lock with PID liveness + LOCK_STALE_MS=60s + LOCK_HARD_MAX_MS=5min; sanitizePlanShape() prototype-pollution defense; MAX_PLAN_FILE_BYTES=1MB
- `src/agents/plan-render.ts` — F6, F8 — `renderPlanChecklist(steps, format)` html/markdown/plaintext/slack-mrkdwn; `renderPlanWithHeader`; `renderFullPlanArchetypeMarkdown` (#title/Summary/Analysis/Plan/Assumptions/Risks/Verification/References + footer with /plan resolution); `neutralizeMentions` (@channel/@here/@everyone + Discord `<@123>`); `escapeMarkdown`, `escapeHtml`, `escapeSlackMrkdwn`
- `src/agents/plan-hydration.ts` — F4 — `formatPlanForHydration(steps)` post-compaction injection; "Your active plan was preserved across context compression"; filter ACTIVE_PLAN_STATUSES = ["pending", "in_progress"]; `[ ]` / `[>]` markers; status suffix in parens

### Gateway integration

- `src/gateway/sessions-patch.ts` — F2, F3, F4, F5, F7, F8, F11, F12 — `applySessionsPatchToStore`; planMode patch branch (lines 484-642): mode toggle, planModeIntroDeliveredAt, [PLAN_MODE_INTRO] injection; planApproval patch branch (lines 644-1133): action=approve/edit/reject/answer/auto; subagent gate combining parentCtx + persistedOpenIds; PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS error; PLAN_APPROVAL_GATE_STATE_UNAVAILABLE error; `recentlyApprovedAt + recentlyApprovedCycleId`; postApprovalPermissions on `edit`; lastPlanSteps materialization (lines 1135-1189) with planMode shell synthesis when needed
- `src/gateway/plan-snapshot-persister.ts` — F3, F5, F8, F11 — `startPlanSnapshotPersister({emitSessionsChanged})`; subscribes to "approval" (emits planMode.title + approvalRunId) and "plan" events; `persistApprovalMetadata` (defensive approvalRunId guard); `persistPendingQuestionApprovalId`; `persistSnapshot` with closeOnComplete + pre-flight + lock-snapshot re-evaluation; locked-allowAutoClose mirroring; PLAN_COMPLETE injection text emission; `persistPlanModeSubagentGateState`; `__testingPlanSnapshotPersister` test seam
- `src/gateway/protocol/schema/sessions.ts` — F2, F3, F8 — `SessionsPatchParams`: `planMode` literal-union (plan|normal|null), `planApproval` discriminated union by `action` (approve/edit/reject with required feedback/answer with required approvalId/auto with required autoEnabled); `lastPlanSteps` array with closed-enum status
- `src/gateway/protocol/schema/error-codes.ts` — F3, F11 — PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS, PLAN_APPROVAL_WAITING_FOR_SUBAGENT_SETTLE, PLAN_APPROVAL_GATE_STATE_UNAVAILABLE, PLAN_APPROVAL_EXPIRED
- `src/gateway/protocol/index.ts` — F3 — re-exports error codes (+5 lines)
- `src/gateway/protocol/schema/cron.ts` — F5, F7 — +1 line: cron schema extension
- `src/gateway/server-close.ts` — F3 — startup wiring teardown (+8 lines)
- `src/gateway/server-methods/sessions.ts` — F3, F11 — wiring: sessions.changed emits planMode read-only
- `src/gateway/server-reload-handlers.ts` — F3 — reload handler updates for plan-mode subscriber re-register (+138 lines)
- `src/gateway/server-runtime-handles.ts` — F3 — registration handle for plan-snapshot-persister (+7 lines)
- `src/gateway/server-runtime-subscriptions.ts` — F3 — calls `startPlanSnapshotPersister` alongside agent/heartbeat/transcript/lifecycle subscriptions (+54 lines)
- `src/gateway/server.impl.ts` — F3 — wiring (+1 line)
- `src/gateway/session-utils.ts` — F3 — `resolveGatewaySessionStoreTarget` helper used by plan-snapshot-persister (+21 lines)
- `src/gateway/session-utils.types.ts` — F3 — type companion (+17 lines)
- `src/gateway/server-methods/chat.ts` — F3 — wiring (+7 lines)
- `src/gateway/server-methods/chat-transcript-inject.ts` — F4 — modified

### Agent runner integration

- `src/agents/pi-embedded-subscribe.handlers.tools.ts` — F1, F3, F5, F7, F11 — **RACE FIX MODULE** — `persistPlanApprovalRequest` (synchronous lastPlanSteps + title + lastPlanPayloadHash write inside the same updateSessionStoreEntry that arms approvalId; idempotency guard for duplicate exit_plan_mode); `persistPlanModeEnter` (fresh-entry detection; cycleId + blockingSubagentRunIds init; gate on `agents.defaults.planMode.enabled`); `autoApproveIfEnabled` (poll-until-pending + 2s cap; error-level log on failure); `persistPendingQuestionApprovalId`; `schedulePlanNudgesAndPersist` (only on fresh entry, never on already-in-plan-mode refresh); tool-end intercepts for enter_plan_mode/exit_plan_mode/ask_user_question
- `src/agents/pi-embedded-runner/run.ts` — F4, F7 — propagates `params.planMode` into AttemptParams; auto-continue cycle loop (planModeAckOnlyRetryAttempts, planModeAckOnlyInstruction); reads `recentlyApprovedAt` post-deletion grace; getLatestPlanMode threading
- `src/agents/pi-embedded-runner/run/attempt.ts` — F4, F5, F6 — `PLAN_ARCHETYPE_PROMPT` + `PLAN_MODE_REFERENCE_CARD` appended on planMode === "plan" branch; "PLAN MODE AVAILABLE" branch when feature enabled but not active; threads planMode into runtime context emission; promptWithPlanMode composition
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts` — F7 — PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION + FIRM variant; PLAN_APPROVED_YIELD_RETRY_INSTRUCTION + FIRM; PLANNING_ONLY_RETRY_INSTRUCTION + FIRM + FINAL; ACK_EXECUTION_FAST_PATH_INSTRUCTION; AUTO_CONTINUE_FAST_PATH_INSTRUCTION; STRICT_AGENTIC_BLOCKED_TEXT; `resolvePlanModeAckOnlyRetryInstruction` (with recentlyApprovedAt-grace); `resolveYieldDuringApprovedPlanInstruction`; `resolvePlanningOnlyRetryInstruction`; PLAN_MODE_INVESTIGATIVE_TOOL_NAMES (read/lcm_grep/lcm_describe/lcm_expand_query/lcm_expand/grep/glob/ls/find/web_search/web_fetch/update_plan/enter_plan_mode); DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT = 2; DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT = 2
- `src/agents/pi-embedded-runner/run/params.ts` — F4 — adds planMode to runner params
- `src/agents/pi-embedded-runner/run/helpers.ts` — F4 — modified
- `src/agents/pi-embedded-runner/run/runtime-context-prompt.ts` — F4 — runtime context prompt builder (new file)
- `src/agents/pi-embedded-runner/run/runtime-context-prompt.test.ts` — F4 — new tests
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts` — F7 — see above
- `src/agents/pi-embedded-runner/run/incomplete-turn.test.ts` — F7 — new tests
- `src/agents/pi-embedded-runner/pending-injection.ts` — F3 — new (post-PR-15 nuclear rewrite of single-scalar→queue)
- `src/agents/pi-embedded-runner/system-prompt.ts` — F4 — modified
- `src/agents/pi-embedded-runner/skills-runtime.ts` — F5 — modified
- `src/agents/pi-embedded-runner/transcript-rewrite.ts` — F4 — modified
- `src/agents/pi-embedded-runner/context-engine-maintenance.ts` — F4 — modified

### Tools and registration

- `src/agents/pi-tools.before-tool-call.ts` — F2, F12 — checkMutationGate hook (lines 280-323); checkAcceptEditsConstraint hook (lines 324-373); reads liveMode via getLatestPlanMode callback; reads getLatestAcceptEdits; extractApplyPatchTargetPaths for additionalPaths
- `src/agents/pi-tools.ts` — F2, F4 — adds planMode + getLatestPlanMode + getLatestAcceptEdits to BeforeToolCallCtx
- `src/agents/openclaw-tools.ts` — F1, F5, F11 — registers enter_plan_mode/exit_plan_mode/ask_user_question/plan_mode_status conditionally on `isPlanModeToolsEnabledForOpenClawTools({config})`
- `src/agents/openclaw-tools.registration.ts` — F1, F5 — registration metadata; agent-scope gating
- `src/agents/agent-scope.ts` — F5 — `isPlanModeToolsEnabledForOpenClawTools()`; modified
- `src/agents/tool-catalog.ts` — F1, F5 — entries for update_plan/enter_plan_mode/exit_plan_mode/ask_user_question with profiles:["coding"], includeInOpenClawGroup:true
- `src/agents/tool-description-presets.ts` — F1, F5, F11 — describeEnterPlanModeTool + ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY; describeExitPlanModeTool + EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY; describeAskUserQuestionTool + ASK_USER_QUESTION_TOOL_DISPLAY_SUMMARY; describePlanModeStatusTool + PLAN_MODE_STATUS_TOOL_DISPLAY_SUMMARY
- `src/agents/tool-display-config.ts` — F9 — tool display metadata
- `src/agents/system-prompt.ts` — F4 — modified
- `src/agents/system-prompt-contribution.ts` — F4 — modified
- `src/agents/transport-message-transform.ts` — F4 — modified
- `src/agents/subagent-announce.ts` — F11 — modified for approvalRunId propagation
- `src/agents/subagent-registry-run-manager.ts` — F11 — modified
- `src/agents/subagent-registry.steer-restart.test.ts` — F11 — modified
- `src/agents/subagent-registry.test.ts` — F11 — modified

### Skills runtime

- `src/agents/skills/skill-planner.ts` — F5 — new (~118 LOC)
- `src/agents/skills/skill-planner.test.ts` — F5 — new (~431 LOC, 30+ tests)
- `src/agents/skills/frontmatter.ts` — F5 — modified
- `src/agents/skills/types.ts` — F5 — modified
- `src/agents/skills/workspace.ts` — F5 — modified
- `skills/plan-mode-101/SKILL.md` — F1 — companion skill artifact for normal-mode discovery (D7)

### Heartbeat / cron / events

- `src/infra/heartbeat-runner.ts` — F7 — `buildActivePlanNudge(planMode)` suppresses nudge when approval==="pending" or planMode.updatedAt within idleThresholdMs
- `src/infra/heartbeat-runner.plan-nudge.test.ts` — F7 — new test file
- `src/infra/agent-events.ts` — F4, F11 — AgentRunContext fields: `openSubagentRunIds`, `inPlanMode`, `recentlyApprovedAt`, `lastSubagentSettledAt`, `getLatestPlanMode`, `getLatestPlanApproval` (etc); `clearInPlanModeForSession`; `persistPlanModeSubagentGateState` (mutation-callback over planMode)
- `src/cron/isolated-agent/run.ts` — F5 — auto-enable check before turn dispatch
- `src/cron/isolated-agent/run.plan-mode.test.ts` — F5 — new tests for auto-enable runtime
- `src/cron/normalize.ts` — F5 — modified
- `src/cron/types.ts` — F5 — modified

### Config

- `src/config/types.agent-defaults.ts` — F5, F6, F7, F11 — `agents.defaults.planMode.{enabled, autoEnableFor[], approvalTimeoutSeconds, debug}` typed surface; `agents.defaults.embeddedPi.{autoContinue.{enabled,maxCycles,stopOnMutation}, maxIterations}`; `agents.defaults.compaction.reserveTokensFloor`
- `src/config/zod-schema.agent-defaults.ts` — F5, F6, F7 — planMode strict schema: enabled boolean, autoEnableFor string[], approvalTimeoutSeconds int [10, 86400], debug boolean
- `src/config/zod-schema.agent-runtime.ts` — F4 — modified
- `src/config/zod-schema.ts` — F5 — modified
- `src/config/sessions/types.ts` — F1, F3, F5, F6, F8, F11, F12 — SessionEntry.planMode object (mode, approval, cycleId, enteredAt, confirmedAt, updatedAt, feedback, rejectionCount, approvalId, title, approvalRunId, lastPlanSteps[], lastPlanUpdatedAt, blockingSubagentRunIds[], lastSubagentSettledAt, nudgeJobIds[], autoApprove, lastPlanPayloadHash); root fields: recentlyApprovedAt, recentlyApprovedCycleId, postApprovalPermissions, planModeIntroDeliveredAt, pendingAgentInjection (legacy), pendingAgentInjections[] (queue), pendingInteraction, pendingQuestionApprovalId/Options/AllowFreetext (legacy); PostApprovalPermissions interface; PendingInteraction discriminated union; PendingAgentInjectionEntry interface
- `src/config/sessions/transcript.ts` — F3 — modified
- `src/config/schema.base.generated.ts` — F5 — generated schema export
- `src/config/types.agents.ts` — F5 — modified
- `src/config/types.skills.ts` — F5 — modified

### Auto-reply / slash commands

- `src/auto-reply/reply/commands-plan.ts` — F8 — `/plan {accept[, edits]|revise <feedback>|answer <text>|on|off|status|view|auto on|off|restate}`; foreign-bot @ disambiguation (Telegram-only); operator-auth gate for mutating subcommands; readLatestSessionEntryFresh disk-read; PLAN_APPROVAL_GATE_STATE_UNAVAILABLE friendly mapping; stale-approvalId friendly mapping; `[plan-accept-debug]` log on accept precondition
- `src/auto-reply/reply/commands-plan.test.ts` — F8 — new test file (742 LOC, ~43 tests)
- `src/auto-reply/reply/commands-handlers.runtime.ts` — F8 — handler registration
- `src/auto-reply/reply/commands-registry.shared.ts` — F8 — `handlePlanCommand` entry
- `src/auto-reply/reply/agent-runner-execution.ts` — F4 — getLatestPlanMode wiring
- `src/auto-reply/reply/commands-system-prompt.ts` — F4 — modified
- `src/auto-reply/reply/fresh-session-entry.ts` — F8 — new helper; `readLatestSessionEntryFresh({storePath, sessionKey, fallbackEntry})`
- `src/auto-reply/reply/fresh-session-entry.test.ts` — F8 — new tests

### Plugin SDK / telegram bridge

- `src/plugin-sdk/telegram.ts` — F5 — new; re-exports `sendDocumentTelegram` for plan-archetype-bridge
- `extensions/telegram/runtime-api.ts` — F5 — re-exports
- `extensions/telegram/src/send.ts` — F5 — modified
- `src/plugins/command-registration.ts` — F8 — registers /plan command
- `src/plugins/contracts/plugin-sdk-runtime-api-guardrails.test.ts` — F5 — modified

### Doctor / health

- `src/commands/doctor-session-transcripts.ts` — F3 — new (planMode-state-consistency check)
- `src/commands/doctor-session-transcripts.test.ts` — F3 — new tests
- `src/commands/doctor-state-integrity.ts` — F3 — modified for plan-mode integrity
- `src/commands/doctor-state-integrity.test.ts` — F3 — modified
- `src/commands/doctor.fast-path-mocks.ts` — F3 — modified
- `src/commands/sessions.ts` — F11 — modified
- `src/commands/status.summary.ts` — F11 — modified
- `src/flows/doctor-health-contributions.ts` — F3 — modified
- `docs/gateway/doctor.md` — F3 — +10 lines

### UI

- `ui/src/ui/chat/mode-switcher.ts` — F9 — `ModeDefinition` + dropdown chip; planMode + planAutoApprove props; routes to `sessions.patch { planMode, planApproval.action:"auto", autoEnabled }`
- `ui/src/ui/chat/mode-switcher.test.ts` — F9 — new (388 LOC)
- `ui/src/ui/chat/plan-cards.ts` — F9 — `renderPlanCard` (<details>/<summary>); `PlanCardData`, `PlanCardStep`; STATUS_MARKERS; `formatPlanAsMarkdown`
- `ui/src/ui/chat/plan-cards.test.ts` — F9 — new (159 LOC)
- `ui/src/ui/chat/plan-resume.ts` — F9 — plan-resume UI helper
- `ui/src/ui/chat/plan-resume.node.test.ts` — F9 — new tests
- `ui/src/ui/views/plan-approval-inline.ts` — F8, F9 — `renderInlinePlanApproval` (Accept / Accept allow edits / Revise + Open plan) + revise-textarea state; question variant; "Other..." inline textarea; missing-handler safety
- `ui/src/ui/views/plan-approval-inline.test.ts` — F8, F9 — new (295 LOC)
- `ui/src/ui/chat/slash-command-executor.ts` — F8 — /plan command dispatch in webchat
- `ui/src/ui/chat/slash-command-executor.node.test.ts` — F8 — new tests
- `ui/src/ui/chat/slash-commands.ts` — F8 — slash command catalog includes plan
- `ui/src/ui/styles/chat/plan-cards.css` — F9 — new (134 LOC)
- `ui/src/styles/chat.css` — F9 — modified
- `ui/src/styles/chat/layout.css` — F9 — modified
- `ui/src/ui/app-chat.ts` — F9 — modified
- `ui/src/ui/app-render.helpers.ts` — F9 — modified
- `ui/src/ui/app-render.ts` — F9 — modified
- `ui/src/ui/app-tool-stream.ts` — F9 — PlanApprovalRequest type; +369 lines
- `ui/src/ui/app-view-state.ts` — F9 — view-state holders; +74 lines
- `ui/src/ui/app.ts` — F9 — view + dispatch; +779 lines
- `ui/src/ui/chat/grouped-render.ts` — F9 — modified
- `ui/src/ui/chat/grouped-render.test.ts` — F9 — new tests
- `ui/src/ui/types.ts` — F9 — type additions; +72 lines
- `ui/src/ui/views/chat.ts` — F9 — large refactor: +554 lines
- `ui/src/ui/views/chat.test.ts` — F9 — new test file (388 LOC)
- All `ui/src/i18n/locales/*.ts` + `.i18n/*.meta.json` — F9 — i18n strings for mode-switcher/plan-cards/plan-approval

### Test infrastructure

- `test/vitest/vitest.plan-mode.config.ts` — F1-F12 — separate vitest config for plan-mode lane (55 LOC)
- `src/agents/test-helpers/fast-openclaw-tools-sessions.ts` — F1, F5 — modified

### Documentation

- `docs/concepts/plan-mode.md` — F1-F12 — 167-line conceptual doc
- `docs/plans/PLAN-MODE-ARCHITECTURE.md` — F1-F12 — 635 LOC architecture doc
- `docs/plans/PLAN-MODE-OPERATOR-RUNBOOK.md` — F1-F12 — 250 LOC ops runbook
- `docs/plans/rollout/README.md` — F1-F12 — rollout guide
- `docs/plans/rollout/openclaw-plan-mode-rollout.patch` — F1-F12 — 9420 LOC unified rollout patch
- `docs/agents/prompt-stack-spec.md` — F4 — system-prompt stacking spec
- `docs/tools/slash-commands.md` — F8 — /plan command docs
- `docs/help/testing.md` — F1-F12 — testing guidance

### QA scenarios

- `qa/scenarios/gpt54-plan-mode-default-off.md` — F1 — QA scenario
- `qa/scenarios/gpt54-act-dont-ask.md` — F5, F7
- `qa/scenarios/gpt54-cancelled-status.md` — F6
- `qa/scenarios/gpt54-injection-scan.md` — F12
- `qa/scenarios/gpt54-mandatory-tool-use.md` — F7

### Migration / context scanners

- `src/agents/context-file-injection-scan.ts` — F12 — new
- `src/agents/context-file-injection-scan.test.ts` — F12 — new tests
- `src/agents/plan-hydration.ts` — F4 — see above
- `src/agents/plan-hydration.test.ts` — F4 — new tests

### Tests modified (existing) to cover plan-mode

- `src/agents/pi-embedded-runner/run/attempt.test.ts` — F4
- `src/agents/pi-embedded-runner/run/attempt.spawn-workspace.test-support.ts` — F4
- `src/agents/pi-embedded-runner/run/attempt.spawn-workspace.context-engine.test.ts` — F4
- `src/agents/pi-embedded-runner/run.incomplete-turn.test.ts` — F7
- `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts` — F4
- `src/agents/pi-embedded-runner/skills-runtime.test.ts` — F5
- `src/agents/pi-embedded-runner/run/transcript-prompt-rewrite.test.ts` — DELETED
- `src/agents/pi-embedded-runner/run/transcript-prompt-rewrite.ts` — DELETED
- `src/agents/session-tool-result-guard.ts` — F4
- `src/agents/session-tool-result-guard.tool-result-persist-hook.test.ts` — F4
- `src/agents/skills.buildworkspaceskillsnapshot.test.ts` — F5
- `src/agents/agent-scope.test.ts` — F5
- `src/agents/tools/sessions-spawn-tool.ts` — F11
- `src/agents/tools/sessions-spawn-tool.test.ts` — F11
- `src/agents/tools/cron-tool.ts` — F5
- `src/agents/tools/update-plan-tool.test.ts` — F6
- `src/agents/tools/update-plan-tool.parity.test.ts` — F6 — new
- `src/gateway/sessions-patch.test.ts` — F2, F3, F8
- `src/gateway/sessions-patch.subagent-gate.test.ts` — F11 — new
- `src/gateway/server.chat.gateway-server-chat-b.test.ts` — F3
- `src/gateway/server.reload.test.ts` — F3
- `src/gateway/server-close.test.ts` — F3
- `src/infra/json-utf8-bytes.ts` — F4
- `src/infra/json-utf8-bytes.test.ts` — F4
- `src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts` — F4
- `src/agents/system-prompt-gpt5-boot-reorder.test.ts` — F4 — new

---

## Feature subsections

---

### F1. enter_plan_mode / exit_plan_mode tools

**Files:**
- `src/agents/tools/enter-plan-mode-tool.ts:1-77` — full file: `createEnterPlanModeTool({runId})`
- `src/agents/tools/enter-plan-mode-tool.ts:24-38` — schema `Type.Object({reason?: Type.String()}, {additionalProperties: false})`
- `src/agents/tools/enter-plan-mode-tool.ts:46-76` — `execute()` returns `{content:[{type:"text",text}], details:{status:"entered", mode:"plan", reason?}}`
- `src/agents/tools/exit-plan-mode-tool.ts:1-478` — full file: `createExitPlanModeTool({runId})`
- `src/agents/tools/exit-plan-mode-tool.ts:46-146` — schema with required `title` (≤80 chars), `plan` array (≥1 step), optional `summary`, `analysis`, `assumptions[]`, `risks[{risk,mitigation}]`, `verification[]`, `references[]`
- `src/agents/tools/exit-plan-mode-tool.ts:154-195` — `readPlanSteps()` validation: required step+status, status ∈ PLAN_STEP_STATUSES, ≤1 in_progress
- `src/agents/tools/exit-plan-mode-tool.ts:202-407` — `execute()` returns `{status:"approval_requested", title, summary?, plan, payloadHash, analysis?, assumptions?, risks?, verification?, references?}`
- `src/agents/tools/exit-plan-mode-tool.ts:221-231` — title required throw with actionable error
- `src/agents/tools/exit-plan-mode-tool.ts:353-362` — payloadHash via SHA-1 prefix(12) of `{t:title, s:summary, steps:[`${status}:${step}`]}` for race-fix idempotency
- `src/agents/tools/exit-plan-mode-tool.ts:410-478` — `readPlanArchetypeFields()` parser (defensive trim+drop-blank)
- `src/agents/openclaw-tools.ts:288-307` — registration: gated on `isPlanModeToolsEnabledForOpenClawTools({config})`; registers enter_plan_mode/exit_plan_mode/ask_user_question/plan_mode_status
- `src/agents/openclaw-tools.registration.ts:32` — registration metadata comment
- `src/agents/agent-scope.ts` — `isPlanModeToolsEnabledForOpenClawTools()` predicate (gates on `agents.defaults.planMode.enabled === true`)
- `src/agents/tool-catalog.ts:271-285` — catalog entries (enter_plan_mode, exit_plan_mode); `id: "enter_plan_mode"`/`"exit_plan_mode"`, `sectionId: "agents"`, `profiles: ["coding"]`, `includeInOpenClawGroup: true`
- `src/agents/tool-description-presets.ts` — `describeEnterPlanModeTool`, `ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY`, `describeExitPlanModeTool`, `EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:1791-1836` — enter_plan_mode intercept: calls `persistPlanModeEnter`, mirrors `runCtx.inPlanMode = true`, schedules nudges only on `enterResult.freshEntry`, emits planEnter event (kind:plugin, plan:[])
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:1838-1963` — exit_plan_mode intercept: persists approvalId via `persistPlanApprovalRequest`, prefers candidate or reuses persistResult.approvalId (race-fix), emits agent_approval_event (kind:plugin) with title + plan + archetype fields, fires `dispatchPlanArchetypeAttachment` (Telegram), fires `autoApproveIfEnabled`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237` — `persistPlanApprovalRequest` (the race-fix function)
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:261-361` — `persistPlanModeEnter` (writes mode/approval/cycleId/enteredAt/updatedAt/rejectionCount/blockingSubagentRunIds + carryAutoApprove)
- `skills/plan-mode-101/SKILL.md:1-149` — companion skill for normal-mode discovery (D7); same content as PLAN_MODE_REFERENCE_CARD

**Tests:**
- `src/agents/tools/exit-plan-mode-tool.test.ts:1-267` (20 tests) — title required; ≤80 char truncation; plan.length ≥ 1; status union enforcement; ≤1 in_progress; activeForm passthrough; subagent-gate hard-block via getAgentRunContext; SUBAGENT_SETTLE_GRACE_MS wait; payloadHash deterministic; analysis/assumptions/risks/verification/references parsing
- `src/agents/plan-mode/integration.test.ts:1-238` (25 tests) — end-to-end exit_plan_mode → sessions.patch → resolvePlanApproval flow; cycleId continuity; pendingInteraction transitions
- `src/agents/plan-mode/auto-enable.test.ts:1-96` (19 tests) — evaluateAutoEnableForMatch matching, malformed-pattern fallback, cache reset
- `src/gateway/sessions-patch.test.ts:1-603` (existing+new) — planMode patch branch + planApproval branch
- `src/cron/isolated-agent/run.plan-mode.test.ts:1-260` (~15 tests) — auto-enable wires at session start

**Hooks called in host:**
- `pi-embedded-subscribe.handlers.tools.ts:1791` — `toolName === "enter_plan_mode" && !isToolError` intercept after tool result
- `pi-embedded-subscribe.handlers.tools.ts:1838` — `toolName === "exit_plan_mode" && !isToolError` intercept
- `pi-embedded-subscribe.handlers.tools.ts:1971` — `toolName === "ask_user_question" && !isToolError` intercept
- `openclaw-tools.ts:288` — `isPlanModeToolsEnabledForOpenClawTools({config})` gate at tool-list materialization
- `infra/agent-events.ts:411` — `addOpenSubagent` (called on sessions_spawn) updates `ctx.openSubagentRunIds` + persists `blockingSubagentRunIds`
- `infra/agent-events.ts:497` — subagent settled → `lastSubagentSettledAt = now` + persists

**Public types added:**
- `src/agents/plan-mode/types.ts` — `PlanMode = "plan" | "normal"`, `PlanApprovalState`, `PlanModeSessionState`, `DEFAULT_PLAN_MODE_STATE`, `newPlanApprovalId(): string`, `buildPlanDecisionInjection()`
- `src/agents/plan-mode/index.ts` — re-export barrel
- `src/agents/tools/exit-plan-mode-tool.ts` — `CreateExitPlanModeToolOptions { runId? }`
- `src/agents/tools/enter-plan-mode-tool.ts` — `CreateEnterPlanModeToolOptions { runId? }`
- `src/agents/tool-description-presets.ts` — display-summary constants

**Config flags:**
- `agents.defaults.planMode.enabled: boolean` — master switch; default `false`; required `true` for in-host gating (`src/config/zod-schema.agent-defaults.ts:254`)
- `agents.defaults.planMode.debug: boolean` — enables `[plan-mode/<kind>]` lifecycle logs in gateway.err.log (`src/config/zod-schema.agent-defaults.ts:271`)
- `agents.defaults.planMode.autoEnableFor: string[]` — model-id regex patterns for auto-enable (`src/config/zod-schema.agent-defaults.ts:259`)
- `agents.defaults.planMode.approvalTimeoutSeconds: int` — [10, 86400]; SCHEMA-RESERVED, runtime wiring deferred
- env: `OPENCLAW_DEBUG_PLAN_MODE=1` — equivalent to `debug: true`; env wins

**Persistence schema:**
- `SessionEntry.planMode = {mode, approval, cycleId, enteredAt, confirmedAt, updatedAt, feedback, rejectionCount, approvalId, title, approvalRunId, lastPlanSteps[], lastPlanUpdatedAt, blockingSubagentRunIds[], lastSubagentSettledAt, nudgeJobIds[], autoApprove, lastPlanPayloadHash}` (`src/config/sessions/types.ts:274-385`)
- `SessionEntry.planModeIntroDeliveredAt: number` (`src/config/sessions/types.ts:433`) — survives `planMode` delete
- `SessionEntry.recentlyApprovedAt: number` (`src/config/sessions/types.ts:402`)
- `SessionEntry.recentlyApprovedCycleId: string` (`src/config/sessions/types.ts:408`)
- `SessionEntry.postApprovalPermissions: {acceptEdits, grantedAt, approvalId}` (`src/config/sessions/types.ts:96-100`)
- `SessionEntry.pendingInteraction: PendingInteraction` discriminated `{kind:"plan"|"question", approvalId, title, prompt?, options?, allowFreetext?, questionId?, status, createdAt, cycleId?}` (`src/config/sessions/types.ts:104-124`)

**Known race conditions handled:**
- **Empty-plan-body race fix** (`1081067476`) — `persistPlanApprovalRequest` writes `lastPlanSteps + title + lastPlanPayloadHash` synchronously inside the same `updateSessionStoreEntry` callback that arms `approvalId`. Pre-fix: async plan-snapshot-persister race with fast user approvals → empty `[PLAN_DECISION]: approved` injection.
- **Telegram /plan accept duplicate-fire** (`39199f8e42`, `86502f55fc`, `ea04ea52c7`) — payloadHash idempotency guard: when candidate `payloadHash === current.lastPlanPayloadHash` AND `current.approval === "pending"` AND `current.approvalId` valid, reuse the existing approvalId (`persistResult.reused = true`). Prevents orphaning the live approval card when the agent re-fires `exit_plan_mode` with the same payload.
- **CRITICAL emit-vs-persisted approvalId** — `pi-embedded-subscribe.handlers.tools.ts:1881` uses `persistResult.approvalId` (what disk says), not the candidate `approvalId`. Without this, reuse fires but emit refers to a fresh ID, re-orphaning from the other direction.
- **enter_plan_mode duplicate-nudge schedule** — `enterResult.freshEntry` boolean prevents unbounded `nudgeJobIds[]` growth on repeated `enter_plan_mode` calls when already in plan mode (refresh-only path).
- **subagent ctx-not-registered diagnostic** — tool-side gate logs "deferred to gateway gate (tool-side ctx unavailable)" instead of "allowed" so operators see the gateway-side gate is the safety net.

---

### F2. Mutation gate

**Files:**
- `src/agents/plan-mode/mutation-gate.ts:1-262` — full file
- `src/agents/plan-mode/mutation-gate.ts:27-40` — `MUTATION_TOOL_BLOCKLIST` = {apply_patch, bash, edit, exec, gateway, message, nodes, process, sessions_send, subagents, write} (sessions_spawn explicitly removed per PR-10 review #3105169112)
- `src/agents/plan-mode/mutation-gate.ts:43-46` — `MUTATION_SUFFIX_PATTERNS` (.write/.edit/.delete); `READONLY_SUFFIX_PATTERNS` (.read/.search/.list/.get/.view)
- `src/agents/plan-mode/mutation-gate.ts:49-107` — `PLAN_MODE_ALLOWED_TOOLS` = {read, web_search, web_fetch, memory_search, memory_get, update_plan, exit_plan_mode, session_status, ask_user_question, enter_plan_mode, sessions_spawn, plan_mode_status, sessions_list, sessions_history, sessions_yield, lcm_grep, lcm_expand_query}
- `src/agents/plan-mode/mutation-gate.ts:114-138` — `READ_ONLY_EXEC_PREFIXES` (ls/cat/pwd/git status/git log/git diff/git show/which/find/grep/rg/head/tail/wc/file/stat/du/df/echo/printenv/whoami/hostname/uname)
- `src/agents/plan-mode/mutation-gate.ts:153-262` — `checkMutationGate(toolName, currentMode, execCommand)` → `{blocked, reason?}`; default-deny for unknown tools when in plan mode
- `src/agents/plan-mode/mutation-gate.ts:176-183` — shell compound operator regex `/[;|&`\n\r]|\$\(|>>?|<\(|>\(/` (newline + redirect + subshell rejection)
- `src/agents/plan-mode/mutation-gate.ts:194-215` — DANGEROUS_FLAGS word-boundary regex (-delete/-exec/-execdir/--delete/-rf/--output/-fprint/-fprint0/-fprintf/-fls) — see PR-D #3096526195 / #3105045300 for -fprint family addition
- `src/agents/pi-tools.before-tool-call.ts:280-323` — invocation site; reads liveMode via `args.ctx?.getLatestPlanMode?.()`; `latestPlanMode = liveMode !== undefined ? liveMode : args.ctx?.planMode`
- `src/agents/pi-tools.ts:282-307` — `BeforeToolCallCtx` adds `planMode?: "plan" | "normal"`, `getLatestPlanMode?: () => "plan" | "normal" | undefined`, `getLatestAcceptEdits?: () => boolean`
- `src/agents/pi-tools.ts:749-755` — wires planMode + getLatestPlanMode + getLatestAcceptEdits when constructing the BeforeToolCallCtx
- `src/agents/pi-embedded-runner/run.ts:1769` (approx) — registers `getLatestPlanMode` callback on AgentRunContext
- `src/auto-reply/reply/agent-runner-execution.ts:1225` (approx) — wires getLatestPlanMode to disk-read of `SessionEntry.planMode.mode`

**Tests:**
- `src/agents/plan-mode/mutation-gate.test.ts:1-202` (34 tests) — blocked tools, allowed tools, exec prefix allowlist, exec without command, shell compound operator rejection (newline, `;`, `|`, `&`, backtick, `$()`, `<(`, `>(`), dangerous-flag rejection (-delete, -exec, -rf, --output, -fprint*), unknown-tool default-deny, MCP `.read` suffix passthrough
- `src/agents/plan-mode/integration.test.ts:1-238` (25 tests) — mutation gate ↔ approval ↔ post-approval transitions

**Hooks called in host:**
- `pi-tools.before-tool-call.ts:307` — `args.ctx?.getLatestPlanMode?.()` callback; if `liveMode === undefined` falls back to cached `args.ctx?.planMode`
- `pi-tools.before-tool-call.ts:317` — `checkMutationGate(toolName, latestPlanMode, execCommand)` — fires BEFORE plugin hookRunner
- `pi-tools.before-tool-call.ts:324` — when `liveMode === "normal"` AND `args.ctx?.getLatestAcceptEdits?.()` is true, calls `checkAcceptEditsConstraint`

**Public types added:**
- `src/agents/plan-mode/mutation-gate.ts:140-143` — `MutationGateResult { blocked: boolean; reason?: string }`

**Config flags:**
- Tied to `agents.defaults.planMode.enabled`. When `false`, plan-mode tools are not registered → gate never fires (default-deny on unknown tool would be never reachable).

**Persistence schema:**
- Reads `SessionEntry.planMode.mode` ("plan" | "normal") via the live-read callback
- Reads `SessionEntry.postApprovalPermissions.acceptEdits` for the layer-2 acceptEdits gate

**Known race conditions handled:**
- **iter-2 Bug A (stale planMode cache)** — fixed by `getLatestPlanMode()` returning fresh disk value; ternary `liveMode !== undefined ? liveMode : cached` distinguishes "no live data" from "live data says normal" so post-approval mutation calls don't get blocked by the cached "plan" snapshot.
- **sessions_spawn catch-22** (PR-10 #3105169112) — `sessions_spawn` removed from blocklist + added to allowlist (belt-and-suspenders).
- **sessions_yield catch-22** — added to allowlist after live-block on the approval/sub-agent race.

---

### F3. Plan-approval-request persistence

(sessions.patch + the empty-plan-body race fix at `1081067476`)

**Files:**
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237` — **THE RACE FIX**: `persistPlanApprovalRequest(sessionKey, approvalId, log, planSnapshot)` — writes `lastPlanSteps + title + approvalId + lastPlanPayloadHash` synchronously inside one `updateSessionStoreEntry` callback. Returns `{approvalId, reused}`. Idempotency guard at lines 193-205 (payloadHash match + pending + valid approvalId → reuse existing).
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:1863-1886` — invocation: `const persistResult = await persistPlanApprovalRequest(...); approvalId = persistResult.approvalId; if (persistResult.reused) log.warn(...)`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:261-361` — `persistPlanModeEnter(sessionKey, log)` — fresh-entry detection (returns `{ok, freshEntry}`); initializes `cycleId = randomUUID()`, `enteredAt`, `updatedAt`, `rejectionCount: 0`, `blockingSubagentRunIds: []`; carries `autoApprove` from prior cycle
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:387-481` — `autoApproveIfEnabled` (poll-until-pending with `POLL_INTERVAL_MS = 50`, `MAX_WAIT_MS = 2000`; bails if approval flips off mid-poll; error-level log on failure)
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:502-590` — `schedulePlanNudgesAndPersist`
- `src/gateway/plan-snapshot-persister.ts:1-744` — full file: `startPlanSnapshotPersister`, dual-listener architecture
- `src/gateway/plan-snapshot-persister.ts:84-234` — approval-stream listener: distinguishes plan submission from question submission; persists `planMode.title + approvalRunId + approvalId` via `persistApprovalMetadata`; persists `pendingInteraction` for questions via `persistPendingQuestionApprovalId`
- `src/gateway/plan-snapshot-persister.ts:235-280` — plan-stream listener: calls `persistSnapshot` with `closeOnComplete = phase === "completed"`
- `src/gateway/plan-snapshot-persister.ts:299-369` — `persistApprovalMetadata`: defensive `approvalRunId` empty-string guard (THROWS rather than silently bypass — C4 fix); writes title + approvalRunId + approvalId + updatedAt + sets pendingInteraction
- `src/gateway/plan-snapshot-persister.ts:385-429` — `persistPendingQuestionApprovalId`
- `src/gateway/plan-snapshot-persister.ts:431-733` — `persistSnapshot`: pre-flight `allowAutoClose` check + locked re-evaluation inside `updateSessionStore` callback; appliedAllowAutoClose mirrors locked decision for post-write side effects; PLAN_COMPLETE injection text built from locked decision; flips planMode to "normal" via `applySessionsPatchToStore` (re-entrant patch); `appendToInjectionQueue` writes `[PLAN_COMPLETE]: ...`; clears `postApprovalPermissions`
- `src/gateway/plan-snapshot-persister.ts:33-67` — `persistPlanModeSubagentGateState({sessionKey, mutate})` callback for in-place planMode mutation by subagent-tracking event handlers
- `src/gateway/plan-snapshot-persister.ts:742-744` — `__testingPlanSnapshotPersister` (test seam for direct `persistApprovalMetadata` call)
- `src/gateway/sessions-patch.ts:484-642` — planMode patch branch
- `src/gateway/sessions-patch.ts:534-541` — clear-to-normal materializes empty planMode shell when transitioning out
- `src/gateway/sessions-patch.ts:563-635` — fresh enter-plan: cycleId minted, rejectionCount cleared, carry autoApprove + planModeIntroDeliveredAt; emits [PLAN_MODE_INTRO] one-shot via appendToInjectionQueue
- `src/gateway/sessions-patch.ts:644-1133` — planApproval patch branch (action=approve/edit/reject/answer/auto)
- `src/gateway/sessions-patch.ts:664-770` — answer branch: requires approvalId, validates against `pendingQuestionApprovalId`, validates questionId match, validates answer membership in pendingQuestionOptions (when !allowFreetext)
- `src/gateway/sessions-patch.ts:771-810` — auto branch: requires `autoEnabled: boolean`; materializes planMode shell if missing
- `src/gateway/sessions-patch.ts:813-952` — approve/edit/reject path: requires planMode.approval==="pending"; subagent-gate (parentCtx + persistedOpenIds + lastSubagentSettledAt); `PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS` + `PLAN_APPROVAL_WAITING_FOR_SUBAGENT_SETTLE` + `PLAN_APPROVAL_GATE_STATE_UNAVAILABLE` errors; resolvePlanApproval state machine; emits `[PLAN_DECISION]: approved|edited|rejected` synthetic injection via appendToInjectionQueue; sets `recentlyApprovedAt` + `recentlyApprovedCycleId`; grants `postApprovalPermissions` on edit (`acceptEdits: true` + approvalId scope)
- `src/gateway/sessions-patch.ts:1064-1133` — approve/edit transition: cleans nudgeJobIds via cron.remove; auto-approve reset path; planMode delete
- `src/gateway/sessions-patch.ts:1135-1189` — lastPlanSteps materialization (read by plan-snapshot-persister)
- `src/agents/plan-mode/injections.ts:209-252` — `enqueuePendingAgentInjection` (re-entrant-safe; legacy migration; best-effort on write failure)
- `src/agents/plan-mode/injections.ts:283-338` — `consumePendingAgentInjections` (atomic drain-and-clear; drop captured entries on write failure)
- `src/agents/pi-embedded-runner/pending-injection.ts` — runtime consumer that composes pendingInjections into next-turn user prompt

**Tests:**
- `src/gateway/plan-snapshot-persister.test.ts:1-45` (4 tests) — basic persist tests + `__testingPlanSnapshotPersister` access
- `src/gateway/sessions-patch.subagent-gate.test.ts:1-404` (19 tests) — subagent-gate fail-closed semantics; combined parentCtx+persisted; PLAN_APPROVAL_GATE_STATE_UNAVAILABLE; PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS; allowed when settled
- `src/gateway/sessions-patch.test.ts:1-603` — planMode patch, planApproval patch (approve/edit/reject/answer/auto), discriminated-union validation, lastPlanSteps materialization
- `src/agents/plan-mode/injections.test.ts:1-449` (35 tests) — enqueue/consume/drain order/legacy migration/upsert/sort+cap/composePrompt
- `src/agents/pi-embedded-runner/pending-injection.test.ts:1-?` — pending-injection consumer
- `src/agents/plan-mode/approval.test.ts:1-349` (47 tests) — resolvePlanApproval state machine: approve clears feedback+rejectionCount, edit same, reject increments rejectionCount, timeout from pending, stale approvalId no-op, both-undefined approvalId rejected, terminal-state guard, "none"→reject path rejected
- `src/agents/plan-mode/integration.test.ts:1-238` (25 tests) — end-to-end
- `src/commands/doctor-session-transcripts.test.ts` — plan-mode-state integrity

**Hooks called in host:**
- `gateway/server-runtime-subscriptions.ts:?` — `startPlanSnapshotPersister({emitSessionsChanged})` registration alongside other listeners
- `gateway/server-close.ts:?` — teardown unsubscribe
- `gateway/server-reload-handlers.ts:?` — re-register on config reload
- `infra/agent-events.onAgentEvent` — both listeners subscribe (`stream === "approval"` and `stream === "plan"`)
- `gateway/sessions-patch.ts:1015,1057` — `appendToInjectionQueue` (inside the locked patch transaction)
- `gateway/plan-snapshot-persister.ts:704-709` — `appendToInjectionQueue` for `[PLAN_COMPLETE]`
- `gateway/sessions-patch.ts:632` — `appendToInjectionQueue` for `[PLAN_MODE_INTRO]` one-shot
- `pi-embedded-subscribe.handlers.tools.ts:1934-1948` — `dispatchPlanArchetypeAttachment` (Telegram markdown attach)

**Public types added:**
- `src/agents/plan-mode/injections.ts` — `PendingAgentInjectionEntry`, `PendingAgentInjectionKind`, `DEFAULT_INJECTION_PRIORITY`, `MAX_QUEUE_SIZE`, `ConsumePendingAgentInjectionsResult`
- `src/config/sessions/types.ts:155-163` — `PendingAgentInjectionEntry { id, approvalId?, kind, text, createdAt, priority?, expiresAt? }`
- `src/config/sessions/types.ts:102-124` — `PendingInteraction` discriminated union
- `src/gateway/protocol/schema/sessions.ts:259-312` — `planApproval` discriminated union of approve/edit/reject/answer/auto
- `src/gateway/protocol/schema/sessions.ts:192-194` — `planMode: Type.Union([Type.Literal("plan"), Type.Literal("normal"), Type.Null()])`
- `src/gateway/protocol/schema/error-codes.ts:24,37,47,64` — PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS, PLAN_APPROVAL_WAITING_FOR_SUBAGENT_SETTLE, PLAN_APPROVAL_GATE_STATE_UNAVAILABLE, PLAN_APPROVAL_EXPIRED

**Config flags:**
- `agents.defaults.planMode.enabled` — required for `planMode` and `planApproval` patch branches; sessions.patch returns INVALID_REQUEST with friendly message when disabled

**Persistence schema:**
- See F1.
- `SessionEntry.pendingAgentInjection?: string` (legacy, auto-migrated)
- `SessionEntry.pendingAgentInjections?: PendingAgentInjectionEntry[]` (queue; sorted at drain time; capped at 10)
- `SessionEntry.pendingInteraction?: PendingInteraction` (durable rehydration on reconnect)
- `SessionEntry.pendingQuestionApprovalId?: string` (legacy read-compat)
- `SessionEntry.pendingQuestionOptions?: string[]` (legacy)
- `SessionEntry.pendingQuestionAllowFreetext?: boolean` (legacy)

**Known race conditions handled:**
- **Empty-plan-body race** (commit `1081067476`) — synchronous lastPlanSteps+title write in persistPlanApprovalRequest. See top of file. **THE LOAD-BEARING FIX.**
- **Telegram /plan accept duplicate-fire** — lastPlanPayloadHash idempotency guard. Re-firing exit_plan_mode with the same payload reuses approvalId rather than rotating.
- **lastPlanSteps narrowing** (`plan-snapshot-persister.ts:649-663`) — type-guard at boundary maps unrecognized statuses to `"cancelled"` so corrupt snapshots don't false-positive on `closeOnComplete`.
- **Pre-flight vs locked allowAutoClose drift** — `plan-snapshot-persister.ts:580-621` re-checks the predicate inside the store-write lock; warns when decision flips (state drift between preflight and write). `appliedAllowAutoClose` (locked) — not preflight — drives the [PLAN_COMPLETE] injection text and `clearInPlanModeForSession`.
- **pendingInteraction approvalId mismatch on /plan answer** — answer-guard validates approvalId against `pendingQuestionApprovalId` BEFORE enqueueing the answer-injection; mismatched IDs rejected with friendly error.
- **Question event mis-routed to plan-submission persister** (Codex P2 #68939) — predicate requires NON-EMPTY plan array + no `data.question`. `plan: []` is the question-event tell.
- **Persist before broadcast** — persistPlanApprovalRequest awaited before emitAgentApprovalEvent (lines 1862-1918); user can't click Approve before approvalId is on disk.
- **autoApprove poll race** — 50ms poll for up to 2000ms before firing approval patch; aborts cleanly if approval never reaches pending state, manual card stays armed.
- **back-to-back race** — auto-approve aborts via warn log + manual fallback (`autoApproveIfEnabled` 414-456).
- **Drain-on-failure correctness** — `consumePendingAgentInjections` DROPS captured entries when write-failure prevents the clear, so the next turn doesn't double-deliver.

---

### F4. planMode runtime context propagation

(through run.ts, attempt.ts, prompt-build)

**Files:**
- `src/agents/pi-embedded-runner/run/params.ts` — adds `planMode?: "plan" | "normal"` to AttemptParams
- `src/agents/pi-embedded-runner/run.ts:896,1769,2025,2072` — threads `params.planMode` into AttemptParams + escalating-retry logic + `getLatestPlanMode` callback registration; reads `recentlyApprovedAt` from ctx
- `src/agents/pi-embedded-runner/run/attempt.ts:689-749` — `planModeAppendPrompt`: when `params.planMode === "plan"` builds PLAN MODE ACTIVE block + PLAN_ARCHETYPE_PROMPT + PLAN_MODE_REFERENCE_CARD; when feature enabled but not active builds PLAN MODE AVAILABLE block; otherwise empty string
- `src/agents/pi-embedded-runner/run/attempt.ts:117-118` — imports PLAN_ARCHETYPE_PROMPT + PLAN_MODE_REFERENCE_CARD
- `src/agents/pi-embedded-runner/run/attempt.ts:1269-1271` — `promptWithPlanMode = planModeAppendPrompt ? `${planModeAppendPrompt}\n\n${builtAppendPrompt}` : builtAppendPrompt`
- `src/agents/pi-embedded-runner/run/attempt.ts:819,896` — runtime context emission carries planMode
- `src/agents/pi-embedded-runner/run/runtime-context-prompt.ts` — runtime context prompt builder (new file)
- `src/agents/pi-embedded-runner/run/helpers.ts` — modified for planMode flow
- `src/agents/pi-embedded-runner/system-prompt.ts` — modified
- `src/agents/pi-embedded-runner/transcript-rewrite.ts` — modified
- `src/agents/pi-embedded-runner/context-engine-maintenance.ts` — modified
- `src/agents/pi-tools.ts:282-307` — BeforeToolCallCtx adds planMode + getLatestPlanMode + getLatestAcceptEdits
- `src/agents/pi-tools.ts:749-755` — wiring at ctx construction site
- `src/agents/pi-tools.before-tool-call.ts:307-308` — reads liveMode via callback
- `src/infra/agent-events.ts:252-340` — `AgentRunContext` fields: openSubagentRunIds, inPlanMode, planApproval, recentlyApprovedAt, getLatestPlanMode (live-read accessor), lastSubagentSettledAt, planMode (snapshot fallback)
- `src/infra/agent-events.ts:355-356` — `persistPlanModeSubagentGateState` mutation-callback type
- `src/infra/agent-events.ts:406-516` — `addOpenSubagent`, `removeOpenSubagent` (mutate openSubagentRunIds set + persist `blockingSubagentRunIds`)
- `src/auto-reply/reply/agent-runner-execution.ts:1225` — disk-read of `SessionEntry.planMode.mode` for getLatestPlanMode callback
- `src/agents/plan-hydration.ts:1-71` — `formatPlanForHydration(steps)` post-compaction injection ([Your active plan was preserved across context compression])
- `src/agents/system-prompt.ts` — system prompt composition
- `src/agents/system-prompt-contribution.ts` — plan-mode contribution
- `src/agents/transport-message-transform.ts` — modified
- `src/gateway/server-methods/chat-transcript-inject.ts` — modified
- `src/agents/session-tool-result-guard.ts` — modified for planMode awareness

**Tests:**
- `src/agents/plan-hydration.test.ts:1-70` (8 tests) — hydration formatting + filter active statuses + multiline strip
- `src/agents/pi-embedded-runner/run.incomplete-turn.test.ts` — escalating-retry with planMode
- `src/agents/pi-embedded-runner/run/incomplete-turn.test.ts` — incomplete-turn predicates with planMode
- `src/agents/pi-embedded-runner/run/runtime-context-prompt.test.ts` — new tests
- `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts` — modified for planMode hydration
- `src/agents/pi-embedded-runner/run/attempt.test.ts` — modified
- `src/agents/pi-embedded-runner/run/attempt.spawn-workspace.context-engine.test.ts` — modified
- `src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts` — modified
- `src/agents/system-prompt-gpt5-boot-reorder.test.ts:1-?` — new test

**Hooks called in host:**
- `pi-embedded-runner/run.ts:1769` (approx) — `getLatestPlanMode` callback wired onto AgentRunContext at run-start
- `pi-embedded-runner/run/attempt.ts:689` — `planModeFeatureEnabled` check against config
- `pi-tools.before-tool-call.ts:307` — `getLatestPlanMode` invoked before every tool call
- `infra/agent-events.ts:411,499` — `addOpenSubagent`/`removeOpenSubagent` mutate ctx.openSubagentRunIds AND persist `blockingSubagentRunIds` + `lastSubagentSettledAt`
- `infra/agent-events.ts:414` — `persistPlanModeSubagentGateState` called on every spawn/return event when `ctx.inPlanMode === true`
- `pi-embedded-runner/run.ts:?` — runtime emits planMode in transcript runtime-context block

**Public types added:**
- `src/infra/agent-events.ts:252-340` — `AgentRunContext.openSubagentRunIds: Set<string>`, `AgentRunContext.inPlanMode: boolean`, `AgentRunContext.recentlyApprovedAt: number`, `AgentRunContext.getLatestPlanMode: () => PlanMode | undefined`, `AgentRunContext.planMode: PlanMode | undefined` (snapshot), `AgentRunContext.lastSubagentSettledAt: number`
- `src/agents/pi-tools.ts` — BeforeToolCallCtx fields

**Config flags:**
- `agents.defaults.planMode.enabled` — gates `planModeFeatureEnabled` branch in attempt.ts
- `agents.defaults.compaction.reserveTokensFloor` — feature-relevant (was added as part of plan-mode work; floor at 30000 per memory file)

**Persistence schema:**
- `SessionEntry.planMode.mode` is read by getLatestPlanMode
- `SessionEntry.recentlyApprovedAt` survives planMode delete on approve/edit

**Known race conditions handled:**
- **iter-2 Bug A** (cached planMode after approval) — fixed by `getLatestPlanMode()` returning fresh disk value with `liveMode === undefined` distinguished from "live data says normal"
- **Subagent settle-grace race** — SUBAGENT_SETTLE_GRACE_MS = 10_000ms; ctx.lastSubagentSettledAt advanced on every remove

---

### F5. Plan archetype + ask_user_question + auto mode (PR-10)

**Files:**
- `src/agents/plan-mode/plan-archetype-prompt.ts:1-169` — full file: `PLAN_ARCHETYPE_PROMPT` (decision-complete plan standard; ~120 lines of system-prompt fragment); `buildPlanFilenameSlug`, `buildPlanFilename`
- `src/agents/plan-mode/plan-archetype-bridge.ts:1-210` — full file: `dispatchPlanArchetypeAttachment` (markdown render → persist → SessionEntry deliveryContext → telegram document upload); `buildPlanAttachmentCaption` (HTML)
- `src/agents/plan-mode/plan-archetype-persist.ts:1-218` — full file: `persistPlanArchetypeMarkdown({agentId, title, markdown, now?, baseDir?, _writeFileForTest?})`; atomic O_CREAT|O_EXCL ("wx"); MAX_COLLISION_SUFFIX = 99; per-day filename slug; PlanPersistStorageError(ENOSPC/EACCES/EIO)
- `src/agents/plan-mode/auto-enable.ts:1-79` — `evaluateAutoEnableForMatch(modelId, patterns)`; compiledPatternCache map; `__resetCompiledPatternCacheForTests`
- `src/cron/isolated-agent/run.ts` — calls auto-enable check before turn dispatch; flips planMode.mode → "plan" when match
- `src/cron/normalize.ts` — modified
- `src/cron/types.ts` — modified
- `src/agents/tools/ask-user-question-tool.ts:1-131` — full file: `createAskUserQuestionTool({runId})`; schema {question, options 2-6, allowFreetext?} additionalProperties:false; duplicate-option rejection; questionId = `q-${toolCallId}`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:1965-2019` — ask_user_question intercept: emits agent_approval_event with `kind: "plugin"`, `plan: []`, `question: {prompt, options, allowFreetext, questionId?}`, `approvalId = "question-${toolCallId}"`
- `src/gateway/plan-snapshot-persister.ts:114-209` — question-event branch: distinguishes by `data.question` presence + `plan: []`; calls `persistPendingQuestionApprovalId`
- `src/gateway/sessions-patch.ts:664-770` — answer branch (validates approvalId match + questionId match + options-membership)
- `src/agents/plan-mode/plan-nudge-crons.ts:1-213` — full file: `schedulePlanNudges` (default [10,30,60]min crons; calls cron.add gateway tool); `cleanupPlanNudges`; PLAN_NUDGE_NAME_PREFIX; `[PLAN_NUDGE]:` text format
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:502-590` — `schedulePlanNudgesAndPersist` (only on freshEntry)
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:1949-1961` — `autoApproveIfEnabled` invocation
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:387-481` — `autoApproveIfEnabled` full impl
- `src/agents/plan-render.ts:255-358` — `renderFullPlanArchetypeMarkdown` (#Title/Summary/Analysis/Plan/Assumptions/Risks/Verification/References + footer)
- `src/gateway/sessions-patch.ts:578-607` — auto-approve carry-forward + `[PLAN_MODE_INTRO]:` one-shot text emission
- `src/agents/agent-scope.ts` — `isPlanModeToolsEnabledForOpenClawTools`
- `src/agents/openclaw-tools.ts:295-307` — ask_user_question + plan_mode_status registration
- `src/agents/tool-catalog.ts:286-296` — ask_user_question catalog entry
- `src/agents/tool-description-presets.ts` — ASK_USER_QUESTION_TOOL_DISPLAY_SUMMARY + describeAskUserQuestionTool
- `src/agents/skills/skill-planner.ts:1-118` — new (~118 LOC) — skill planning helper
- `src/agents/skills/skill-planner.test.ts:1-431` — new tests
- `src/agents/skills/types.ts` — modified
- `src/agents/skills/frontmatter.ts` — modified
- `src/agents/skills/workspace.ts` — modified
- `skills/plan-mode-101/SKILL.md:1-149` — companion skill
- `src/plugin-sdk/telegram.ts:1-?` — new: re-exports sendDocumentTelegram for plan-bridge
- `extensions/telegram/src/send.ts` — modified
- `extensions/telegram/runtime-api.ts` — re-exports
- `src/plugins/contracts/plugin-sdk-runtime-api-guardrails.test.ts` — modified
- `qa/scenarios/gpt54-act-dont-ask.md` — QA scenario
- `qa/scenarios/gpt54-mandatory-tool-use.md` — QA scenario
- `docs/concepts/plan-mode.md` — concept doc
- `src/agents/tools/cron-tool.ts` — modified

**Tests:**
- `src/agents/tools/ask-user-question-tool.test.ts:1-174` (16 tests) — schema validation, duplicate option rejection, ≤6/≥2 cap, questionId determinism
- `src/agents/plan-mode/plan-archetype-prompt.test.ts:1-100` (18 tests) — PLAN_ARCHETYPE_PROMPT contains expected sections (title/summary/analysis/plan/assumptions/risks/verification/references); "Questions DO NOT exit plan mode"; "no upper limit"; buildPlanFilenameSlug NFKD + diacritic + kebab; buildPlanFilename ISO date prefix
- `src/agents/plan-mode/plan-archetype-bridge.test.ts:1-318` (12 tests) — render+persist+delivery; caption HTML escape; deliveryContext.channel branch; symlink protection
- `src/agents/plan-mode/plan-archetype-persist.test.ts:1-249` (15 tests) — atomic exclusive write; collision suffix; agentId path traversal reject; symlink reject; ENOSPC/EACCES/EIO → PlanPersistStorageError
- `src/agents/plan-mode/auto-enable.test.ts:1-96` (19 tests) — model-id regex matching, malformed-pattern fallthrough, empty inputs, cache hit
- `src/agents/plan-mode/plan-nudge-crons.test.ts:1-265` (19 tests) — schedule + cleanup + jobName format + sessionTarget validation + nudgeId extraction
- `src/agents/skills/skill-planner.test.ts:1-431` (~30 tests)
- `src/cron/isolated-agent/run.plan-mode.test.ts:1-260` (~15 tests) — auto-enable runtime
- `src/agents/skills.buildworkspaceskillsnapshot.test.ts` — modified
- `src/agents/skills/frontmatter.test.ts` — modified
- `src/agents/agent-scope.test.ts` — modified

**Hooks called in host:**
- `cron/isolated-agent/run.ts:?` — `evaluateAutoEnableForMatch(resolvedModelId, cfg.agents?.defaults?.planMode?.autoEnableFor)` at session-start; sets `planMode: "plan"` if match + no prior planMode state
- `pi-embedded-subscribe.handlers.tools.ts:1812` — `schedulePlanNudgesAndPersist` (fire-and-forget after enter_plan_mode freshEntry)
- `pi-embedded-subscribe.handlers.tools.ts:1956` — `autoApproveIfEnabled` (fire-and-forget after exit_plan_mode emit)
- `pi-embedded-subscribe.handlers.tools.ts:1938` — `dispatchPlanArchetypeAttachment` (Telegram attach)
- `gateway/sessions-patch.ts:771-810` — planApproval auto branch (action="auto", autoEnabled boolean)
- `gateway/plan-snapshot-persister.ts:84-234` — approval-stream listener distinguishes plan vs question vs intent
- `extensions/telegram/...` — sendDocumentTelegram for plan archetype attach

**Public types added:**
- `src/agents/plan-mode/plan-archetype-bridge.ts:26-58` — `DispatchPlanArchetypeAttachmentInput`
- `src/agents/plan-mode/plan-archetype-persist.ts:17-51` — `PersistPlanArchetypeMarkdownInput`, `PersistPlanArchetypeMarkdownResult`, `PlanPersistStorageError`
- `src/agents/plan-mode/plan-nudge-crons.ts:41-50` — `PlanNudgeSchedulerDeps`, `ScheduledPlanNudge`
- `src/agents/tools/ask-user-question-tool.ts:62-65` — `CreateAskUserQuestionToolOptions`
- `src/agents/plan-render.ts:255-266` — `PlanArchetypeMarkdownInput`

**Config flags:**
- `agents.defaults.planMode.enabled: boolean` — required
- `agents.defaults.planMode.autoEnableFor: string[]` — regex patterns, e.g. `["^openai/gpt-5\\."]`
- `agents.defaults.planMode.approvalTimeoutSeconds: int` — SCHEMA-RESERVED for timeout watchdog
- `intervals` arg on schedulePlanNudges (NOT a config field — per-call override; default [10,30,60] minutes)

**Persistence schema:**
- `SessionEntry.planMode.nudgeJobIds?: string[]` — for cleanup
- `SessionEntry.planMode.autoApprove?: boolean` — survives mode→normal transition; cleared only via `/plan auto off` or explicit action
- `SessionEntry.pendingInteraction.kind === "question"` — `{approvalId, questionId?, title, prompt, options[], allowFreetext, createdAt, status, cycleId?}`
- `SessionEntry.planModeIntroDeliveredAt?: number` — gates [PLAN_MODE_INTRO] one-shot at SessionEntry root

**Known race conditions handled:**
- **Question approval shape collision with plan-submission** (Codex P2 #68939) — predicate requires `plan` array non-empty + no `data.question`
- **Auto-approve back-to-back race** — poll-until-pending in autoApproveIfEnabled (`MAX_WAIT_MS = 2000`); manual card fallback on persistence delay
- **Question event mis-routed** — split into separate `isQuestionSubmission` branch; persists pendingInteraction
- **Repeat-enter nudge schedule unbounded growth** — `freshEntry` boolean prevents re-scheduling
- **Plan-attachment recoverable storage errors** — PlanPersistStorageError class with operator-actionable `[plan-bridge/storage]` log

---

### F6. Plan title + turn limit (PR-9)

**Files:**
- `src/agents/tools/exit-plan-mode-tool.ts:52-61` — `title: Type.Optional(Type.String({description: "...≤80 chars..."}))` in schema
- `src/agents/tools/exit-plan-mode-tool.ts:221-232` — title REQUIRED at runtime; `trimmedTitle.slice(0, 80)` truncate
- `src/agents/tools/update-plan-tool.ts:1-475` — modified for closure-gate fields (acceptanceCriteria/verifiedCriteria) and PLAN_STEP_STATUSES export
- `src/config/types.agent-defaults.ts:295-327` — `agents.defaults.embeddedPi.autoContinue` + `maxIterations: int [1, 100_000]` (replaces auth-count-scaled default; floor at 500 per memory)
- `src/config/zod-schema.agent-defaults.ts:218-249` — embeddedPi.autoContinue + maxIterations schema; `maxIterations: z.number().int().min(1).max(100_000)`
- `src/config/types.agent-defaults.ts:537` — `compaction.reserveTokensFloor: number` config field
- `src/config/zod-schema.agent-defaults.ts:177` — `reserveTokensFloor: z.number().int().nonnegative()`
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:1888-1895` — approval card prefers explicit `title` > `summary` > generic
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:218` — title persisted via `persistPlanApprovalRequest`
- `src/gateway/plan-snapshot-persister.ts:116,342-345` — title threaded through persistApprovalMetadata
- `src/config/sessions/types.ts:306` — `planMode.title?: string` doc + lifecycle
- `src/agents/plan-mode/plan-archetype-prompt.ts:142-167` — `buildPlanFilenameSlug` for persisted markdown filename; `buildPlanFilename` produces `plan-YYYY-MM-DD-<slug>.md`
- `src/agents/tools/exit-plan-mode-tool.ts:336-342` — confirmation text uses `headlineLabel = title ?? summary`
- `ui/src/ui/views/plan-approval-inline.ts:71-77` — UI prefers explicit title; falls back to "Agent proposed a plan"
- `src/agents/tools/update-plan-tool.parity.test.ts:1-411` — new (extensive parity tests)
- `qa/scenarios/gpt54-cancelled-status.md` — QA scenario

**Tests:**
- `src/agents/tools/exit-plan-mode-tool.test.ts` — title required, ≤80 char truncation, summary fallback, title fallback chain
- `src/agents/tools/update-plan-tool.test.ts:1-?` — modified (closure-gate fields, status enum)
- `src/agents/tools/update-plan-tool.parity.test.ts:1-411` — new

**Hooks called in host:**
- `exit-plan-mode-tool.ts:223` — `ToolInputError` throw if title empty (forces agent retry with title)
- `persistPlanApprovalRequest` — title threaded into planMode persistence
- `persistApprovalMetadata` — title threaded into approval metadata

**Public types added:**
- `src/agents/tools/update-plan-tool.ts` — `PLAN_STEP_STATUSES`, `PlanStepStatus` (canonical exported tuple)

**Config flags:**
- `agents.defaults.embeddedPi.maxIterations: int [1, 100_000]` — outer-loop turn budget; replaces default which is floored at 500
- `agents.defaults.compaction.reserveTokensFloor: int` — feature-relevant; default per memory file is 30000

**Persistence schema:**
- `SessionEntry.planMode.title?: string` (≤80 chars)

**Known race conditions handled:**
- **Title overwriting from question event** (Codex P2 #68939) — plan-snapshot-persister.ts requires non-empty plan + no question to avoid overwriting plan title with question title

---

### F7. Auto-continue + escalating retry

(GPT-5.4 planning-only parity)

**Files:**
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:1-1070` — full file
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:151-156` — PLANNING_ONLY_RETRY_INSTRUCTION + FIRM + FINAL
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:157-160` — REASONING_ONLY_RETRY_INSTRUCTION, EMPTY_RESPONSE_RETRY_INSTRUCTION
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:161-164` — ACK_EXECUTION_FAST_PATH_INSTRUCTION, AUTO_CONTINUE_FAST_PATH_INSTRUCTION
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:165-166` — STRICT_AGENTIC_BLOCKED_TEXT
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:226-243` — PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION + FIRM
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:245` — DEFAULT_PLAN_MODE_ACK_ONLY_RETRY_LIMIT = 2
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:254-265` — PLAN_APPROVED_YIELD_RETRY_INSTRUCTION + FIRM
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:267` — DEFAULT_PLAN_APPROVED_YIELD_RETRY_LIMIT = 2
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:203-217` — PLAN_MODE_INVESTIGATIVE_TOOL_NAMES set (read, lcm_grep, lcm_describe, lcm_expand_query, lcm_expand, grep, glob, ls, find, web_search, web_fetch, update_plan, enter_plan_mode)
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:449,468,497,516,540,545,611,617,728,752,768,814,854,860,876` — `planModeActive`/`recentlyApprovedAt` predicates in `resolvePlanningOnlyRetryInstruction`, `resolvePlanModeAckOnlyRetryInstruction`, `resolveYieldDuringApprovedPlanInstruction`
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:907-940` — investigation-tool detection
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:991-1024` — predicate dispatch for "yield after approval" vs "planning-only" vs "ack-only"
- `src/agents/pi-embedded-runner/run.ts:631-3000` (large section) — auto-continue cycle loop: `planModeAckOnlyRetryAttempts`, `maxPlanModeAckOnlyRetryAttempts`, `rateLimitProfileRotations` rotation cap, profile-rotation logging
- `src/agents/pi-embedded-runner/run.ts:1990-2060` — ack-only retry decision: reads `ackRetryLatestPlanMode` via getLatestPlanMode + `ackRetryAckCtx.recentlyApprovedAt`; calls `resolvePlanModeAckOnlyRetryInstruction`; bumps `planningOnlyRetryInstruction`
- `src/agents/pi-embedded-runner/run.ts:2061-2096` — yield-after-approval retry decision via `resolveYieldDuringApprovedPlanInstruction`
- `src/agents/pi-embedded-runner/run.ts:2130-2380` — incompleteTurnText + planningOnlyRetry + strict-agentic-blocked composition; mutates loop variables
- `src/config/zod-schema.agent-defaults.ts:223-237` — autoContinue schema: enabled boolean, maxCycles int [1,10], stopOnMutation boolean
- `src/config/types.agent-defaults.ts:300-310` — autoContinue typed surface
- `src/infra/heartbeat-runner.ts:726-790` — `buildActivePlanNudge(planMode)` suppresses [PLAN_NUDGE] when approval==="pending" or `planMode.updatedAt` within idle threshold
- `src/agents/plan-mode/plan-nudge-crons.ts` — see F5 above (interacts with auto-continue/retry surface)
- `src/agents/pi-embedded-runner/pending-injection.ts` — runtime consumer that drains injections; sees [PLAN_NUDGE], [PLAN_ACK_ONLY], [PLAN_YIELD], [PLANNING_RETRY] tags
- `src/agents/system-prompt-gpt5-boot-reorder.test.ts` — new test
- `qa/scenarios/gpt54-act-dont-ask.md`, `qa/scenarios/gpt54-mandatory-tool-use.md` — QA scenarios

**Tests:**
- `src/agents/pi-embedded-runner/run/incomplete-turn.test.ts` — new tests for resolvePlanModeAckOnlyRetryInstruction; resolveYieldDuringApprovedPlanInstruction; resolvePlanningOnlyRetryInstruction
- `src/agents/pi-embedded-runner/run.incomplete-turn.test.ts` — modified (auto-continue + escalating-retry across cycles)
- `src/infra/heartbeat-runner.plan-nudge.test.ts:1-191` (new) — buildActivePlanNudge suppression cases
- `src/agents/pi-embedded-runner/run/runtime-context-prompt.test.ts` — new
- `src/agents/pi-embedded-runner/run/attempt.test.ts` — modified

**Hooks called in host:**
- `pi-embedded-runner/run.ts:?` — outer loop reads `cfg.agents.defaults.embeddedPi.autoContinue` + `maxIterations`
- `pi-embedded-runner/run.ts:2046-2060` — auto-continues with `planModeAckOnlyInstruction` until `maxPlanModeAckOnlyRetryAttempts`
- `pi-embedded-runner/run.ts:2078-2096` — yield-during-approved-plan retry steer
- `heartbeat-runner.ts:729` — `buildActivePlanNudge(entry.planMode)` before nudge injection

**Public types added:**
- `incomplete-turn.ts` — `PlanningOnlyPlanDetails`, `IncompleteTurnAttempt`, `RunLivenessAttempt`, `EmbeddedRunLivenessState`, exported instruction-string constants

**Config flags:**
- `agents.defaults.embeddedPi.autoContinue.enabled: boolean` — default false
- `agents.defaults.embeddedPi.autoContinue.maxCycles: int [1, 10]` — default 3; each cycle ≈ 4 API calls
- `agents.defaults.embeddedPi.autoContinue.stopOnMutation: boolean` — default true
- `agents.defaults.embeddedPi.maxIterations: int [1, 100_000]` — outer-loop turn budget

**Persistence schema:** (no new fields; reads existing `recentlyApprovedAt`, `planMode.approval`, `planMode.updatedAt`)

**Known race conditions handled:**
- **Cached planMode goes stale post-approval** — uses `getLatestPlanMode` and `recentlyApprovedAt` post-deletion grace
- **Approval-just-landed announce race** — `recentlyApprovedAt` survives planMode delete; predicate reads it
- **Heartbeat nudges race with plan-approval-pending** — buildActivePlanNudge returns null when approval==="pending"
- **Idle-threshold spurious nudges** — fixed in Codex P2 #68939 by updating planMode.updatedAt on every lastPlanSteps write

---

### F8. Rejection UX with feedback + cycle tracking (PR-11)

**Files:**
- `src/agents/plan-mode/types.ts:42-50` — `PlanApprovalState` includes "rejected"
- `src/agents/plan-mode/types.ts:52-96` — `PlanModeSessionState.feedback?: string`; `rejectionCount: number`; `approvalId?: string`
- `src/agents/plan-mode/types.ts:158-160` — `sanitizeFeedbackForInjection` defends against `[/PLAN_DECISION]` envelope escape via U+200B zero-width-space
- `src/agents/plan-mode/types.ts:185-207` — `buildPlanDecisionInjection(decision, feedback?, rejectionCount?)` — `decision: "rejected" | "expired" | "timed_out"`; on rejected adds "Revise your plan based on the feedback..." and if rejectionCount≥3 "Multiple revisions have been rejected. Consider asking the user to clarify their goal before proposing another plan."
- `src/agents/plan-mode/approval.ts:44-141` — `resolvePlanApproval(current, action, feedback?, expectedApprovalId?)`:
  - approve: mode→normal, approval→"approved", confirmedAt, feedback cleared, rejectionCount reset to 0
  - edit: same as approve (mode→normal, approval→"edited", feedback cleared, rejectionCount reset)
  - reject: mode stays "plan", approval→"rejected", rejectionCount++, feedback persisted (or kept if undefined)
  - timeout: mode stays "plan", approval→"timed_out" (only from pending)
  - Stale-approvalId guard (both expectedApprovalId provided AND mismatched OR current.approvalId undefined while expected provided → no-op)
  - Terminal-state guard (current.approval !== "pending" && current.approval !== "rejected" → no-op for approve/edit/reject)
  - "none" with no expectedApprovalId → no-op (PR-D Codex P2 fix)
- `src/gateway/sessions-patch.ts:935-952` — rejection-side handling: reads feedback from `action === "reject"` (discriminated union enforces feedback required at schema layer); passes through `resolvePlanApproval`; checks stale-id return; sets `next.planMode = {...resolved, updatedAt: now}`
- `src/gateway/sessions-patch.ts:1043-1063` — reject branch: builds rejectText with feedback; appendToInjectionQueue `{id: `plan-decision-${rejectApprovalId}`, kind: "plan_decision", text: "[PLAN_DECISION]: rejected\nfeedback: ..."}`; clears pendingInteraction
- `src/gateway/protocol/schema/sessions.ts:275-294` — `reject` variant schema: `feedback: Type.String({minLength: 1, maxLength: 8192})` REQUIRED
- `src/auto-reply/reply/commands-plan.ts:161-175` — `/plan revise <feedback>` parser; rejects empty feedback at parse time
- `src/auto-reply/reply/commands-plan.ts:516-571` — accept/revise dispatch via `sessions.patch { planApproval: { action: "reject", feedback, approvalId } }`; `shouldContinue: true` so agent revises immediately
- `src/auto-reply/reply/commands-plan.ts:582-606` — friendly mapping of "stale approvalId"/"terminal approval state"/PLAN_APPROVAL_GATE_STATE_UNAVAILABLE error
- `src/auto-reply/reply/commands-plan.ts:296-310` — `readLatestSessionEntryFresh` disk-read (avoid stale snapshot)
- `src/auto-reply/reply/fresh-session-entry.ts:1-168` — new helper module
- `src/auto-reply/reply/fresh-session-entry.test.ts:1-314` — new tests
- `src/auto-reply/reply/commands-plan.ts:521-523` — `[plan-accept-debug]` console.warn at precondition (added in commit ea04ea52c7 for live diagnosis)
- `ui/src/ui/views/plan-approval-inline.ts:103-141` — Revise inline textarea state: reviseOpen + reviseDraft props; Cmd+Enter submit; Escape cancel
- `ui/src/ui/views/plan-approval-inline.ts:165-171` — "Revise" button with onReviseOpen; tooltip "Send back for revision; agent stays in plan mode"
- `src/agents/plan-mode/types.ts:42-50` — "timed_out" canonical name (with "expired" legacy alias in buildPlanDecisionInjection)
- `src/plugins/command-registration.ts` — /plan command registration
- `src/agents/transport-message-transform.ts` — modified for [PLAN_DECISION] tag handling

**Tests:**
- `src/agents/plan-mode/approval.test.ts:1-349` (47 tests) — full resolvePlanApproval state machine matrix
- `src/auto-reply/reply/commands-plan.test.ts:1-742` (43 tests) — `/plan revise <feedback>` parsing, empty feedback rejection, accept/reject/auto/answer/restate/view/on/off/status dispatch
- `src/auto-reply/reply/fresh-session-entry.test.ts:1-314` (~30 tests) — readLatestSessionEntryFresh disk-read fallback behavior
- `src/gateway/sessions-patch.test.ts:1-603` — discriminated-union schema validation; reject feedback required; reject increments rejectionCount; approve clears feedback
- `ui/src/ui/views/plan-approval-inline.test.ts:1-295` (~25 tests) — Revise inline textarea state, submit, cancel, error states
- `ui/src/ui/chat/slash-command-executor.node.test.ts:1-160` (new) — slash command dispatch tests

**Hooks called in host:**
- `sessions-patch.ts:935` — `resolvePlanApproval` invocation
- `sessions-patch.ts:1057` — `appendToInjectionQueue` for [PLAN_DECISION]: rejected
- `commands-plan.ts:556` — `callPatch({ planApproval: { action: "reject", feedback, approvalId } })`
- `commands-plan.ts:306` — `readLatestSessionEntryFresh` (disk read)
- `ui/views/plan-approval-inline.ts:166` — onReviseOpen click → opens textarea state

**Public types added:**
- `src/agents/plan-mode/approval.ts:26-29` — `PlanApprovalConfig { approvalTimeoutSeconds: number }`
- `src/agents/plan-mode/approval.ts:31` — `DEFAULT_APPROVAL_CONFIG`
- `src/auto-reply/reply/commands-plan.ts:48-58` — `PlanSubcommand` discriminated union; `ParsedPlanCommand`

**Config flags:**
- `agents.defaults.planMode.approvalTimeoutSeconds` (SCHEMA-RESERVED for max-cycle/timeout — current default is 600s but runtime watchdog deferred)
- No max-rejection-cycles config; the "≥3 rejections" suggestion is hardcoded in `buildPlanDecisionInjection` (cycle tracking via SessionEntry.planMode.rejectionCount)

**Persistence schema:**
- `SessionEntry.planMode.rejectionCount: number` (REQUIRED field on planMode object)
- `SessionEntry.planMode.feedback?: string` (persisted across cycles; cleared on approve/edit)
- `SessionEntry.planMode.approvalId?: string` — version token for stale-click protection

**Known race conditions handled:**
- **Telegram /plan accept after agent re-fires exit_plan_mode with same payload** — readLatestSessionEntryFresh + idempotency guard means the user's `/plan accept` text-command lands on the persisted approvalId, not the stale snapshot
- **Stale approvalId** — resolvePlanApproval returns `current` (unchanged) when expectedApprovalId mismatches; sessions-patch.ts:945 detects this and returns INVALID_REQUEST with friendly text
- **Feedback envelope escape** — sanitizeFeedbackForInjection replaces `[/PLAN_DECISION]` with `[​/PLAN_DECISION]`
- **Double-click /plan accept** — friendly "Plan was already resolved (likely a duplicate command)" mapping in commands-plan.ts:586

---

### F9. Mode-switcher UI + plan cards

(split sidebar OR popup-during-exec)

**Files:**
- `ui/src/ui/chat/mode-switcher.ts:1-424` — full file: pill/chip with dropdown; ModeDefinition; planMode + planAutoApprove props; calls `sessions.patch` with `{ planMode, planApproval.action:"auto", autoEnabled }`
- `ui/src/ui/chat/mode-switcher.ts:50-90` — SVG icons (shield, check, unlock, plan)
- `ui/src/ui/chat/plan-cards.ts:1-122` — full file: `renderPlanCard(PlanCardData)` using <details>/<summary>; STATUS_MARKERS {pending:"⬚", in_progress:"⏳", completed:"✅", cancelled:"❌"}; `formatPlanAsMarkdown(plan)`
- `ui/src/ui/chat/plan-resume.ts:1-21` — full file: plan-resume helper
- `ui/src/ui/views/plan-approval-inline.ts:1-306` — full file: inline plan approval card above chat input bar; Accept / Accept allow edits / Revise buttons + Open plan link + revise textarea state + question variant + "Other..." inline textarea
- `ui/src/styles/chat/plan-cards.css:1-134` — new (134 LOC) — plan card styling
- `ui/src/styles/chat.css` — modified
- `ui/src/styles/chat/layout.css` — modified
- `ui/src/ui/views/chat.ts:?` — large refactor (+554 lines) — chat view with plan-approval-inline integration; hidden chat-input-bar when planApprovalRequest != null
- `ui/src/ui/app.ts:?` — view + dispatch (+779 lines) — planApprovalRequest state, reviseOpen, reviseDraft, questionOtherOpen, questionOtherDraft state; onApprove/onAcceptWithEdits/onReviseSubmit/onAnswerOption handlers
- `ui/src/ui/app-tool-stream.ts:?` — PlanApprovalRequest type definition (+369 lines)
- `ui/src/ui/app-view-state.ts:?` — view state holders (+74 lines)
- `ui/src/ui/app-render.ts:?` — app-render integration
- `ui/src/ui/app-render.helpers.ts` — helpers
- `ui/src/ui/app-chat.ts` — chat integration
- `ui/src/ui/types.ts:?` — type additions (+72 lines)
- `ui/src/ui/chat/grouped-render.ts` — plan card grouping
- `ui/src/ui/chat/slash-command-executor.ts:1-1319` — /plan command dispatch with full executor + state machine
- `ui/src/ui/chat/slash-commands.ts:1-577` — slash command catalog includes /plan with subcommand spec
- `ui/src/i18n/locales/en.ts` + 12 other locale files — i18n strings (mode-switcher, plan-cards, plan-approval-inline copy)
- `ui/src/i18n/.i18n/*.meta.json` (12 locales) — i18n meta
- `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift` — Swift gateway models updated
- `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift` — macOS gateway models updated
- `apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json` — tool-display.json updated

**Tests:**
- `ui/src/ui/chat/mode-switcher.test.ts:1-388` (~30 tests) — dropdown rendering, mode dispatch, plan + plan-auto chip, planMode states
- `ui/src/ui/chat/plan-cards.test.ts:1-159` (~15 tests) — renderPlanCard, formatPlanAsMarkdown, status marker rendering
- `ui/src/ui/chat/plan-resume.node.test.ts:1-26` (3 tests)
- `ui/src/ui/views/plan-approval-inline.test.ts:1-295` (~25 tests) — Accept/Edit/Revise dispatch, reviseOpen state, question variant, Other... textarea, missing-handler warning
- `ui/src/ui/views/chat.test.ts:1-388` (~30 tests) — chat view with planApprovalRequest hiding input bar
- `ui/src/ui/chat/slash-command-executor.node.test.ts:1-160` (new) — slash command executor
- `ui/src/ui/chat/grouped-render.test.ts:1-106` (new)

**Hooks called in host:** (UI calls back to sessions.patch RPC)
- `app.ts` → `sessions.patch { planMode: "plan"|"normal"|null }` (mode toggle)
- `app.ts` → `sessions.patch { planApproval: { action: "approve"|"edit"|"reject"|"answer"|"auto", ... } }` (resolution actions)

**Public types added:**
- `ui/src/ui/chat/plan-cards.ts:10-21` — `PlanCardData`, `PlanCardStep`
- `ui/src/ui/views/plan-approval-inline.ts:18-51` — `InlinePlanApprovalProps`
- `ui/src/ui/chat/mode-switcher.ts:20-48` — `ModeDefinition`
- `ui/src/ui/app-tool-stream.ts` — `PlanApprovalRequest` (consumer-facing)

**Config flags:** N/A — UI reads `planMode` and `pendingInteraction` from session subscription stream

**Persistence schema:** N/A — UI is read-only on session state

**Known race conditions handled:**
- **Question handler missing wiring** — UI renders disabled buttons + warning when `onAnswerOption` not passed
- **PR-13 Bug 2: "Other..." inline textarea** — caller-owned state (questionOtherOpen, questionOtherDraft) so Escape returns to options rather than dismissing card
- **Connection lost** — actionsDisabled when !connected; visible "Reconnect to resolve" error

---

### F10. Exec allowlist

(block newline separators + dangerous flags + env)

**Files:**
- `src/agents/plan-mode/mutation-gate.ts:114-138` — `READ_ONLY_EXEC_PREFIXES` (ls/cat/pwd/git status/git log/git diff/git show/which/find/grep/rg/head/tail/wc/file/stat/du/df/echo/printenv/whoami/hostname/uname)
- `src/agents/plan-mode/mutation-gate.ts:176-183` — shell compound operator regex `/[;|&`\n\r]|\$\(|>>?|<\(|>\(/` — rejects `;`, `|`, `&`, backtick, newline, `\r`, `$()`, `>` redirect, `<()`, `>()`
- `src/agents/plan-mode/mutation-gate.ts:194-215` — DANGEROUS_FLAGS list (-delete, -exec, -execdir, --delete, -rf, --output, -fprint, -fprint0, -fprintf, -fls) with word-boundary regex `new RegExp(\`(?:^|[\\s])${escaped}(?:[\\s=]|$)\`, "i")`
- `src/agents/plan-mode/mutation-gate.ts:166-167` — `PLAN_MODE_ALLOWED_TOOLS` exact-match check (case-insensitive normalize)
- `src/agents/plan-mode/mutation-gate.ts:172-222` — exec/bash branch: `cmd.trim().toLowerCase()`; shell compound op check first, then dangerous flag check, then prefix match
- `src/agents/plan-mode/mutation-gate.ts:225-244` — exact blocklist + suffix patterns
- `src/agents/plan-mode/mutation-gate.ts:247-252` — read-only suffix patterns allow MCP `.read`/`.search`/`.list`/`.get`/`.view`
- `src/agents/plan-mode/mutation-gate.ts:254-261` — default-deny for unknown tools when in plan mode
- `src/agents/pi-tools.before-tool-call.ts:309-323` — invocation site for mutation gate
- `src/agents/plan-mode/accept-edits-gate.ts:1-565` — post-approval acceptEdits constraint gate; see F12

**Tests:**
- `src/agents/plan-mode/mutation-gate.test.ts:1-202` (34 tests) — exhaustive coverage of exec prefix allowlist, shell operator rejection, dangerous flag rejection, exec-with-flag combinations (e.g. `find . -fprint /tmp/out.txt`), exec-on-blocked-prefix, MCP suffix passthrough, default-deny

**Hooks called in host:** see F2.

**Public types added:** see F2.

**Config flags:**
- Implicit via `agents.defaults.planMode.enabled` — allowlist only fires in plan mode

**Persistence schema:** N/A

**Known race conditions handled:** N/A (pure stateless gate)

---

### F11. Approval grant ledger / approvalRunId / approvalId correlation (C7)

**Files:**
- `src/agents/plan-mode/types.ts:69-77` — `PlanModeSessionState.approvalId?: string`
- `src/agents/plan-mode/types.ts:78-95` — `PlanModeSessionState.approvalRunId?: string`, `lastPlanPayloadHash?: string`, `title?: string`
- `src/agents/plan-mode/types.ts:114-146` — `newPlanApprovalId()`: prefers `globalThis.crypto.randomUUID()` (~122 bits entropy); falls back to `node:crypto.randomUUID()`; THROWS rather than emit weak token; format `plan-${uuid}`
- `src/agents/plan-mode/approval.ts:62-66` — stale-approvalId guard: if `expectedApprovalId` provided and `current.approvalId === undefined || expectedApprovalId !== current.approvalId` → return current (no-op)
- `src/agents/plan-mode/plan-mode-debug-log.ts:48-152` — full `PlanModeDebugEvent` union with `approvalRunId` + `approvalId` correlation fields on relevant events (state_transition, gate_decision, synthetic_injection, nudge_event, subagent_event, approval_event, toast_event, approval_transition)
- `src/agents/plan-mode/plan-mode-debug-log.ts:234-247` — `logPlanModeDebug(event)` emits `[plan-mode/<kind>]` at info level
- `src/agents/plan-mode/plan-mode-debug-log.ts:260-287` — `logPlanModeApprovalTransition(sessionKey, prev, next, trigger)` — emits approval_transition events; skips emission when neither approval nor approvalId changed
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:1848-1886` — approvalId minting at exit_plan_mode; persistPlanApprovalRequest reuse-or-rotate logic; sets `approvalRunId = runId` via persistApprovalMetadata
- `src/gateway/plan-snapshot-persister.ts:299-369` — `persistApprovalMetadata({sessionKey, title, approvalRunId, approvalId?})` — defensive empty-string throw; persists planMode.title + approvalRunId + approvalId; sets pendingInteraction
- `src/gateway/sessions-patch.ts:851-925` — subagent gate combining parentCtx (`getAgentRunContext(approvalRunId)`) + persistedOpenIds (`next.planMode.blockingSubagentRunIds`) + `lastSubagentSettledAt` + grace window; emits PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS or PLAN_APPROVAL_WAITING_FOR_SUBAGENT_SETTLE or PLAN_APPROVAL_GATE_STATE_UNAVAILABLE; logs `gate decision: action=...` via planApprovalGateLog (always-on)
- `src/gateway/sessions-patch.ts:881-895` — approval_event debug event emit with approvalRunId + approvalId
- `src/gateway/sessions-patch.ts:1023-1041` — debug log emit with approvalRunId + approvalId for synthetic_injection
- `src/gateway/sessions-patch.ts:919-927` — debug logs for gate decision branches (gate state source: persisted-ok, gate disabled)
- `src/infra/agent-events.ts:411-509` — addOpenSubagent + removeOpenSubagent — populates ctx.openSubagentRunIds AND persists blockingSubagentRunIds via persistPlanModeSubagentGateState; sets lastSubagentSettledAt on settle
- `src/agents/tools/exit-plan-mode-tool.ts:256-329` — tool-side subagent gate: reads ctx.openSubagentRunIds via `getAgentRunContext(runId)`; emits `agents/exit-plan-gate` always-on log; gate decision string `"blocked"|"allowed (no subagents in flight)"|"deferred to gateway gate (tool-side ctx unavailable)"`
- `src/agents/tools/exit-plan-mode-tool.ts:284-288` — bypassReason explanations (no runId / ctx not registered / openSubagentRunIds undefined / openSubagentRunIds empty)
- `src/agents/tools/plan-mode-status-tool.ts:117-152` — surfaces openSubagentRunIds, approvalRunId, approvalId in introspection result
- `src/agents/subagent-announce.ts` — modified for approvalRunId propagation
- `src/agents/subagent-registry-run-manager.ts` — modified
- `src/agents/subagent-registry.steer-restart.test.ts` — modified
- `src/agents/subagent-registry.test.ts` — modified
- `src/agents/tools/sessions-spawn-tool.ts` — modified to wire `runId` for openSubagentRunIds tracking; sets `cleanup:"keep"` override when `inPlanMode === true`
- `src/commands/sessions.ts`, `src/commands/status.summary.ts` — modified to surface plan-mode state in sessions/status output
- `src/gateway/server-runtime-handles.ts` — modified for handle exposure

**Tests:**
- `src/agents/plan-mode/plan-mode-debug-log.test.ts:1-378` (22 tests) — env-var path, config-flag path, 30s TTL cache, level "info", every event kind, logPlanModeApprovalTransition skip-when-unchanged
- `src/gateway/sessions-patch.subagent-gate.test.ts:1-404` (19 tests) — gate combination matrix, PLAN_APPROVAL_GATE_STATE_UNAVAILABLE, PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS, PLAN_APPROVAL_WAITING_FOR_SUBAGENT_SETTLE
- `src/agents/plan-mode/approval.test.ts:1-349` (47 tests) — stale-approvalId guard (both-undefined, mismatch); newPlanApprovalId format
- `src/agents/plan-mode/integration.test.ts:1-238` — end-to-end correlation
- `src/agents/tools/exit-plan-mode-tool.test.ts` — gate decision logging, bypass case strings
- `src/agents/tools/sessions-spawn-tool.test.ts` — modified for plan-mode openSubagent tracking
- `src/agents/subagent-registry.test.ts` — modified

**Hooks called in host:**
- `pi-embedded-subscribe.handlers.tools.ts:1881` — uses `persistResult.approvalId` (what disk says, not candidate)
- `sessions-patch.ts:853` — `getAgentRunContext(approvalRunId)` lookup for subagent-gate combined state
- `infra/agent-events.ts:411` — `addOpenSubagent` writes ctx.openSubagentRunIds + persists blockingSubagentRunIds
- `infra/agent-events.ts:497` — `removeOpenSubagent` clears + sets lastSubagentSettledAt
- `tools/exit-plan-mode-tool.ts:256` — `getAgentRunContext(runId)` for tool-side gate decision

**Public types added:**
- `src/agents/plan-mode/plan-mode-debug-log.ts:63-152` — PlanModeDebugEvent (discriminated union)
- `src/gateway/plan-snapshot-persister.ts:33-41` — `persistPlanModeSubagentGateState` parameter type

**Config flags:**
- `agents.defaults.planMode.debug: boolean` — turns on debug log
- `OPENCLAW_DEBUG_PLAN_MODE=1` env var — equivalent

**Persistence schema:**
- `SessionEntry.planMode.approvalId?: string`
- `SessionEntry.planMode.approvalRunId?: string`
- `SessionEntry.planMode.blockingSubagentRunIds?: string[]`
- `SessionEntry.planMode.lastSubagentSettledAt?: number`
- `SessionEntry.planMode.lastPlanPayloadHash?: string`
- `SessionEntry.planMode.cycleId?: string` — fresh-enter token
- `SessionEntry.recentlyApprovedCycleId?: string` — paired with `recentlyApprovedAt` for cycle correlation

**Known race conditions handled:**
- **approvalRunId silent-bypass guard** (C4) — see F12; persistApprovalMetadata throws on empty string
- **iter-1 D2 phase typo** — `phase === "request"` vs `"requested"` — persister accepts both for robustness
- **half-formed planMode on enter** — fresh-entry MUST init cycleId + blockingSubagentRunIds so isModernPlanCycleState + hasPersistedGateState predicates work
- **Subagent gate state unavailable** — sessions-patch.ts:867-877 returns PLAN_APPROVAL_GATE_STATE_UNAVAILABLE rather than fail-open when modern cycle exists but neither parentCtx nor persisted state
- **getAgentRunContext returns undefined after cleanup** — fallback to persisted blockingSubagentRunIds

---

### F12. Shell-escape layered defense + approvalRunId silent-bypass guard (C4)

**Files:**
- `src/agents/plan-mode/accept-edits-gate.ts:1-565` — full file: `checkAcceptEditsConstraint`; fail-OPEN posture (only blocks explicit matches in 3 constraint categories)
- `src/agents/plan-mode/accept-edits-gate.ts:88-98` — `DESTRUCTIVE_EXEC_PREFIXES` (rm/rmdir/unlink/shred/trash/truncate/diskutil erasedisk/diskutil eraseall)
- `src/agents/plan-mode/accept-edits-gate.ts:106-115` — `DESTRUCTIVE_SQL_PATTERNS` (DROP TABLE/DATABASE/SCHEMA, DELETE FROM, TRUNCATE TABLE, FLUSHALL/FLUSHDB)
- `src/agents/plan-mode/accept-edits-gate.ts:123-127` — `DESTRUCTIVE_FIND_FLAGS` (-delete, -exec rm/rmdir/unlink/shred/truncate, -execdir rm/...)
- `src/agents/plan-mode/accept-edits-gate.ts:131-192` — **C4 SHELL-ESCAPE PATTERNS** — `DESTRUCTIVE_ESCAPE_PATTERNS` defensive layer:
  - env-var indirection `\$\{?(?:rm|rmdir|unlink|shred|trash|truncate)\b`
  - backtick subshell `\`[^\`]*\\b(?:VERBS)\\b[^\`]*\``
  - `$()` subshell `\\$\\([^)]*\\b(?:VERBS)\\b[^)]*\\)`
  - quote concatenation `["'][a-z]["']["'][a-z]["']/i` (catches `"r""m"`)
  - hex escapes `\\x[0-9a-f]{2}` (catches `\x72m`)
  - octal escapes `\\[0-7]{3}` (catches `\162m`)
- `src/agents/plan-mode/accept-edits-gate.ts:198-218` — `SELF_RESTART_PATTERNS`:
  - openclaw gateway restart/stop/kill
  - launchctl kickstart/unload/stop on ai.openclaw.*
  - systemctl restart/stop/kill openclaw*
  - pkill openclaw, killall openclaw
  - kill -9 with openclaw/gateway
  - pgrep openclaw piped (catches pgrep | xargs kill)
  - kill `$(pgrep openclaw)` or backtick variant
  - scripts/restart-mac.sh
- `src/agents/plan-mode/accept-edits-gate.ts:222-228` — `CONFIG_CHANGE_PATTERNS` (openclaw config set/delete/unset, openclaw doctor --fix)
- `src/agents/plan-mode/accept-edits-gate.ts:242-248` — `PROTECTED_CONFIG_PATH_PREFIXES` (~/.openclaw/, ~/.claude/, ~/.config/openclaw/, /etc/openclaw/, /usr/local/etc/openclaw/)
- `src/agents/plan-mode/accept-edits-gate.ts:254` — `PATH_WRITER_TOOLS` (write, edit, apply_patch, create, delete)
- `src/agents/plan-mode/accept-edits-gate.ts:357-402` — `normalizeCandidatePath` (collapse .. / ., handle both ~ and $HOME forms)
- `src/agents/plan-mode/accept-edits-gate.ts:404-428` — `checkProtectedPath` (matches against both forms)
- `src/agents/plan-mode/accept-edits-gate.ts:455-506` — `checkAcceptEditsConstraint` — checks destructive (prefix + SQL + find-flags + escape patterns), self-restart, config-change, protected-path (singular + additionalPaths)
- `src/agents/plan-mode/accept-edits-gate.ts:521-553` — `extractApplyPatchTargetPaths` — parses Update/Add/Delete File: `<path>` + Move to: `<dst>` envelope headers
- `src/agents/plan-mode/accept-edits-gate.ts:556-564` — `__testing` exposed constants for tests
- `src/agents/pi-tools.before-tool-call.ts:324-373` — invocation site: only fires when liveMode==="normal" AND `getLatestAcceptEdits()===true`; extracts execCommand/filePath/additionalPaths
- `src/agents/pi-tools.before-tool-call.ts:354-359` — apply_patch additionalPaths extraction via extractApplyPatchTargetPaths
- `src/agents/plan-mode/approval.ts:196-221` — `buildAcceptEditsPlanInjection(planSteps)` — prompt-layer teaches the agent the three constraints
- `src/gateway/sessions-patch.ts:983-988` — postApprovalPermissions grant on `edit` action with approvalId scope
- `src/gateway/plan-snapshot-persister.ts:316-322` — **approvalRunId silent-bypass defensive guard** — throws if empty: "approvalRunId is required (got: ...). Without it the approval-side subagent gate cannot look up parent-run state, silently bypassing the concurrency check."
- `src/gateway/plan-snapshot-persister.ts:710-716` — postApprovalPermissions cleared on close-on-complete
- `src/gateway/sessions-patch.ts:627-634` — postApprovalPermissions cleared on every new plan-mode cycle
- `src/agents/plan-mode/plan-archetype-persist.ts:118-150` — symlink protection at agent + plans dir
- `src/agents/plan-mode/plan-archetype-persist.ts:85-92` — agentId path-traversal reject (path separators, control chars, dots-only)
- `src/agents/context-file-injection-scan.ts:1-?` — new file (context-file injection scanner)
- `src/agents/context-file-injection-scan.test.ts:1-?` — new tests
- `qa/scenarios/gpt54-injection-scan.md` — QA scenario

**Tests:**
- `src/agents/plan-mode/accept-edits-gate.test.ts:1-629` (86 tests) — full matrix:
  - destructive prefix matching (rm/rmdir/etc)
  - SQL pattern detection (DROP/DELETE/TRUNCATE/FLUSH*)
  - find-flag detection (-delete/-exec rm/-execdir rm)
  - **escape-pattern detection** (env-var indirection `$RM`, `${RM}`, backtick subshell `` `echo rm` ``, `$()` subshell, quote concatenation `"r""m"`, hex escape `\x72m`, octal `\162m`)
  - self-restart patterns (openclaw/launchctl/systemctl/pkill/killall/kill)
  - config-change patterns
  - protected-config path prefix (both ~/.openclaw/ and $HOME/.openclaw/ forms)
  - normalizeCandidatePath collapse `..` segments
  - apply_patch extractApplyPatchTargetPaths (Update/Add/Delete/Move to: parsing)
  - additionalPaths handling
- `src/agents/context-file-injection-scan.test.ts:1-?` — context-file injection tests
- `src/gateway/plan-snapshot-persister.test.ts` — exports `__testingPlanSnapshotPersister.persistApprovalMetadata` for direct testing of the empty-approvalRunId throw guard

**Hooks called in host:**
- `pi-tools.before-tool-call.ts:360` — `checkAcceptEditsConstraint({toolName, execCommand, filePath, additionalPaths})`
- `pi-tools.before-tool-call.ts:355` — `extractApplyPatchTargetPaths(params.input)` for apply_patch hooks
- `plan-snapshot-persister.ts:316` — approvalRunId silent-bypass throw guard at persist boundary
- `sessions-patch.ts:983` — postApprovalPermissions grant on edit action

**Public types added:**
- `src/agents/plan-mode/accept-edits-gate.ts:49-69` — `AcceptEditsGateParams`
- `src/agents/plan-mode/accept-edits-gate.ts:71-75` — `AcceptEditsGateResult`

**Config flags:** indirect via `agents.defaults.planMode.enabled` + `postApprovalPermissions.acceptEdits` runtime grant

**Persistence schema:**
- `SessionEntry.postApprovalPermissions = {acceptEdits, grantedAt, approvalId}` (`src/config/sessions/types.ts:96-100`)
- Permission scoped by approvalId — invalidated by new cycle that regenerates approvalId

**Known race conditions handled:**
- **approvalRunId silent-bypass** (C4) — empty-string throw at persistApprovalMetadata boundary makes the bug LOUD instead of silent
- **apply_patch multi-path bypass** (Codex P2 #68939) — additionalPaths channel + Move to: parsing covers patch destination
- **Symlink confusion at persist destination** — lstat-based symlink rejection at agent + plans dir; realpath-based containment check
- **Quote-concat / env-var / subshell / byte-escape bypass** — DESTRUCTIVE_ESCAPE_PATTERNS catches sophisticated bypass vectors that resolve at shell runtime

---

## Summary table

| F# | Feature | # Files (impl + test) | # LOC (impl) | # Tests (count) | # Hook integration points |
|----|---|---|---|---|---|
| F1 | enter_plan_mode / exit_plan_mode tools | 14 | ~1450 | ~65 (4 files: 20+25+19+~15 incl) | 6 |
| F2 | Mutation gate | 6 | ~340 | 34 + part of integration | 3 (before-tool-call ctx wiring + gate call + acceptEdits) |
| F3 | Plan-approval-request persistence (+race fix) | 21 | ~3800 | ~145 (47+19+35+~25+ many more) | 8 (subscriber + close + reload + chat + sessions + intercepts) |
| F4 | planMode runtime context propagation | 15 | ~1100 | ~50 (incomplete-turn + runtime + helpers) | 6 (run.ts, attempt.ts, runtime-ctx, before-tool, agent-events, runner-execution) |
| F5 | Plan archetype + ask_user_question + auto mode | 27 | ~3500 | ~110 (16+15+12+19+18+19+30+~15+others) | 8 (auto-enable in cron, schedulePlanNudges, autoApproveIfEnabled, dispatchPlanArchetypeAttachment, answer branch, two persister branches, skill-planner) |
| F6 | Plan title + turn limit (32→500 floor) | 9 | ~600 | ~30 (parity test + update-plan + exit-plan tests) | 3 (title required throw, persist title, max-iterations config) |
| F7 | Auto-continue + escalating retry | 11 | ~1700 | ~50 (incomplete-turn + heartbeat + runtime-prompt + others) | 5 (auto-continue cycle, escalating-retry resolver, heartbeat suppress, runtime-context emit, getLatestPlanMode read) |
| F8 | Rejection UX with feedback + cycle tracking | 12 | ~1700 | ~125 (47+43+~30+25+others) | 4 (resolvePlanApproval, appendToInjectionQueue, readLatestSessionEntryFresh, UI revise textarea) |
| F9 | Mode-switcher UI + plan cards | ~30 (incl i18n) | ~3500 | ~100 (388+159+~25+295+160+106+others) | UI-only — calls sessions.patch RPC |
| F10 | Exec allowlist | 1 | ~140 | 34 (subset of mutation-gate.test) | 1 (mutation gate exec branch) |
| F11 | Approval grant ledger / approvalRunId / approvalId correlation (C7) | 18 | ~1500 | ~60 (22+19+47+others) | 5 (persistApprovalMetadata, getAgentRunContext, subagent-gate combine, tool-side gate, debug-log threading) |
| F12 | Shell-escape layered defense + approvalRunId silent-bypass guard (C4) | 5 | ~700 | 86 + small subset of plan-snapshot test | 4 (accept-edits-gate, extractApplyPatchTargetPaths, persistApprovalMetadata-throw, context-file-injection-scan) |

**Aggregated totals:**
- ~232 files touched total in diff
- ~85 plan-mode-relevant files (impl + test + UI + docs)
- ~43,145 insertions (whole-diff); ~25,000+ insertions are plan-mode-relevant
- ~875 tests across plan-mode test files (estimated; major test files: 86 + 47 + 35 + 34 + 19 + 25 + 22 + 19 + 15 + 12 + 18 + 8 + 20 + 16 + 73 + 34 + 4 + 19 + ~50 + 43 + ~30 + ~25 + ~25 + ~30 + ~25 + 30 + 3 + ~30)

---

## Must-Have gate-list

**Every feature is MANDATORY. The plugin SHIPS with all 12 or it doesn't ship. Zero divergence acceptable.**

- [ ] **F1. enter_plan_mode / exit_plan_mode tools** — both tools registered behind `agents.defaults.planMode.enabled === true`. exit_plan_mode requires `title` (≤80 chars); plan array required (≥1 step); supports analysis/assumptions/risks/verification/references archetype fields. enter_plan_mode is a transition signal; intercept in `pi-embedded-subscribe.handlers.tools.ts` persists state via `persistPlanModeEnter`.
- [ ] **F2. Mutation gate** — `checkMutationGate(toolName, currentMode, execCommand)` blocks Edit/Write/Bash/NotebookEdit etc when planMode==="plan". Allowlist includes plan-mode-safe tools (ask_user_question, plan_mode_status, sessions_spawn, sessions_yield, sessions_list, sessions_history, lcm_grep, lcm_expand_query, etc). Read-only exec prefixes allowed; shell compound operators + dangerous flags + newlines + redirects + subshells rejected. Default-deny on unknown tools. Wired via `getLatestPlanMode` for live disk-read.
- [ ] **F3. Plan-approval-request persistence (sessions.patch + race fix)** — `persistPlanApprovalRequest` writes `lastPlanSteps + title + approvalId + lastPlanPayloadHash` synchronously inside one `updateSessionStoreEntry` callback. Idempotency guard on payloadHash + pending + valid approvalId reuses approvalId. `applySessionsPatchToStore` handles planMode/planApproval branches (approve/edit/reject/answer/auto) with subagent-gate combination of parentCtx + persistedOpenIds. Plan-snapshot-persister listens to "approval" + "plan" streams with closeOnComplete + pre-flight + locked re-evaluation.
- [ ] **F4. planMode runtime context propagation** — `params.planMode` threaded through run.ts → attempt.ts → prompt-build. AgentRunContext carries `openSubagentRunIds`, `inPlanMode`, `recentlyApprovedAt`, `lastSubagentSettledAt`, `getLatestPlanMode` accessor. PLAN_ARCHETYPE_PROMPT + PLAN_MODE_REFERENCE_CARD appended on every plan-mode attempt. plan-hydration injects active plan steps after compaction.
- [ ] **F5. Plan archetype + ask_user_question + auto mode (PR-10)** — PLAN_ARCHETYPE_PROMPT (~120 lines decision-complete standard) + plan-archetype-bridge + plan-archetype-persist + ask_user_question tool + autoApprove flag + schedulePlanNudges (10/30/60 min one-shot crons) + auto-enable at session start via evaluateAutoEnableForMatch. Plan-mode-101 SKILL companion artifact.
- [ ] **F6. Plan title + turn limit (32→500 floor + configurable) (PR-9)** — title required + ≤80 char truncate at exit_plan_mode; `maxIterations` config field [1, 100_000] replaces auth-count-scaled default with 500 floor; PLAN_STEP_STATUSES + PlanStepStatus exported as single source of truth; update-plan parity tests; closure-gate fields (acceptanceCriteria/verifiedCriteria) per step.
- [ ] **F7. Auto-continue + escalating retry (GPT-5.4 planning parity)** — autoContinue config + planMode-aware retry instructions: PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION (+FIRM), PLAN_APPROVED_YIELD_RETRY_INSTRUCTION (+FIRM), PLANNING_ONLY_RETRY_INSTRUCTION (+FIRM+FINAL), ACK_EXECUTION_FAST_PATH, AUTO_CONTINUE_FAST_PATH, STRICT_AGENTIC_BLOCKED_TEXT. resolvePlanModeAckOnlyRetryInstruction + resolveYieldDuringApprovedPlanInstruction read recentlyApprovedAt + planMode.approval. heartbeat-runner buildActivePlanNudge suppresses when approval pending or planMode.updatedAt recent. plan-nudge cron family ([PLAN_NUDGE]: prefix).
- [ ] **F8. Rejection UX with feedback + cycle tracking (PR-11; max cycles configurable)** — `/plan revise <feedback>` parses (empty feedback rejected at parse time); reject variant requires feedback (1-8192 chars) at schema layer; resolvePlanApproval increments rejectionCount; ≥3 cycles triggers "Multiple revisions have been rejected" suggestion; sanitizeFeedbackForInjection defends envelope escape; UI inline revise textarea with Cmd+Enter / Escape. readLatestSessionEntryFresh disk-read for accept/revise. Universal `/plan accept|revise|status|view|on|off|auto|restate|answer` slash commands across Telegram/Discord/Slack/CLI.
- [ ] **F9. Mode-switcher UI + plan cards (split sidebar OR popup-during-exec)** — pill/chip dropdown in chat input toolbar; renderInlinePlanApproval card above input bar (Accept/Accept allow edits/Revise + Open plan link + revise textarea); question variant with N option buttons + Other... inline textarea; renderPlanCard with <details>/<summary>; formatPlanAsMarkdown; STATUS_MARKERS; PR-13 Bug 2 fix for question Other... cancel returning to options.
- [ ] **F10. Exec allowlist (block newline separators + dangerous flags + env)** — READ_ONLY_EXEC_PREFIXES list; shell compound op regex `/[;|&`\n\r]|\$\(|>>?|<\(|>\(/`; DANGEROUS_FLAGS list with word-boundary regex; default-deny on unknown tools when in plan mode.
- [ ] **F11. Approval grant ledger / approvalRunId / approvalId correlation (C7)** — newPlanApprovalId UUID-based (crypto.randomUUID prefix); resolvePlanApproval stale-approvalId guard (both-defined + both-undefined detection); approvalRunId persisted on planMode for cross-event correlation; PlanModeDebugEvent discriminated union with approvalRunId + approvalId on relevant events; tool-side `agents/exit-plan-gate` always-on log; gateway-side `gateway/plan-approval-gate` always-on log; subagent-gate combines parentCtx + persistedOpenIds + lastSubagentSettledAt + grace window; PLAN_APPROVAL_GATE_STATE_UNAVAILABLE error when neither source available; sessions_spawn registers ctx.openSubagentRunIds via runId hookup. plan_mode_status tool exposes openSubagentCount + approvalRunId + approvalId.
- [ ] **F12. Shell-escape layered defense + approvalRunId silent-bypass guard (C4)** — DESTRUCTIVE_ESCAPE_PATTERNS (env-var indirection, backtick subshell, $() subshell, quote concatenation, hex+octal byte escapes); SELF_RESTART_PATTERNS (openclaw/launchctl/systemctl/pkill/killall/kill + pipe-chained); PROTECTED_CONFIG_PATH_PREFIXES (~/.openclaw/, ~/.claude/, etc); normalizeCandidatePath for both ~ and $HOME forms; apply_patch additionalPaths channel + extractApplyPatchTargetPaths; persistApprovalMetadata empty-approvalRunId THROW guard (loud failure not silent); symlink protection at plan-archetype-persist; postApprovalPermissions scoped by approvalId + cleared on cycle + close-on-complete.

---

## Race-fix commit anchor

The empty-plan-body race fix at commit `1081067476` is the most load-bearing element of F3:

```text
fix(plan-mode): persist lastPlanSteps + title synchronously to eliminate empty-plan-body race
src/agents/pi-embedded-subscribe.handlers.tools.ts::persistPlanApprovalRequest
```

Pre-fix sequence:
1. exit_plan_mode tool returns
2. runtime emits agent_approval_event (sync broadcast to UI)
3. plan-snapshot-persister (async event-bus subscriber) writes lastPlanSteps later
4. user clicks Approve fast
5. sessions-patch.ts:977 reads `next.planMode.lastPlanSteps` → empty array
6. `buildApprovedPlanInjection([])` → empty plan body in `[PLAN_DECISION]: approved`
7. agent has no concrete steps to execute

Post-fix: `persistPlanApprovalRequest` writes `approvalId + lastPlanSteps + title + lastPlanPayloadHash` in the SAME synchronous `updateSessionStoreEntry` callback BEFORE the event broadcasts. The user's Approve click can't beat the disk.

---

## Appendix A — Test enumeration (per-test descriptions)

### A.1 — `src/agents/plan-mode/mutation-gate.test.ts` (34 tests)

- `mutation-gate.test.ts:6` — allows all tools in normal mode
- `mutation-gate.test.ts:41` — blocks case-insensitively
- `mutation-gate.test.ts:73` — blocks tools ending with .write
- `mutation-gate.test.ts:77` — blocks tools ending with .edit
- `mutation-gate.test.ts:81` — blocks tools ending with .delete
- `mutation-gate.test.ts:85` — allows tools with non-mutation suffixes
- `mutation-gate.test.ts:134` — blocks exec without a command argument
- `mutation-gate.test.ts:139` — blocks commands with newline separators
- `mutation-gate.test.ts:144` — blocks dangerous flags on otherwise-allowed commands
- `mutation-gate.test.ts:149` — blocks bash alias the same way as exec
- `mutation-gate.test.ts:156` — blocks bash in plan mode when no command is given
- `mutation-gate.test.ts:164` — blocks redirect operator: echo hi > file
- `mutation-gate.test.ts:168` — blocks pipe operator: cat file | grep x
- `mutation-gate.test.ts:172` — blocks semicolon chaining: ls; rm -rf /
- `mutation-gate.test.ts:178` — blocks newline-separated commands: ls\nrm -rf tmp
- `mutation-gate.test.ts:184` — blocks find . -delete
- `mutation-gate.test.ts:188` — blocks find . -exec rm {} ;
- `mutation-gate.test.ts:194` — allows find . -executable (not a match for -exec)
- `mutation-gate.test.ts:198` — allows grep -rfl pattern (not a match for -rf)
- Plus cases for the allowlist (read/web_search/web_fetch/memory_search/memory_get/update_plan/exit_plan_mode/session_status/ask_user_question/enter_plan_mode/sessions_spawn/plan_mode_status/sessions_list/sessions_history/sessions_yield/lcm_grep/lcm_expand_query), exec prefix matches, default-deny, MCP `.read`/`.search`/`.list`/`.get`/`.view` suffix bypass

### A.2 — `src/agents/plan-mode/approval.test.ts` (47 tests)

- `approval.test.ts:19` — approve transitions to normal mode with approved state
- `approval.test.ts:27` — edit transitions to normal mode (user edits count as approval)
- `approval.test.ts:34` — reject stays in plan mode and increments rejectionCount
- `approval.test.ts:42` — accumulates rejectionCount across multiple rejections
- `approval.test.ts:52` — timeout stays in plan mode with timed_out state
- `approval.test.ts:58` — ignores stale timeout after approval is already resolved
- `approval.test.ts:69` — preserves enteredAt across all transitions
- `approval.test.ts:76` — clears feedback on approval
- `approval.test.ts:87` — allows transitions from rejected state (user changes mind)
- `approval.test.ts:98` — ignores actions on terminal states (approved, edited, timed_out)
- `approval.test.ts:110` — builds a numbered plan injection
- `approval.test.ts:117` — includes instruction to mark cancelled if blocked
- `approval.test.ts:126` — buildApprovedPlanInjection is byte-identical across invocations for the same input
- `approval.test.ts:136` — pins the canonical prefix and numbering
- `approval.test.ts:150` — buildAcceptEditsPlanInjection is byte-identical across invocations for the same input
- `approval.test.ts:157` — carries the canonical [PLAN_DECISION]: edited tag
- `approval.test.ts:162` — teaches the >=95% confidence rule
- `approval.test.ts:168` — teaches all three hard constraints
- `approval.test.ts:177` — includes the approved plan at the tail
- `approval.test.ts:191` — builds rejection injection with feedback (one-line opener)
- `approval.test.ts:204` — adds clarification hint after 3+ rejections
- `approval.test.ts:209` — does not add hint before 3 rejections
- `approval.test.ts:214` — builds expired injection (one-line opener)
- `approval.test.ts:221` — builds timed_out injection (canonical state name)
- `approval.test.ts:226` — neutralizes adversarial feedback that contains the closing marker
- `approval.test.ts:241` — neutralizes case-insensitive marker variants in feedback
- `approval.test.ts:248` — newPlanApprovalId returns a `plan-`-prefixed string
- `approval.test.ts:253` — returns 1024 distinct values across rapid back-to-back calls
- `approval.test.ts:272` — approve with matching approvalId proceeds
- `approval.test.ts:277` — approve with mismatched approvalId is no-op (stale event)
- `approval.test.ts:282` — reject with mismatched approvalId is no-op
- `approval.test.ts:288` — approve with no expectedApprovalId skips stale guard (backwards compat)
- `approval.test.ts:300` — approve resets rejectionCount to 0
- `approval.test.ts:305` — edit resets rejectionCount to 0
- `approval.test.ts:310` — reject does NOT reset (continues counting)
- `approval.test.ts:315` — timeout does NOT reset (separate concern)
- `approval.test.ts:333` — approve with expectedApprovalId is no-op when current has no approvalId (fail-closed)
- `approval.test.ts:339` — reject with expectedApprovalId is no-op when current has no approvalId
- `approval.test.ts:345` — edit with expectedApprovalId is no-op when current has no approvalId
- Plus 8 more tests covering state transitions, no-op safety, and ID-mismatch matrix

### A.3 — `src/agents/plan-mode/accept-edits-gate.test.ts` (86 tests)

- `accept-edits-gate.test.ts:15` — allows an unknown tool with no exec command
- `accept-edits-gate.test.ts:20` — allows exec with a read-only command
- `accept-edits-gate.test.ts:32` — allows exec with general write commands (not destructive)
- `accept-edits-gate.test.ts:46` — allows write/edit tools targeting non-protected paths
- `accept-edits-gate.test.ts:69` — blocks `rm` prefix
- `accept-edits-gate.test.ts:75` — blocks `rm -rf`
- `accept-edits-gate.test.ts:81` — blocks `rmdir`
- `accept-edits-gate.test.ts:87` — blocks `shred`, `trash`, `unlink`, `truncate`
- `accept-edits-gate.test.ts:99` — does NOT false-positive on `rmtool` or other prefix look-alikes
- `accept-edits-gate.test.ts:109` — blocks SQL DROP TABLE in psql / sqlite3 invocation
- `accept-edits-gate.test.ts:118` — blocks SQL DELETE FROM in exec
- `accept-edits-gate.test.ts:126` — blocks TRUNCATE TABLE regardless of surrounding whitespace/case
- `accept-edits-gate.test.ts:134` — blocks Redis FLUSHALL / FLUSHDB
- `accept-edits-gate.test.ts:149` — blocks `find ... -delete`
- `accept-edits-gate.test.ts:157` — blocks `find ... -exec rm`
- `accept-edits-gate.test.ts:165` — blocks destructive actions called via bash tool too
- `accept-edits-gate.test.ts:175` — blocks `openclaw gateway restart|stop|kill`
- `accept-edits-gate.test.ts:186` — blocks `launchctl kickstart` on ai.openclaw.*
- `accept-edits-gate.test.ts:194` — allows `launchctl kickstart` on unrelated services
- `accept-edits-gate.test.ts:202` — blocks `systemctl restart openclaw`
- `accept-edits-gate.test.ts:211` — blocks `pkill openclaw`
- `accept-edits-gate.test.ts:220` — blocks `kill` combined with gateway/openclaw on the same line
- `accept-edits-gate.test.ts:229` — allows `kill` of unrelated processes
- `accept-edits-gate.test.ts:238` — blocks pipe-chained `pgrep openclaw | xargs kill` (wave-1 fix)
- `accept-edits-gate.test.ts:249` — blocks `kill $(pgrep openclaw)` subshell form (wave-1 fix)
- `accept-edits-gate.test.ts:258` — blocks backtick form `kill \`pgrep gateway\`` (wave-1 fix)
- `accept-edits-gate.test.ts:267` — blocks `scripts/restart-mac.sh`
- `accept-edits-gate.test.ts:278` — blocks `openclaw config set`
- `accept-edits-gate.test.ts:287` — blocks `openclaw config delete`
- `accept-edits-gate.test.ts:296` — blocks `openclaw doctor --fix`
- `accept-edits-gate.test.ts:305` — allows `openclaw config get` (read-only)
- `accept-edits-gate.test.ts:314` — allows `openclaw doctor` without --fix
- `accept-edits-gate.test.ts:323` — blocks write/edit to `~/.openclaw/config.toml`
- `accept-edits-gate.test.ts:332` — blocks write/edit to `~/.claude/config`
- `accept-edits-gate.test.ts:341` — blocks write to `~/.config/openclaw/settings.json`
- `accept-edits-gate.test.ts:350` — blocks write to `/etc/openclaw/` system config
- `accept-edits-gate.test.ts:359` — allows write to non-config paths under a similarly-named parent
- `accept-edits-gate.test.ts:369` — blocks absolute $HOME form that expands to `~/.openclaw/` (wave-1 fix)
- `accept-edits-gate.test.ts:383` — blocks `..` traversal that resolves into `~/.openclaw/` (wave-1 fix)
- `accept-edits-gate.test.ts:391` — blocks multi-segment traversal back into `~/.openclaw/` (wave-1 fix)
- `accept-edits-gate.test.ts:401` — skips exec-pattern checks when execCommand is undefined or empty
- `accept-edits-gate.test.ts:409` — skips path checks when filePath is undefined or empty
- `accept-edits-gate.test.ts:416` — normalizes tool name case
- `accept-edits-gate.test.ts:425` — normalizes destructive exec prefix case
- **C4 layered-defense escape patterns:**
- `accept-edits-gate.test.ts:443` — blocks `$RM file`
- `accept-edits-gate.test.ts:449` — blocks `${RM} file` (braced form)
- `accept-edits-gate.test.ts:453` — blocks `$SHRED file`
- `accept-edits-gate.test.ts:457` — blocks `$TRUNCATE -s 0 file`
- `accept-edits-gate.test.ts:461` — is case-insensitive: `$rm file`
- `accept-edits-gate.test.ts:465` — allows unrelated env vars: `$HOME/bin/script.sh`
- `accept-edits-gate.test.ts:471` — blocks `` `echo rm` file ``
- `accept-edits-gate.test.ts:477` — blocks `` `which shred` file ``
- `accept-edits-gate.test.ts:481` — allows backticks without destructive verbs: `` `date` ``
- `accept-edits-gate.test.ts:487` — blocks `$(echo rm) file`
- `accept-edits-gate.test.ts:493` — blocks `$(which rm) file`
- `accept-edits-gate.test.ts:497` — allows $(...) without destructive verbs: `$(date)`
- `accept-edits-gate.test.ts:503` — blocks `"r""m" file`
- `accept-edits-gate.test.ts:508` — blocks single-quote concatenation `'r''m' file`
- `accept-edits-gate.test.ts:514` — blocks hex-encoded: `\x72m file`
- `accept-edits-gate.test.ts:520` — blocks fully hex-encoded: `\x72\x6d file`
- `accept-edits-gate.test.ts:524` — blocks octal-encoded: `\162m file`
- `accept-edits-gate.test.ts:528` — upper-case hex escapes: `\X72m file`
- `accept-edits-gate.test.ts:534` — allows `ls -la $HOME`
- `accept-edits-gate.test.ts:538` — allows `echo $USER is running the build`
- `accept-edits-gate.test.ts:542` — allows `git log --oneline $(git merge-base main HEAD)..HEAD`
- `accept-edits-gate.test.ts:546` — allows `cat /tmp/logs/\`date +%Y-%m-%d\`.log`
- **extractApplyPatchTargetPaths (Codex P2 #68939 fix coverage):**
- `accept-edits-gate.test.ts:560` — extracts destination from `*** Move to:` inside an `*** Update File:` hunk
- `accept-edits-gate.test.ts:575` — catches a Move INTO a protected config path (the security-critical case)
- `accept-edits-gate.test.ts:586` — catches a Move OUT OF a protected config path
- `accept-edits-gate.test.ts:598` — still extracts plain `*** Update File:` / `*** Add File:` / `*** Delete File:` single-path hunks
- `accept-edits-gate.test.ts:608` — handles multiple moves in one patch
- `accept-edits-gate.test.ts:624` — returns empty for non-string / empty input

### A.4 — `src/agents/plan-mode/injections.test.ts` (35 tests)

- `injections.test.ts:62` — returns the queue unchanged when no legacy scalar is present
- `injections.test.ts:70` — promotes a legacy scalar into a plan_decision entry appended to the queue
- `injections.test.ts:84` — treats an empty-string legacy scalar as absent (no migration)
- `injections.test.ts:93` — upsertIntoQueue appends when id is not present
- `injections.test.ts:100` — replaces in place when id already exists (no duplicate)
- `injections.test.ts:108` — does not mutate the input queue
- `injections.test.ts:117` — orders by priority DESC, then createdAt ASC
- `injections.test.ts:128` — honors explicit priority overrides
- `injections.test.ts:137` — caps at MAX_QUEUE_SIZE and warns on eviction
- `injections.test.ts:166` — preserves all entries when queue is under cap
- `injections.test.ts:172` — does not mutate the input queue
- `injections.test.ts:179` — is deterministic when priority AND createdAt tie (wave-1 fix)
- `injections.test.ts:198` — returns the user prompt unchanged when queue is empty
- `injections.test.ts:202` — joins multiple entries with double newlines, then separates from user prompt
- `injections.test.ts:212` — emits injection only when user prompt is empty or whitespace-only
- `injections.test.ts:220` — trims user prompt before composing
- `injections.test.ts:229` — orders plan_decision above every other kind
- `injections.test.ts:242` — orders plan_complete above question_answer
- `injections.test.ts:276` — returns empty result when the queue is undefined (no prior write)
- `injections.test.ts:283` — migrates a legacy scalar to the queue on first consume, then clears both
- `injections.test.ts:299` — enqueues a single entry and composes it on consume (once-and-only-once)
- `injections.test.ts:319` — dedup upsert: same-id second enqueue replaces the first
- `injections.test.ts:338` — concurrent different-kind writes both land (no clobber — the core bug being fixed)
- `injections.test.ts:358` — filters out expired entries at consume time
- `injections.test.ts:378` — returns empty for empty sessionKey without touching the store
- `injections.test.ts:384` — preserves unrelated SessionEntry fields on enqueue and consume
- `injections.test.ts:408` — enqueue returns false (no throw) when session doesn't exist
- `injections.test.ts:419` — enqueue returns false (no throw) when sessionKey is empty
- `injections.test.ts:429` — consume drops captured entries when disk write fails (wave-1 fix)

### A.5 — `src/agents/plan-mode/auto-enable.test.ts` (19 tests)

- `auto-enable.test.ts:13` — returns false for undefined modelId
- `auto-enable.test.ts:17` — returns false for empty-string modelId
- `auto-enable.test.ts:21` — returns false for undefined patterns
- `auto-enable.test.ts:25` — returns false for empty patterns array
- `auto-enable.test.ts:29` — returns false when patterns is non-array (defensive)
- `auto-enable.test.ts:37` — matches GPT-5.x family via prefix regex
- `auto-enable.test.ts:42` — does NOT match GPT-4.x when pattern targets GPT-5.x
- `auto-enable.test.ts:46` — matches any of multiple patterns (OR semantics)
- `auto-enable.test.ts:53` — substring regex (no anchors) matches anywhere in the model id
- `auto-enable.test.ts:59` — invalid regex is treated as non-matching (no crash)
- `auto-enable.test.ts:64` — a valid pattern next to an invalid one still matches
- `auto-enable.test.ts:70` — empty-string pattern is skipped (not treated as match-all)
- `auto-enable.test.ts:75` — non-string entries in patterns array are skipped
- `auto-enable.test.ts:86` — repeated calls with the same pattern do not re-compile (stable semantics)

### A.6 — `src/agents/plan-mode/integration.test.ts` (25 tests, in-host happy + sad paths)

- `integration.test.ts:37` — returns false when agents.defaults.planMode is absent
- `integration.test.ts:42` — returns false when agents.defaults.planMode.enabled is false
- `integration.test.ts:49` — returns true only when agents.defaults.planMode.enabled === true
- `integration.test.ts:58` — returns a structured 'entered' result the runner can dispatch on
- `integration.test.ts:68` — omits reason when not provided or whitespace-only
- `integration.test.ts:78` — returns 'approval_requested' with the proposed plan
- `integration.test.ts:98` — rejects an empty plan (cannot exit without a proposal)
- `integration.test.ts:105` — rejects a plan with multiple in_progress steps
- `integration.test.ts:118` — rejects a plan with an unknown status value
- `integration.test.ts:130` — blocks `write` tool when planMode === 'plan'
- `integration.test.ts:142` — blocks `edit` tool when planMode === 'plan'
- `integration.test.ts:151` — blocks `exec` with a mutation command when planMode === 'plan'
- `integration.test.ts:160` — ALLOWS `read` tool when planMode === 'plan' (read-only)
- `integration.test.ts:169` — ALLOWS `web_search` tool when planMode === 'plan'
- `integration.test.ts:178` — ALLOWS `update_plan` tool when planMode === 'plan'
- `integration.test.ts:187` — ALLOWS `exit_plan_mode` tool when planMode === 'plan'
- `integration.test.ts:196` — ALLOWS `exec` with read-only command (e.g. `ls`) when planMode === 'plan'
- `integration.test.ts:205` — DOES NOT block any tool when planMode is absent (gate disarmed)
- `integration.test.ts:220` — DOES NOT block any tool when planMode === 'normal'
- `integration.test.ts:229` — blocks unknown tools by default in plan mode (default-deny)

### A.7 — `src/agents/plan-mode/plan-archetype-persist.test.ts` (15 tests)

- `plan-archetype-persist.test.ts:24` — writes the file under <baseDir>/<agentId>/plans/<filename>
- `plan-archetype-persist.test.ts:38` — creates the agents/<id>/plans directory recursively if missing
- `plan-archetype-persist.test.ts:51` — collision: second write same date+slug returns -2 suffix
- `plan-archetype-persist.test.ts:72` — collision: third write same date+slug returns -3 suffix
- `plan-archetype-persist.test.ts:97` — UTF-8 round-trip preserves multi-byte characters
- `plan-archetype-persist.test.ts:109` — rejects an empty agentId
- `plan-archetype-persist.test.ts:121` — rejects path-traversal characters in agentId (defense-in-depth)
- `plan-archetype-persist.test.ts:133` — undefined title falls back to the buildPlanFilename 'untitled' slug
- `plan-archetype-persist.test.ts:144` — agentIds with safe special chars (dots, hyphens, underscores) are accepted
- `plan-archetype-persist.test.ts:191` — PlanPersistStorageError is recognizable by the caller via instanceof
- `plan-archetype-persist.test.ts:209` — non-storage errors (e.g. simulated EROFS) propagate unchanged, NOT wrapped
- `plan-archetype-persist.test.ts:232` — EEXIST collision path still loops and eventually reports the cap — storage classification does NOT hijack

### A.8 — `src/agents/plan-mode/plan-archetype-bridge.test.ts` (12 tests)

- `plan-archetype-bridge.test.ts:58` — buildPlanAttachmentCaption includes title + universal /plan resolution commands
- `plan-archetype-bridge.test.ts:67` — falls back to 'Plan' when title is undefined or empty
- `plan-archetype-bridge.test.ts:72` — HTML-escapes title + summary so injection in HTML parse_mode is neutralized
- `plan-archetype-bridge.test.ts:111` — Telegram session: persists markdown AND sends document via sendDocumentTelegram (C2 re-wire)
- `plan-archetype-bridge.test.ts:160` — Telegram topic-scoped target (chatId:topic:threadId): passes through to sendDocumentTelegram (SDK parses threadId)
- `plan-archetype-bridge.test.ts:188` — Web session: persists markdown but does NOT send to Telegram
- `plan-archetype-bridge.test.ts:215` — Telegram session missing 'to': persists but skips Telegram send
- `plan-archetype-bridge.test.ts:234` — Telegram send throws: caller does not throw, warn logged, markdown still persisted (C2 re-wire)
- `plan-archetype-bridge.test.ts:264` — Multi-cycle: second exit_plan_mode same day produces -2.md suffix and fires both sends
- `plan-archetype-bridge.test.ts:301` — Missing SessionEntry (read returns undefined): no send, no throw

### A.9 — `src/agents/plan-mode/plan-archetype-prompt.test.ts` (18 tests)

- `plan-archetype-prompt.test.ts:12` — includes the decision-complete plan standard heading
- `plan-archetype-prompt.test.ts:16` — calls out the required exit_plan_mode fields by name (title/summary/analysis/plan/assumptions/risks/verification/references)
- `plan-archetype-prompt.test.ts:27` — warns against ack-only / chat-narration title (item #1 user feedback)
- `plan-archetype-prompt.test.ts:33` — clarifies ask_user_question does NOT exit plan mode
- `plan-archetype-prompt.test.ts:37` — encourages multi-page plans (no upper length cap)
- `plan-archetype-prompt.test.ts:43` — buildPlanFilenameSlug kebab-cases ASCII titles
- `plan-archetype-prompt.test.ts:49` — strips diacritics
- `plan-archetype-prompt.test.ts:53` — collapses runs of non-alphanumeric chars to single hyphens
- `plan-archetype-prompt.test.ts:57` — trims leading/trailing hyphens
- `plan-archetype-prompt.test.ts:61` — respects maxLen and trims trailing hyphen left by truncation
- `plan-archetype-prompt.test.ts:68` — falls back to "untitled" for empty / whitespace input
- `plan-archetype-prompt.test.ts:74` — falls back to "untitled" when sanitization produces empty string
- `plan-archetype-prompt.test.ts:81` — buildPlanFilename uses ISO YYYY-MM-DD date prefix + slug + .md suffix
- `plan-archetype-prompt.test.ts:88` — falls back to "untitled" slug when title is empty
- `plan-archetype-prompt.test.ts:93` — filenames sort chronologically by date prefix (cache + history scan)

### A.10 — `src/agents/plan-mode/plan-mode-debug-log.test.ts` (22 tests)

- `plan-mode-debug-log.test.ts:51` — no-op when OPENCLAW_DEBUG_PLAN_MODE unset
- `plan-mode-debug-log.test.ts:63` — no-op when OPENCLAW_DEBUG_PLAN_MODE set to value other than '1'
- `plan-mode-debug-log.test.ts:75` — emits when OPENCLAW_DEBUG_PLAN_MODE=1
- `plan-mode-debug-log.test.ts:87` — respects late-set env var (no cached gate)
- `plan-mode-debug-log.test.ts:137` — emits when agents.defaults.planMode.debug=true
- `plan-mode-debug-log.test.ts:151` — no-op when agents.defaults.planMode.debug=false
- `plan-mode-debug-log.test.ts:165` — no-op when planMode config block is missing
- `plan-mode-debug-log.test.ts:177` — no-op when loadConfig throws (fail-closed)
- `plan-mode-debug-log.test.ts:191` — env var WINS over config flag (env=1, config=false → emit)
- `plan-mode-debug-log.test.ts:216` — state_transition: tag includes kind, meta omits kind
- `plan-mode-debug-log.test.ts:232` — gate_decision: includes allowed + planMode + optional reason
- `plan-mode-debug-log.test.ts:250` — tool_call: includes tool name + runId + details
- `plan-mode-debug-log.test.ts:266` — synthetic_injection: includes tag + preview
- `plan-mode-debug-log.test.ts:280` — nudge_event: includes nudge id + phase
- `plan-mode-debug-log.test.ts:294` — subagent_event: includes parent + child runIds + event
- `plan-mode-debug-log.test.ts:310` — approval_event: includes action + subagent count + result
- `plan-mode-debug-log.test.ts:327` — approval_event: threads approvalRunId + approvalId when present for cross-event correlation
- `plan-mode-debug-log.test.ts:347` — synthetic_injection: accepts approvalRunId + approvalId for cycle correlation
- `plan-mode-debug-log.test.ts:365` — toast_event: includes toast id + phase

### A.11 — `src/agents/plan-mode/plan-nudge-crons.test.ts` (19 tests)

- `plan-nudge-crons.test.ts:38` — schedules 3 nudges at default intervals (10/30/60 min)
- `plan-nudge-crons.test.ts:48` — each scheduled cron has sessionTarget bound to the originating session
- `plan-nudge-crons.test.ts:59` — scheduled crons are one-shot (deleteAfterRun: true) and 'at' kind
- `plan-nudge-crons.test.ts:72` — scheduled crons use payload.kind=agentTurn with a self-describing message
- `plan-nudge-crons.test.ts:86` — cron job name includes the marker prefix for safe cleanup
- `plan-nudge-crons.test.ts:97` — custom intervals override the default
- `plan-nudge-crons.test.ts:108` — non-positive / non-finite intervals are skipped
- `plan-nudge-crons.test.ts:118` — per-cron schedule failures are tolerated (returns partial success)
- `plan-nudge-crons.test.ts:138` — missing jobId in response is logged and skipped
- `plan-nudge-crons.test.ts:153` — accepts cron.add responses shaped as { id }
- `plan-nudge-crons.test.ts:163` — accepts cron.add responses shaped as { job: { id } }
- `plan-nudge-crons.test.ts:175` — agentId is forwarded when provided
- `plan-nudge-crons.test.ts:185` — forwards the active planCycleId into the cron payload when provided
- `plan-nudge-crons.test.ts:201` — skips scheduling when the sessionKey fails cron sessionTarget validation
- `plan-nudge-crons.test.ts:219` — cleanupPlanNudges removes each id via cron.remove
- `plan-nudge-crons.test.ts:237` — tolerates per-id failures and returns counts
- `plan-nudge-crons.test.ts:256` — empty jobIds is a no-op

### A.12 — Other plan-mode tests

- `src/agents/plan-render.test.ts` (73 tests) — html/markdown/plaintext/slack-mrkdwn checklist rendering; status markers; cancelled strikethrough; activeForm preference; acceptance-criteria nested rendering; renderFullPlanArchetypeMarkdown sections (Title/Summary/Analysis/Plan/Assumptions/Risks/Verification/References + footer); neutralizeMentions (@channel/@here/@everyone, `<@123>` Discord); escapeMarkdown including `~` for cancelled strikethrough; warnUnknownStatus bounded set
- `src/agents/plan-store.test.ts` (34 tests) — namespace validation regex, Windows reserved names, trailing-dot rejection, control-char rejection, prototype-pollution defense at top + per-step level, MAX_PLAN_FILE_BYTES guard, O_NOFOLLOW symlink reject, realpath confinement, lock acquire/release/PID liveness/LOCK_HARD_MAX_MS, atomic write via temp+rename, mergeSteps deduplication
- `src/agents/plan-hydration.test.ts` (8 tests) — active-step filter, formatPlanForHydration output format, multiline normalization, empty result returns null
- `src/agents/tools/ask-user-question-tool.test.ts` (16 tests) — schema validation, duplicate option rejection, ≤6/≥2 cap, questionId determinism (`q-${toolCallId}`), allowFreetext default false, options trim, non-string options filtered
- `src/agents/tools/exit-plan-mode-tool.test.ts` (20 tests) — title required + ≤80 char truncation; plan.length ≥ 1; status union; ≤1 in_progress; subagent gate via getAgentRunContext; SUBAGENT_SETTLE_GRACE_MS; payloadHash deterministic; analysis/assumptions/risks/verification/references parsing
- `src/agents/tools/update-plan-tool.test.ts` (modified) — closure-gate fields, status enum, parity tests
- `src/agents/tools/update-plan-tool.parity.test.ts` (~411 LOC) — new; extensive parity with prior format
- `src/gateway/sessions-patch.test.ts` — planMode patch, planApproval branches (approve/edit/reject/answer/auto), discriminated-union schema, lastPlanSteps materialization, planMode-disabled friendly error
- `src/gateway/sessions-patch.subagent-gate.test.ts` (19 tests) — subagent-gate fail-closed semantics; combined parentCtx + persistedOpenIds; PLAN_APPROVAL_GATE_STATE_UNAVAILABLE; PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS; allowed when settled; in-flight rejection
- `src/gateway/plan-snapshot-persister.test.ts` (4 tests) — basic persist tests + `__testingPlanSnapshotPersister.persistApprovalMetadata` empty-approvalRunId throw guard
- `src/auto-reply/reply/commands-plan.test.ts` (43 tests) — parser per subcommand, feedback required for revise, foreign-bot @ disambiguation, operator-auth gate, accept/revise/answer/auto/restate/view/on/off/status dispatch, error mapping, readLatestSessionEntryFresh disk-read
- `src/auto-reply/reply/fresh-session-entry.test.ts` (~30 tests) — disk-read disable-cache, fallback to snapshot, error tolerance
- `src/cron/isolated-agent/run.plan-mode.test.ts` (~15 tests) — auto-enable wires at session start
- `src/infra/heartbeat-runner.plan-nudge.test.ts` (~10 tests) — buildActivePlanNudge suppression cases
- `src/agents/pi-embedded-runner/pending-injection.test.ts` — pending-injection consumer drains queue + clears + composes
- `src/agents/pi-embedded-runner/run/incomplete-turn.test.ts` — escalating-retry resolver tests
- `src/agents/pi-embedded-runner/run/runtime-context-prompt.test.ts` — runtime-context-prompt builder tests
- `src/agents/skills/skill-planner.test.ts` (~30 tests) — skill-planner parsing + dispatching
- `ui/src/ui/chat/mode-switcher.test.ts` (~30 tests) — dropdown rendering, mode dispatch, plan + plan-auto chip
- `ui/src/ui/chat/plan-cards.test.ts` (~15 tests) — renderPlanCard, formatPlanAsMarkdown, status markers
- `ui/src/ui/chat/plan-resume.node.test.ts` (3 tests)
- `ui/src/ui/views/plan-approval-inline.test.ts` (~25 tests) — Accept/Edit/Revise dispatch, reviseOpen state, question variant, Other... textarea, missing-handler warning
- `ui/src/ui/views/chat.test.ts` (~30 tests) — chat view with planApprovalRequest hiding input bar
- `ui/src/ui/chat/slash-command-executor.node.test.ts` (~15 tests) — slash command executor
- `src/commands/doctor-session-transcripts.test.ts` — plan-mode-state integrity

---

## Appendix B — Hook integration points (full list)

| # | Site (file:line) | Hook description |
|---|---|---|
| H1 | `src/agents/pi-embedded-subscribe.handlers.tools.ts:1791` | `toolName === "enter_plan_mode"` tool-end intercept |
| H2 | `src/agents/pi-embedded-subscribe.handlers.tools.ts:1838` | `toolName === "exit_plan_mode"` tool-end intercept |
| H3 | `src/agents/pi-embedded-subscribe.handlers.tools.ts:1971` | `toolName === "ask_user_question"` tool-end intercept |
| H4 | `src/agents/pi-embedded-subscribe.handlers.tools.ts:1812` | `schedulePlanNudgesAndPersist` (fire-and-forget after enter_plan_mode freshEntry) |
| H5 | `src/agents/pi-embedded-subscribe.handlers.tools.ts:1956` | `autoApproveIfEnabled` (fire-and-forget after exit_plan_mode emit) |
| H6 | `src/agents/pi-embedded-subscribe.handlers.tools.ts:1934-1948` | `dispatchPlanArchetypeAttachment` (Telegram attach) |
| H7 | `src/agents/pi-embedded-subscribe.handlers.tools.ts:1862-1876` | `persistPlanApprovalRequest` (synchronous lastPlanSteps + title + approvalId persist) |
| H8 | `src/agents/pi-embedded-subscribe.handlers.tools.ts:1792` | `persistPlanModeEnter` (fresh-entry detection + cycleId init) |
| H9 | `src/agents/pi-tools.before-tool-call.ts:307` | `args.ctx?.getLatestPlanMode?.()` live-mode read; ternary `liveMode !== undefined ? liveMode : args.ctx?.planMode` |
| H10 | `src/agents/pi-tools.before-tool-call.ts:317` | `checkMutationGate(toolName, latestPlanMode, execCommand)` — fires BEFORE plugin hookRunner |
| H11 | `src/agents/pi-tools.before-tool-call.ts:324` | acceptEdits branch when `liveMode === "normal"` AND `args.ctx?.getLatestAcceptEdits?.()` |
| H12 | `src/agents/pi-tools.before-tool-call.ts:355` | `extractApplyPatchTargetPaths(params.input)` for apply_patch additionalPaths |
| H13 | `src/agents/pi-tools.before-tool-call.ts:360` | `checkAcceptEditsConstraint({toolName, execCommand, filePath, additionalPaths})` |
| H14 | `src/agents/openclaw-tools.ts:288` | `isPlanModeToolsEnabledForOpenClawTools({config})` gate at tool-list materialization |
| H15 | `src/cron/isolated-agent/run.ts` | `evaluateAutoEnableForMatch(resolvedModelId, cfg.agents?.defaults?.planMode?.autoEnableFor)` at session-start |
| H16 | `src/infra/heartbeat-runner.ts:729` | `buildActivePlanNudge(entry.planMode)` before nudge injection |
| H17 | `src/infra/agent-events.ts:411` | `addOpenSubagent` (on sessions_spawn) writes ctx.openSubagentRunIds + persists blockingSubagentRunIds via persistPlanModeSubagentGateState |
| H18 | `src/infra/agent-events.ts:497` | `removeOpenSubagent` (on subagent return) clears + sets lastSubagentSettledAt |
| H19 | `src/gateway/server-runtime-subscriptions.ts:?` | `startPlanSnapshotPersister({emitSessionsChanged})` registration |
| H20 | `src/gateway/plan-snapshot-persister.ts:84` | approval-stream subscriber (filters plan-submission vs question-submission) |
| H21 | `src/gateway/plan-snapshot-persister.ts:235` | plan-stream subscriber (closeOnComplete on `phase === "completed"`) |
| H22 | `src/gateway/plan-snapshot-persister.ts:316` | persistApprovalMetadata empty-approvalRunId THROW guard (C4) |
| H23 | `src/gateway/sessions-patch.ts:484-642` | planMode patch branch |
| H24 | `src/gateway/sessions-patch.ts:644-1133` | planApproval patch branch (approve/edit/reject/answer/auto) |
| H25 | `src/gateway/sessions-patch.ts:853` | `getAgentRunContext(approvalRunId)` lookup for subagent-gate |
| H26 | `src/gateway/sessions-patch.ts:1135-1189` | lastPlanSteps materialization (read by plan-snapshot-persister) |
| H27 | `src/gateway/sessions-patch.ts:935` | `resolvePlanApproval` invocation |
| H28 | `src/gateway/sessions-patch.ts:1015,1057` | `appendToInjectionQueue` for [PLAN_DECISION] approved/edited/rejected |
| H29 | `src/gateway/plan-snapshot-persister.ts:704-709` | `appendToInjectionQueue` for [PLAN_COMPLETE] auto-close |
| H30 | `src/gateway/sessions-patch.ts:632` | `appendToInjectionQueue` for [PLAN_MODE_INTRO] one-shot |
| H31 | `src/agents/tools/exit-plan-mode-tool.ts:256` | `getAgentRunContext(runId)` for tool-side subagent gate |
| H32 | `src/agents/pi-embedded-runner/run/attempt.ts:689-749` | `planModeFeatureEnabled` check + planModeAppendPrompt composition |
| H33 | `src/agents/pi-embedded-runner/run.ts:1769` | `getLatestPlanMode` callback wired onto AgentRunContext at run-start |
| H34 | `src/agents/pi-embedded-runner/run.ts:2046` | auto-continue cycle dispatch via `planModeAckOnlyInstruction` |
| H35 | `src/agents/pi-embedded-runner/run.ts:2078` | yield-during-approved-plan retry steer |
| H36 | `src/auto-reply/reply/commands-plan.ts:306` | `readLatestSessionEntryFresh` disk-read (avoid stale snapshot) |
| H37 | `src/auto-reply/reply/commands-plan.ts:556` | `callPatch({ planApproval: { action: "reject", feedback, approvalId } })` |
| H38 | `src/gateway/server-close.ts:?` | unsubscribe teardown |
| H39 | `src/gateway/server-reload-handlers.ts:?` | re-register on config reload |

---

## Appendix C — Persistence schema delta (every SessionEntry field added)

### SessionEntry.planMode (object)

| Field | Type | Lifecycle | Source |
|---|---|---|---|
| mode | "plan"\|"normal" | Set by sessions.patch + enter_plan_mode tool; deleted on approve/edit | sessions-patch.ts, persistPlanModeEnter |
| approval | "none"\|"pending"\|"approved"\|"edited"\|"rejected"\|"timed_out" | resolvePlanApproval state machine | approval.ts |
| cycleId | string (UUID) | Minted on every fresh enter_plan_mode | persistPlanModeEnter |
| enteredAt | number (epoch ms) | Set on fresh enter | persistPlanModeEnter |
| confirmedAt | number | Set on approve/edit | resolvePlanApproval |
| updatedAt | number | Bumped on every write | persistPlanApprovalRequest + sessions-patch |
| feedback | string | Persisted on reject; cleared on approve/edit | resolvePlanApproval |
| rejectionCount | number | Incremented on reject; reset to 0 on approve/edit | resolvePlanApproval |
| approvalId | string | Minted at exit_plan_mode; reused on payloadHash match (idempotency) | persistPlanApprovalRequest |
| title | string ≤80 chars | Persisted synchronously with approvalId (race-fix) | persistPlanApprovalRequest |
| approvalRunId | string | Persisted on approval emit; defensive empty-throw guard | persistApprovalMetadata |
| lastPlanSteps | Array<{step, status, activeForm?, acceptanceCriteria?[], verifiedCriteria?[]}> | Persisted synchronously with approvalId (race-fix); also written by update_plan via plan-snapshot-persister | persistPlanApprovalRequest + persistSnapshot |
| lastPlanUpdatedAt | number | Bumped on every lastPlanSteps write | sessions-patch.ts:1175 |
| blockingSubagentRunIds | string[] | Mirror of ctx.openSubagentRunIds for fail-closed gate | persistPlanModeSubagentGateState |
| lastSubagentSettledAt | number | Set when blockingSubagentRunIds drains to zero | persistPlanModeSubagentGateState |
| nudgeJobIds | string[] | Set on schedulePlanNudges; removed on cleanup | schedulePlanNudgesAndPersist |
| autoApprove | boolean | Toggled via `/plan auto on/off`; survives mode→normal | sessions-patch.ts auto branch |
| lastPlanPayloadHash | string (SHA-1 prefix 12) | Set synchronously with approvalId; idempotency guard | persistPlanApprovalRequest |

### SessionEntry root-level plan-mode fields

| Field | Type | Lifecycle |
|---|---|---|
| recentlyApprovedAt | number | Set on approve/edit; SURVIVES planMode delete |
| recentlyApprovedCycleId | string | Paired with recentlyApprovedAt for cycle correlation |
| postApprovalPermissions | {acceptEdits, grantedAt, approvalId} | Set on `edit` action; cleared on new cycle + close-on-complete |
| planModeIntroDeliveredAt | number | One-shot marker for [PLAN_MODE_INTRO] injection |
| pendingAgentInjection | string (LEGACY) | Auto-migrated to pendingAgentInjections queue on first read |
| pendingAgentInjections | PendingAgentInjectionEntry[] | Priority-ordered queue capped at 10 |
| pendingInteraction | PendingInteraction (plan\|question discriminated) | Durable rehydration for reconnect |
| pendingQuestionApprovalId | string (LEGACY) | Read-compat for question approval validation |
| pendingQuestionOptions | string[] (LEGACY) | Read-compat for option membership validation |
| pendingQuestionAllowFreetext | boolean (LEGACY) | Read-compat for allowFreetext validation |

---

## Appendix D — Error codes added

| Code | Source | Trigger |
|---|---|---|
| PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS | `src/gateway/protocol/schema/error-codes.ts:24` | sessions.patch planApproval action approve/edit when subagents still running |
| PLAN_APPROVAL_WAITING_FOR_SUBAGENT_SETTLE | `src/gateway/protocol/schema/error-codes.ts:37` | sessions.patch when within SUBAGENT_SETTLE_GRACE_MS |
| PLAN_APPROVAL_GATE_STATE_UNAVAILABLE | `src/gateway/protocol/schema/error-codes.ts:47` | sessions.patch when modern-cycle but neither parentCtx nor persisted state |
| PLAN_APPROVAL_EXPIRED | `src/gateway/protocol/schema/error-codes.ts:64` | sessions.patch timeout watchdog (SCHEMA-RESERVED — runtime wiring deferred) |

---

## Appendix E — Synthetic-injection text tag taxonomy

Used by `[PLAN_*]:` first-line prefix; consumed by `composePromptWithPendingInjections`; hidden from user-visible chat by future regex filter.

| Tag | Emitted by | Trigger |
|---|---|---|
| `[PLAN_DECISION]: approved` | sessions-patch.ts:1009 (`buildApprovedPlanInjection`) | planApproval action=approve |
| `[PLAN_DECISION]: edited` | sessions-patch.ts:1011 (`buildAcceptEditsPlanInjection`) | planApproval action=edit |
| `[PLAN_DECISION]: rejected` | sessions-patch.ts:1049 | planApproval action=reject |
| `[PLAN_DECISION]: expired` | types.ts:201 (`buildPlanDecisionInjection`) | timeout (legacy) |
| `[PLAN_DECISION]: timed_out` | types.ts:201 | timeout (canonical) |
| `[QUESTION_ANSWER]: <text>` | sessions-patch.ts (answer branch) | planApproval action=answer |
| `[PLAN_COMPLETE]: <N> steps completed` | plan-snapshot-persister.ts:629 | closeOnComplete fires with appliedAllowAutoClose |
| `[PLAN_NUDGE]: ...` | plan-nudge-crons.ts:97 (`message`) | Cron wake-up at 10/30/60 min |
| `[PLAN_ACK_ONLY]: ...` | incomplete-turn.ts:227 + FIRM | escalating retry — chat-only ack in plan mode |
| `[PLAN_YIELD]: ...` | incomplete-turn.ts:255 + FIRM | escalating retry — yielded after approval |
| `[PLANNING_RETRY]: ...` | incomplete-turn.ts:152 + FIRM + FINAL | escalating retry — planning-only in normal mode |
| `[PLAN_MODE_INTRO]: ...` | sessions-patch.ts:589 (first-entry one-shot) | first sessions.patch { planMode: "plan" } per session |

---

## Appendix F — Tool description constants and registration

| Tool | Display constant | Description fn | Catalog entry |
|---|---|---|---|
| enter_plan_mode | ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY | describeEnterPlanModeTool() | tool-catalog.ts:271 |
| exit_plan_mode | EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY | describeExitPlanModeTool() | tool-catalog.ts:279 |
| ask_user_question | ASK_USER_QUESTION_TOOL_DISPLAY_SUMMARY | describeAskUserQuestionTool() | tool-catalog.ts:290 |
| plan_mode_status | PLAN_MODE_STATUS_TOOL_DISPLAY_SUMMARY | describePlanModeStatusTool() | (registered conditionally in openclaw-tools.ts:303) |
| update_plan | UPDATE_PLAN_TOOL_DISPLAY_SUMMARY | (existing) | tool-catalog.ts:260 |

All five register together when `isPlanModeToolsEnabledForOpenClawTools({config})` returns true; gate evaluates `cfg.agents?.defaults?.planMode?.enabled === true`.

---

## Appendix G — Subsystem loggers (always-on)

Two `createSubsystemLogger` instances emit at info-level regardless of `agents.defaults.planMode.debug`:

| Logger | Subsystem name | Purpose |
|---|---|---|
| `exitPlanGateLog` | `agents/exit-plan-gate` (in `src/agents/tools/exit-plan-mode-tool.ts:13`) | Every exit_plan_mode tool call logs `gate decision: result=... runId=... sessionKey=... openSubagents=N reason=...` including silent-bypass cases (no runId / ctx not registered / openSubagentRunIds undefined / empty) |
| `planApprovalGateLog` | `gateway/plan-approval-gate` (in `src/gateway/sessions-patch.ts:27`) | Every planApproval approve/edit gate decision logs `gate decision: action=... sessionKey=... approvalRunId=... openSubagents=N result=blocked|allowed` |

Plus the env/config-gated `[plan-mode/<kind>]` log via `createSubsystemLogger("plan-mode")` for full PlanModeDebugEvent emission.

---

## Appendix H — Documentation references

| File | Lines | Content |
|---|---|---|
| `docs/concepts/plan-mode.md` | 167 | Conceptual overview |
| `docs/plans/PLAN-MODE-ARCHITECTURE.md` | 635 | Architecture spec |
| `docs/plans/PLAN-MODE-OPERATOR-RUNBOOK.md` | 250 | Ops runbook |
| `docs/plans/rollout/README.md` | 241 | Rollout guide |
| `docs/plans/rollout/openclaw-plan-mode-rollout.patch` | 9420 | Unified rollout patch |
| `docs/agents/prompt-stack-spec.md` | (new) | System-prompt stacking spec |
| `docs/tools/slash-commands.md` | (modified) | /plan command surface docs |
| `docs/help/testing.md` | (modified) | Testing guidance |
| `docs/gateway/doctor.md` | +10 | Doctor plan-mode integrity check docs |

---

## Appendix I — QA scenarios

- `qa/scenarios/gpt54-plan-mode-default-off.md` (78 lines) — verify planMode disabled by default + opt-in flow
- `qa/scenarios/gpt54-act-dont-ask.md` — verify ask_user_question reserved for genuine tradeoffs only
- `qa/scenarios/gpt54-cancelled-status.md` — verify cancelled status rendering across surfaces
- `qa/scenarios/gpt54-injection-scan.md` — verify context-file-injection-scan defense
- `qa/scenarios/gpt54-mandatory-tool-use.md` — verify escalating retry / planning-only retry instructions

---

## Appendix J — Implementation provenance notes (PR rollup)

The plan-mode work landed across multiple PRs that the rebase compresses:

- **PR-8 / #67538**: initial plan-mode lib (mutation gate, approval, types). Subagent-gate at exit_plan_mode tool side.
- **PR-9** (Wave A1, A2, B1, B3): plan title (Tier 1), maxIterations (Tier 1), closure-gate (acceptanceCriteria + verifiedCriteria), plan nudges (10/30/60 min cron family), plan-mode ACK-only retry, plan-approved yield retry, plan-completion close-on-complete
- **PR-10**: plan archetype prompt, ask_user_question tool, auto-approve mode, plan-mode-101 SKILL companion, mode-switcher chip auto variant, autoApprove flag survives mode→normal
- **PR-11**: universal `/plan` slash commands across channels, rejection feedback REQUIRED at parse + schema layer, accept-edits-gate full layered defense, escalation-cluster `recentlyApprovedAt` survives planMode delete, deep-dive review patches (Codex P1+P2, Copilot multiple)
- **PR-13** (deferred parts) + iter-1/2/3: Telegram channel attach via plan-archetype-bridge, "Other..." inline textarea PR-13 Bug 2, plan_mode_status read-only introspection (iter-3 D6), PLAN_MODE_REFERENCE_CARD (iter-3 D1), `[plan-mode/<kind>]` debug log via createSubsystemLogger
- **PR-14**: plan archetype attachment to Telegram (full plan-archetype-bridge + plan-archetype-persist; C2 follow-up SDK re-wire), audit-artifact trail under `~/.openclaw/agents/<agentId>/plans/`
- **PR-15** (nuclear rewrite): single-scalar `pendingAgentInjection: string` → priority-ordered queue `pendingAgentInjections[]`; legacy auto-migration; deterministic localeCompare tiebreaker for prompt-cache stability
- **C-series follow-ups (Plan Mode 1.0)**:
  - C3: auto-enable for model-id patterns
  - C4: shell-escape layered defense (DESTRUCTIVE_ESCAPE_PATTERNS) + approvalRunId silent-bypass guard
  - C7: approvalRunId + approvalId correlation threaded through debug-log events
- **Eva live-test iter-1**: persist title + approvalRunId synchronously after agent_approval_event; iter-2 Bug A live-read planMode via getLatestPlanMode; Bug C always-on approval-gate log; Bug D config-flag debug toggle (vs env-var-only)
- **Eva live-test iter-3**: PLAN_MODE_REFERENCE_CARD bootstrap, [PLAN_MODE_INTRO]: one-shot, plan_mode_status read-only tool, plan-mode-101 skill, `/plan self-test` slash command
- **2026-04-26 race-fix stack** (commits `1081067476` + `f987994a42` + `bbe35cd484`): synchronous lastPlanSteps + title write in `persistPlanApprovalRequest`; transcript in-place jsonl rewrite + multi-block live-stream dedup; transcript narrowed-timestamp read fix
- **2026-04-28 Telegram /plan accept duplicate-fire** (commits `39199f8e42` + `86502f55fc` + `ea04ea52c7`): lastPlanPayloadHash idempotency guard; `/plan accept` reads fresh planMode from disk; `[plan-accept-debug]` line at precondition

All of the above must land in the plugin port. The catalog above enumerates the surface of each.

---

## Appendix K — Public type surface inventory (must export from plugin)

For type-level parity, the plugin must export (or re-export from openclaw types):

```typescript
// src/agents/plan-mode/types.ts
export type PlanMode = "plan" | "normal";
export type PlanApprovalState = "none" | "pending" | "approved" | "edited" | "rejected" | "timed_out";
export interface PlanModeSessionState { mode, approval, ... }
export const DEFAULT_PLAN_MODE_STATE: PlanModeSessionState;
export function newPlanApprovalId(): string;
export function buildPlanDecisionInjection(decision: "rejected" | "expired" | "timed_out", feedback?, rejectionCount?): string;

// src/agents/plan-mode/mutation-gate.ts
export interface MutationGateResult { blocked: boolean; reason?: string }
export function checkMutationGate(toolName: string, currentMode: PlanMode, execCommand?: string): MutationGateResult;

// src/agents/plan-mode/approval.ts
export interface PlanApprovalConfig { approvalTimeoutSeconds: number }
export const DEFAULT_APPROVAL_CONFIG: PlanApprovalConfig;
export const SUBAGENT_SETTLE_GRACE_MS: 10000;
export const MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE: 1;
export function resolvePlanApproval(current, action, feedback?, expectedApprovalId?): PlanModeSessionState;
export function buildApprovedPlanInjection(planSteps: string[]): string;
export function buildAcceptEditsPlanInjection(planSteps: string[]): string;

// src/agents/plan-mode/accept-edits-gate.ts
export interface AcceptEditsGateParams { toolName, execCommand?, filePath?, additionalPaths? }
export interface AcceptEditsGateResult { blocked, reason?, constraint? }
export function checkAcceptEditsConstraint(params): AcceptEditsGateResult;
export function extractApplyPatchTargetPaths(input: unknown): string[];

// src/agents/plan-mode/auto-enable.ts
export function evaluateAutoEnableForMatch(modelId: string | undefined, patterns: ReadonlyArray<string> | undefined): boolean;

// src/agents/plan-mode/injections.ts
export interface PendingAgentInjectionEntry { id, approvalId?, kind, text, createdAt, priority?, expiresAt? }
export type PendingAgentInjectionKind = "plan_decision" | "question_answer" | "plan_complete" | "plan_intro" | "plan_nudge" | "subagent_return";
export const DEFAULT_INJECTION_PRIORITY: Record<string, number>;
export const MAX_QUEUE_SIZE: 10;
export function enqueuePendingAgentInjection(sessionKey, entry, log?): Promise<boolean>;
export function consumePendingAgentInjections(sessionKey, log?): Promise<ConsumePendingAgentInjectionsResult>;
export function appendToInjectionQueue(entry, newEntry, log?): void;
export function composePromptWithPendingInjections(injections, userPrompt): string;
export function migrateLegacyPendingInjection(entry, now): {queue, migrated};
export function sortAndCapQueue(queue, log?): PendingAgentInjectionEntry[];
export function upsertIntoQueue(queue, entry): PendingAgentInjectionEntry[];

// src/agents/plan-mode/plan-mode-debug-log.ts
export type PlanModeDebugEvent = /* discriminated union of state_transition | gate_decision | tool_call | synthetic_injection | nudge_event | subagent_event | approval_event | toast_event | approval_transition */;
export function logPlanModeDebug(event: PlanModeDebugEvent): void;
export function logPlanModeApprovalTransition(sessionKey, prev, next, trigger): void;
export function isPlanModeDebugEnabled(): boolean;

// src/agents/plan-mode/plan-archetype-prompt.ts
export const PLAN_ARCHETYPE_PROMPT: string;
export function buildPlanFilenameSlug(title, maxLen?): string;
export function buildPlanFilename(title, date?): string;

// src/agents/plan-mode/plan-archetype-persist.ts
export class PlanPersistStorageError extends Error { code: "ENOSPC" | "EACCES" | "EIO" }
export interface PersistPlanArchetypeMarkdownInput { ... }
export interface PersistPlanArchetypeMarkdownResult { absPath, filename }
export async function persistPlanArchetypeMarkdown(input): Promise<PersistPlanArchetypeMarkdownResult>;

// src/agents/plan-mode/plan-archetype-bridge.ts
export interface DispatchPlanArchetypeAttachmentInput { ... }
export async function dispatchPlanArchetypeAttachment(input): Promise<void>;
export function buildPlanAttachmentCaption(title, summary): string;

// src/agents/plan-mode/plan-nudge-crons.ts
export interface PlanNudgeSchedulerDeps { ... }
export interface ScheduledPlanNudge { jobId, fireAtMs }
export async function schedulePlanNudges(params): Promise<ScheduledPlanNudge[]>;
export async function cleanupPlanNudges(params): Promise<{removed, failed}>;
export const PLAN_NUDGE_NAME_PREFIX_FOR_TEST: string;

// src/agents/plan-mode/reference-card.ts
export const PLAN_MODE_REFERENCE_CARD: string;

// src/agents/tools/*
export function createEnterPlanModeTool(options?): AnyAgentTool;
export function createExitPlanModeTool(options?): AnyAgentTool;
export function createAskUserQuestionTool(options?): AnyAgentTool;
export function createPlanModeStatusTool(options?): AnyAgentTool;

// src/agents/plan-render.ts
export type PlanRenderFormat = "html" | "markdown" | "plaintext" | "slack-mrkdwn";
export interface PlanStepForRender { ... }
export function renderPlanChecklist(steps, format): string;
export function renderPlanWithHeader(title, steps, format): string;
export function renderFullPlanArchetypeMarkdown(input): string;

// src/agents/plan-hydration.ts
export function formatPlanForHydration(steps): string | null;

// src/agents/plan-store.ts
export interface StoredPlanStep { ... }
export interface StoredPlan { ... }
export class PlanStore { /* read, write, lock, mergeSteps */ }

// src/config/sessions/types.ts (mirrored)
export interface PostApprovalPermissions { acceptEdits, grantedAt, approvalId }
export type PendingInteractionStatus = "pending" | "resolved";
export type PendingInteraction = /* plan | question discriminated */;

// src/gateway/plan-snapshot-persister.ts
export function startPlanSnapshotPersister(params): () => void;
export async function persistPlanModeSubagentGateState(params): Promise<void>;
```

The plugin MUST expose the same `agents.defaults.planMode.{enabled, autoEnableFor, approvalTimeoutSeconds, debug}` config surface AND the `agents.defaults.embeddedPi.{autoContinue.{enabled, maxCycles, stopOnMutation}, maxIterations}` AND the `agents.defaults.compaction.reserveTokensFloor` fields (Zod schema in `src/config/zod-schema.agent-defaults.ts`).

---

## Appendix L — Race-fix proof (cite every code site)

The empty-plan-body race fix has THREE simultaneous code-site requirements:

### L.1 — `persistPlanApprovalRequest` writes lastPlanSteps SYNCHRONOUSLY

File: `src/agents/pi-embedded-subscribe.handlers.tools.ts:206-223`

```typescript
const nextPlanMode = {
  ...current,
  approval: "pending" as const,
  approvalId,
  updatedAt: now,
  // 2026-04-26 (Eva live-test): persist title + lastPlanSteps
  // synchronously here so the sessions-patch approve handler
  // (sessions-patch.ts:977) sees the populated steps when it
  // reads next.planMode.lastPlanSteps to build the
  // [PLAN_DECISION]: approved injection.
  ...(planSnapshot?.title ? { title: planSnapshot.title } : {}),
  ...(planSnapshot?.payloadHash ? { lastPlanPayloadHash: planSnapshot.payloadHash } : {}),
  ...(planSnapshot?.lastPlanSteps && planSnapshot.lastPlanSteps.length > 0
    ? { lastPlanSteps: planSnapshot.lastPlanSteps }
    : {}),
};
```

### L.2 — `persistPlanApprovalRequest` is awaited BEFORE the approval event broadcasts

File: `src/agents/pi-embedded-subscribe.handlers.tools.ts:1862-1918`

```typescript
if (ctx.params.sessionKey) {
  const persistResult = await persistPlanApprovalRequest(
    ctx.params.sessionKey,
    approvalId,
    ctx.log,
    {
      ...(details.title ? { title: details.title } : {}),
      ...(details.payloadHash ? { payloadHash: details.payloadHash } : {}),
      lastPlanSteps: details.plan.map((step) => ({
        step: step.step,
        status: step.status,
        ...(step.activeForm ? { activeForm: step.activeForm } : {}),
      })),
    },
  );
  approvalId = persistResult.approvalId;  // USE WHAT DISK SAYS
  // ...
}
// ...
emitAgentApprovalEvent({...});  // broadcasts AFTER await
```

### L.3 — `buildApprovedPlanInjection` reads `next.planMode.lastPlanSteps`

File: `src/gateway/sessions-patch.ts:994-1014`

```typescript
// Read the plan steps BEFORE the planMode.mode === "normal"
// branch below deletes `next.planMode` entirely.
const approvedSteps: string[] = (next.planMode?.lastPlanSteps ?? []).map((step) =>
  step.step,
);
const approvalId = /* ... */;
const injectionText =
  action === "approve"
    ? buildApprovedPlanInjection(approvedSteps)
    : buildAcceptEditsPlanInjection(approvedSteps);
appendToInjectionQueue(next, {
  id: `plan-decision-${approvalId}`,
  approvalId,
  kind: "plan_decision",
  text: injectionText,
  createdAt: now,
});
```

If ANY of L.1 / L.2 / L.3 is incorrect in the plugin, the empty-plan-body race RE-OPENS.

---

## Appendix M — Final must-have checklist

For each line below, the implementation MUST be present and pass the matched test file. No partial coverage acceptable.

- [ ] `checkMutationGate` blocks {apply_patch, bash, edit, exec, gateway, message, nodes, process, sessions_send, subagents, write} (default-deny on unknown; bypass for read-only suffix MCP tools)
- [ ] `PLAN_MODE_ALLOWED_TOOLS` matches the in-host set exactly (17 names including sessions_yield, lcm_grep, lcm_expand_query)
- [ ] `READ_ONLY_EXEC_PREFIXES` matches the in-host 20-prefix set exactly
- [ ] DANGEROUS_FLAGS regex word-boundary matching (-fprint family included; not just -delete/-exec/-rf)
- [ ] Shell compound op regex `/[;|&\`\n\r]|\$\(|>>?|<\(|>\(/` exactly
- [ ] `resolvePlanApproval` state machine: approve/edit clear feedback+rejectionCount, reject increments, terminal-state guard, stale-approvalId no-op (BOTH-defined check), "none"+no-approvalId no-op for approve/edit/reject
- [ ] `newPlanApprovalId()` uses cryptographically secure RNG (crypto.randomUUID or node:crypto), THROWS rather than emit weak token
- [ ] `buildPlanDecisionInjection` sanitizes feedback against `[/PLAN_DECISION]` envelope escape via U+200B
- [ ] `buildApprovedPlanInjection` + `buildAcceptEditsPlanInjection` produce byte-identical output per input
- [ ] `enqueuePendingAgentInjection` migrates legacy `pendingAgentInjection: string` to queue on first read
- [ ] `consumePendingAgentInjections` DROPS captured entries on write failure (no double-deliver)
- [ ] `sortAndCapQueue` deterministic localeCompare tiebreaker
- [ ] `MAX_QUEUE_SIZE = 10` with oldest-eviction
- [ ] `persistPlanApprovalRequest` writes lastPlanSteps + title + lastPlanPayloadHash + approvalId in ONE synchronous `updateSessionStoreEntry` callback
- [ ] Idempotency guard: payloadHash match + pending + valid approvalId → reuse existing approvalId
- [ ] `approvalId = persistResult.approvalId` (NOT candidate) for downstream emit
- [ ] `persistPlanModeEnter` returns `{ok, freshEntry}`; nudges only scheduled on freshEntry
- [ ] Fresh-entry initialization: cycleId = randomUUID(), enteredAt, updatedAt, rejectionCount = 0, blockingSubagentRunIds = []
- [ ] `autoApproveIfEnabled`: poll-until-pending (50ms × 40 attempts = 2s max), bail if approval flips off, error-level log on failure
- [ ] `agents/exit-plan-gate` always-on logger emits gate decision for every exit_plan_mode tool call
- [ ] `gateway/plan-approval-gate` always-on logger emits subagent gate decision
- [ ] `[plan-mode/<kind>]` debug log gated by env-var OR `agents.defaults.planMode.debug === true` (env wins; 30s TTL cache on config read)
- [ ] PLAN_ARCHETYPE_PROMPT + PLAN_MODE_REFERENCE_CARD appended on every plan-mode attempt (regardless of systemPromptOverride)
- [ ] plan-archetype-bridge: render markdown → persist atomic → Telegram document upload (when channel=telegram)
- [ ] persistPlanArchetypeMarkdown: O_CREAT|O_EXCL "wx" flag; max collision suffix 99; symlink rejection; agentId traversal rejection; PlanPersistStorageError on ENOSPC/EACCES/EIO
- [ ] schedulePlanNudges: default intervals [10, 30, 60] minutes; one-shot crons; `plan-nudge:` job-name prefix; assertSafeCronSessionTargetId validation
- [ ] cleanupPlanNudges fires on exit/close-on-complete
- [ ] heartbeat-runner.buildActivePlanNudge: SUPPRESS when approval==="pending" or updatedAt within idleThresholdMs
- [ ] auto-continue cycle: respects autoContinue.enabled, maxCycles (default 3), stopOnMutation (default true)
- [ ] PLAN_MODE_ACK_ONLY_RETRY_INSTRUCTION + FIRM (max 2 attempts), PLAN_APPROVED_YIELD_RETRY_INSTRUCTION + FIRM (max 2), PLANNING_ONLY_RETRY_INSTRUCTION + FIRM + FINAL
- [ ] recentlyApprovedAt + recentlyApprovedCycleId SURVIVE planMode delete on approve/edit
- [ ] postApprovalPermissions scoped by approvalId; cleared on new cycle + close-on-complete
- [ ] checkAcceptEditsConstraint: fail-OPEN posture; blocks destructive/self-restart/config-change/protected-path
- [ ] DESTRUCTIVE_ESCAPE_PATTERNS: env-var / backtick / $() / quote-concat / hex / octal (C4 layered defense)
- [ ] SELF_RESTART_PATTERNS: openclaw/launchctl/systemctl/pkill/killall/kill + pipe-chained `pgrep | xargs kill`
- [ ] PROTECTED_CONFIG_PATH_PREFIXES: ~/.openclaw/, ~/.claude/, ~/.config/openclaw/, /etc/openclaw/, /usr/local/etc/openclaw/
- [ ] normalizeCandidatePath: both ~ and $HOME forms; collapse .. / .
- [ ] extractApplyPatchTargetPaths: Update File / Add File / Delete File / Move to: parser
- [ ] persistApprovalMetadata: defensive THROW on empty approvalRunId (C4 silent-bypass guard)
- [ ] subagent gate combines parentCtx (`getAgentRunContext(approvalRunId)`) + persistedOpenIds (`planMode.blockingSubagentRunIds`) + lastSubagentSettledAt + 10s grace window
- [ ] PLAN_APPROVAL_GATE_STATE_UNAVAILABLE emitted when modern-cycle but neither parentCtx nor persisted
- [ ] PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS emitted when combined open set non-empty
- [ ] addOpenSubagent + removeOpenSubagent mutate ctx.openSubagentRunIds AND persist blockingSubagentRunIds + lastSubagentSettledAt
- [ ] exit_plan_mode tool-side gate fires before submission emit
- [ ] plan_mode_status read-only tool exposes openSubagentCount, approvalRunId, approvalId, sessionStoreReadOk, etc.
- [ ] `/plan {accept[, edits]|revise <feedback>|answer <text>|on|off|status|view|auto on|off|restate}` slash commands (all 10 subcommands)
- [ ] readLatestSessionEntryFresh disk-read for accept/revise precondition
- [ ] PR-13 Bug 2 question Other... textarea cancel returns to options (not dismiss card)
- [ ] mode-switcher chip dropdown with Plan + Plan ⚡ (auto) variants
- [ ] Inline plan-approval card above chat input bar (Accept / Accept allow edits / Revise + Open plan + revise textarea)
- [ ] Plan cards <details>/<summary> with STATUS_MARKERS (⬚/⏳/✅/❌)
- [ ] update_plan: closure-gate fields (acceptanceCriteria + verifiedCriteria) per step
- [ ] maxIterations replaces auth-count-scaled default; floor at 500
- [ ] compaction.reserveTokensFloor config field
- [ ] plan_mode_status returns sessionStoreReadOk + sessionStoreReadError? for diagnostic clarity
- [ ] discriminated-union planApproval schema: approve / edit / reject (feedback required) / answer (approvalId required) / auto (autoEnabled required)
- [ ] lastPlanSteps schema: closed enum status (pending/in_progress/completed/cancelled)
- [ ] plan-snapshot-persister: pre-flight `allowAutoClose` check + LOCKED re-evaluation inside store-write callback; `appliedAllowAutoClose` (locked) drives post-write side effects
- [ ] [PLAN_COMPLETE] injection text built from locked decision
- [ ] sessions.changed wire payload exposes planMode read-only (for UI mode chip)
- [ ] plan-hydration injects active plan after compaction with `[Your active plan was preserved across context compression]` header

If a checkbox above is unchecked at port time, the port fails parity.

---

