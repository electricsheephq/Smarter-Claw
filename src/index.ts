/**
 * Smarter-Claw — OpenClaw plan-mode plugin v1 entry.
 *
 * P-1 scope: skeleton + manifest + degraded-state warning. NO feature
 * logic yet. Each subsequent PR (P-2 → P-final) wires in one feature
 * from the parity catalog at
 * `architecture-v2/01-PARITY_CATALOG.md` on the architecture-v2-planning
 * branch.
 *
 * Source-of-truth for parity: in-host plan-mode work at
 * `/Users/lume/repos/openclaw-pr70071-rebase` tip `ea04ea52c7`.
 *
 * Plan file: `/Users/lume/.claude/plans/glistening-swimming-rivest.md`.
 *
 * # Why a session_start degraded-state warning?
 *
 * Per Wave-6 final adversarial probe P2: the plugin requires
 * `plugins.entries.smarter-claw.hooks.allowConversationAccess: true`
 * in operator config to fire conversation-access hooks (`before_agent_finalize`
 * for auto-continue/escalating-retry, etc.). Without the flag, those
 * hooks silently no-op — exactly the
 * "manifest accepts, implementation no-ops" failure pattern that the
 * Wave-1 lessons-learned doc identifies as the dominant prior failure.
 *
 * The `session_start` event DOES fire without `allowConversationAccess`
 * (it's a lifecycle event, not a conversation-access hook — confirmed at
 * `docs/plugins/hooks.md:136-137`). So we use it to emit a user-visible
 * warning on every session start when the operator config is missing the
 * flag. The warning stops once the flag is set.
 *
 * Note: `before_tool_call` (the mutation gate's primary seam) does NOT
 * require `allowConversationAccess`. Only the conversation-access hooks
 * do. P-1 ships the warning as a defense-in-depth so that when later PRs
 * add those hooks, the warning is already wired.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  checkAcceptEditsConstraint,
  extractApplyPatchTargetPaths,
} from "./gates/accept-edits-gate.js";
import { checkMutationGate } from "./gates/mutation-gate.js";
import { buildApprovedPlanInjection } from "./plan-mode/approval.js";
import {
  buildPlanModeActiveSystemContext,
  buildPlanModeAvailableSystemContext,
} from "./prompt/plan-mode-injection.js";
import { InMemoryGateway } from "./state/in-memory-gateway.js";
import { SessionStoreGateway } from "./state/session-store-gateway.js";
import { PlanModeStore, type PlanModeStateGateway } from "./state/store.js";
import {
  logPlanModeApprovalTransition,
  logPlanModeDebug,
} from "./runtime/debug-log.js";
import { decideEscalatingRetry } from "./runtime/escalating-retry.js";
import { GrantLedger } from "./runtime/grant-ledger.js";
import { enqueuePlanApprovedInjection } from "./runtime/injection-writer.js";
import { decidePlanTierModel } from "./runtime/plan-tier-model.js";
import { createAskUserQuestionTool } from "./tools/ask-user-question.js";
import { createEnterPlanModeTool } from "./tools/enter-plan-mode.js";
import { createExitPlanModeTool } from "./tools/exit-plan-mode.js";
import { createPlanModeSessionActions } from "./ui/session-actions.js";
import {
  createPlanSlashCommand,
  createPlanModeSlashCommand,
} from "./ui/slash-commands.js";
import { buildPlanModeSidebarDescriptor } from "./ui/sidebar-descriptor.js";
import { createPlanClearCli } from "./ui/sweep-command.js";
import type { PlanMode } from "./types.js";

export const SMARTER_CLAW_PLUGIN_ID = "smarter-claw";
export const PLAN_MODE_SESSION_EXTENSION_NAMESPACE = "plan-mode";

/**
 * Plugin config schema (minimal in P-1; expanded by later PRs).
 *
 * Per Wave-1 LESSONS_LEARNED.md guardrail #2: do NOT add config knobs
 * that are accepted by the manifest schema but no-op in implementation
 * ("manifest-vs-implementation drift"). Every field below must be
 * consumed by the runtime, or it must not exist.
 */
type SmarterClawConfig = {
  /**
   * Globally enable or disable the plugin. Defaults to true on register.
   * When false, the plugin registers zero hooks (effectively uninstalled
   * without manifest removal).
   */
  enabled?: boolean;
  /**
   * Optional model override for plan-mode turns (P-9). Routed via
   * before_model_resolve. Requires allowConversationAccess.
   */
  planTierModel?: string;
  /**
   * Optional provider override paired with planTierModel.
   */
  planTierProvider?: string;
  /**
   * W1-F2 (P0) fix (2026-05-20): override the base directory under
   * which `exit_plan_mode` persists the rendered plan archetype
   * (`<baseDir>/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md`).
   *
   * Defaults to `~/.openclaw/agents` (in-host parity). Operators
   * pointing the plugin at a non-default home (e.g. when running
   * out-of-tree under an immutable OS layout) can override.
   *
   * Wired to the persister via `createExitPlanModeTool({...persister})`.
   *
   * host_ref: src/agents/plan-mode/plan-archetype-persist.ts:61-67
   *           (the `baseDir` override semantics)
   */
  plansBaseDir?: string;
};

const DEFAULT_CONFIG: Required<Pick<SmarterClawConfig, "enabled">> & SmarterClawConfig = {
  enabled: true,
};

function resolveConfig(raw: unknown): Required<Pick<SmarterClawConfig, "enabled">> & SmarterClawConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  const partial = raw as Partial<SmarterClawConfig>;
  const planTierModel =
    typeof partial.planTierModel === "string" && partial.planTierModel.trim().length > 0
      ? partial.planTierModel.trim()
      : undefined;
  const planTierProvider =
    typeof partial.planTierProvider === "string" && partial.planTierProvider.trim().length > 0
      ? partial.planTierProvider.trim()
      : undefined;
  // W1-F2 (2026-05-20): operator-tunable persistence root for the
  // archetype markdown files. Trimmed; blank → undefined (so the
  // persister falls back to `~/.openclaw/agents`).
  const plansBaseDir =
    typeof partial.plansBaseDir === "string" &&
    partial.plansBaseDir.trim().length > 0
      ? partial.plansBaseDir.trim()
      : undefined;
  return {
    enabled:
      typeof partial.enabled === "boolean" ? partial.enabled : DEFAULT_CONFIG.enabled,
    ...(planTierModel ? { planTierModel } : {}),
    ...(planTierProvider ? { planTierProvider } : {}),
    ...(plansBaseDir ? { plansBaseDir } : {}),
  };
}

/**
 * Detect whether the operator has granted the conversation-access flag
 * we need for later-PR features (auto-continue, escalating retry,
 * archetype injection). The flag lives on the host-side plugin config
 * at `plugins.entries.smarter-claw.hooks.allowConversationAccess`.
 *
 * We can't read host plugin config from the plugin runtime context in
 * a portable way (the SDK does not expose `api.config.get`). What we
 * CAN do is detect the symptom: if `allowConversationAccess` is NOT set,
 * `before_agent_finalize` and `llm_output` hooks never invoke our
 * handlers. P-1 ships the warning unconditionally; P-10 ships the
 * conversation-access hooks. If P-10's hooks never fire after multiple
 * sessions, the operator's config is degraded — but we cannot detect
 * "never fired" from P-1 without a feedback channel from those hooks
 * back to the warning.
 *
 * For P-1, we emit a "make sure you've set this if you intend to use
 * full plan-mode" advisory message on every session start. P-10 will
 * tighten this to a runtime self-check when the conversation-access
 * hooks land.
 *
 * Wave-6 P2 mitigation: surface the requirement to users via session
 * messages, not just operator logs.
 */
function buildAdvisorySessionMessage(): string {
  return (
    "Smarter-Claw plan-mode plugin is installed. " +
    "Required operator config for full plan-mode behavior: " +
    "`plugins.entries.smarter-claw.hooks.allowConversationAccess: true`. " +
    "Mutation gate works without this flag; archetype injection, " +
    "auto-continue, and escalating-retry features require it. " +
    "See `https://github.com/electricsheephq/Smarter-Claw#required-operator-config`."
  );
}

export default definePluginEntry({
  id: SMARTER_CLAW_PLUGIN_ID,
  name: "Smarter-Claw",
  description:
    "Plan-Mode plugin for OpenClaw. Plan-then-execute workflow with " +
    "mutation gate, archetype prompting, escalating retry, and " +
    "rejection-cycle tracking. Requires " +
    "`allowConversationAccess: true` in operator config for full " +
    "behavior; mutation gate works without it.",
  // No `kind` — that field is for memory/context-engine specialized
  // plugins. Smarter-Claw is a general workflow plugin.
  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);
    if (!config.enabled) {
      // No-op when disabled. Mirror the in-host behavior where
      // `agents.defaults.planMode.enabled: false` skips all wiring.
      api.logger.info(
        "[smarter-claw] disabled via plugin config; not registering hooks",
      );
      return;
    }

    // P-1 foundation: reserve the session-extension namespace so future
    // PRs (P-3 onward) can patch state via the host's
    // `sessions.pluginPatch` RPC. The namespace is fixed at "plan-mode"
    // per architecture decision (Option C: single namespace owned by
    // PlanModeStore). See `architecture-v2/02-ARCHITECTURE_OPTIONS.md`.
    //
    // Using the new nested form `api.session.state.registerSessionExtension`
    // (preferred since v2026.5.10-beta.5). The flat
    // `api.registerSessionExtension` still works as a deprecated alias
    // but will be removed in a future major.
    api.session.state.registerSessionExtension({
      namespace: PLAN_MODE_SESSION_EXTENSION_NAMESPACE,
      description:
        "Plan-mode state — current mode, pending approval, cycle counter, " +
        "etc. Schema versioned via __schemaVersion (P-3).",
    });

    // P-6: production gateway backed by the host's session-store.
    //
    // Default: SessionStoreGateway — writes plan-mode state to
    // `pluginExtensions["smarter-claw"]["plan-mode"]` on the session
    // entry via the same `updateSessionStoreEntry` helper the in-host
    // uses (commit ea04ea52c7). Survives plugin reload; visible to UI
    // / channel handlers / slash commands via the session row.
    //
    // Override: env `SMARTER_CLAW_USE_INMEMORY=1` switches to the
    // in-memory gateway. Useful for dev + test environments without
    // a configured session-store, and for parity-harness runs where
    // we need deterministic state without touching disk.
    const useInMemory = process.env.SMARTER_CLAW_USE_INMEMORY === "1";
    const gateway: PlanModeStateGateway = useInMemory
      ? new InMemoryGateway()
      : new SessionStoreGateway({
          logger: {
            debug: (msg) => api.logger.debug?.(`[plan-mode-gateway] ${msg}`),
            warn: (msg) => api.logger.warn(`[plan-mode-gateway] ${msg}`),
          },
        });
    if (useInMemory) {
      api.logger.warn(
        "[smarter-claw] SMARTER_CLAW_USE_INMEMORY=1 — state NOT persisted across plugin reload. Dev/test only.",
      );
    }
    // P-14: grant ledger — in-memory correlation of approvalId →
    // (approvalRunId, sessionKey). Populated on exit_plan_mode persist
    // path; queried in debug-log emit for correlation enrichment.
    const grantLedger = new GrantLedger();

    const store = new PlanModeStore(
      gateway,
      {
        warn: (msg: string) => api.logger.warn(`[plan-mode-store] ${msg}`),
        info: (msg: string) => api.logger.info(`[plan-mode-store] ${msg}`),
      },
      (event) => {
        // P-4 base audit: human-readable log line for operators.
        api.logger.info(
          `[plan-mode-audit] ${event.source}: ` +
            `${event.prev?.mode ?? "(none)"}/${event.prev?.approval ?? "(none)"} → ` +
            `${event.next.mode}/${event.next.approval} ` +
            `(session=${event.sessionKey})`,
        );

        // P-14: structured debug-log emit. No-op when plan-mode debug
        // is disabled (env var or pluginConfig.debug).
        logPlanModeApprovalTransition(
          api.logger,
          api.pluginConfig,
          event.sessionKey,
          event.prev,
          event.next,
          event.source,
        );

        // P-14: grant-ledger updates on persist-approval transitions
        // (where approvalId rotates) and pruning on terminal states.
        if (
          event.next.approval === "pending" &&
          event.next.approvalId &&
          event.next.approvalId !== event.prev?.approvalId
        ) {
          grantLedger.record({
            approvalId: event.next.approvalId,
            ...(event.next.approvalRunId
              ? { approvalRunId: event.next.approvalRunId }
              : {}),
            sessionKey: event.sessionKey,
          });
        }
        // Prune on terminal states — frees memory after cycle resolves.
        if (
          event.prev?.approvalId &&
          (event.next.approval === "approved" ||
            event.next.approval === "edited" ||
            event.next.approval === "rejected")
        ) {
          // Note: recordRejection clears approvalId, so we use prev's.
          grantLedger.prune(event.prev.approvalId);
        }
      },
    );

    api.registerTool(createEnterPlanModeTool({ store }), {
      name: "enter_plan_mode",
    });
    // W1-F2 (P0) fix (2026-05-20): wire the in-host plan-archetype
    // markdown persister. `exit_plan_mode` now writes
    // `<plansBaseDir>/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md`
    // on every NEW approval cycle so the archetype-prompt + reference
    // card promise ("title becomes the persisted markdown filename")
    // is true. Failure is non-fatal (the persister catches + logs);
    // approval flow is unaffected.
    //
    // host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:1925-1949
    //
    // W1-F4 (P1) fix (2026-05-20): wire the in-host auto-approve
    // trigger. When the operator has flipped `autoApprove: true`
    // (via `/plan auto on`), `exit_plan_mode` now resolves the
    // freshly-persisted approval IMMEDIATELY as `approve` so the
    // agent self-executes instead of waiting for a manual click.
    //
    // Pre-W1-F4 the flag was a real flag with a real mutator + a
    // real slash command, but NO caller — `RELEASE_NOTES.md`
    // known-limitation #3 acknowledged this gap, and the
    // benchmark-codex-claude-code.md audit (F4) flagged it as a
    // "non-functional safety-relevant control".
    //
    // Implementation: the trigger callback closes over `store` +
    // `api` and reuses the exact same two operations that
    // `plan.accept` uses (recordApproval + enqueuePlanApprovedInjection
    // with the full buildApprovedPlanInjection preamble). Fires
    // `approve`, NOT `edit` — auto-approve = verbatim execution of
    // the submitted plan, never grants the agent acceptEdits.
    //
    // host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:387-477
    //   (in-host `autoApproveIfEnabled` — the function this wiring
    //   ports the behavioral contract of).
    // host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:1949-1962
    //   (in-host callsite, void-fired after the approval emit).
    api.registerTool(
      createExitPlanModeTool({
        store,
        persister: {
          ...(config.plansBaseDir ? { baseDir: config.plansBaseDir } : {}),
          log: {
            info: (msg) => api.logger.info(msg),
            warn: (msg) => api.logger.warn(msg),
            ...(api.logger.debug
              ? { debug: (msg) => api.logger.debug!(msg) }
              : {}),
          },
        },
        autoApprove: {
          // The trigger mirrors `plan.accept`'s two-step resolution
          // (src/ui/session-actions.ts ~260-302):
          //   1. store.recordApproval (with the expected approvalId
          //      version-token so the stale-event guard fires if a
          //      racing /plan reject already landed),
          //   2. enqueuePlanApprovedInjection with the FULL
          //      buildApprovedPlanInjection(planSteps) preamble
          //      (opener + "execute it now without re-planning" +
          //      numbered step list). Matches the in-host
          //      `sessions-patch.ts approve` branch which emits the
          //      same text via `buildApprovedPlanInjection`.
          trigger: async ({ sessionKey, approvalId, planSteps }) => {
            const persist = await store.recordApproval({
              sessionKey,
              edited: false,
              expectedApprovalId: approvalId,
            });
            if (persist.kind === "failed") {
              throw persist.error;
            }
            if (persist.kind === "skipped") {
              // The state-machine guard fired (terminal state, stale
              // id, or session already exited plan-mode). The
              // fireAutoApproveIfEnabled helper's pre-checks should
              // have caught most of these — log here so we see any
              // remaining races and don't enqueue a phantom injection.
              api.logger.warn(
                `[smarter-claw] auto-approve recordApproval skipped: ${persist.reason} ` +
                  `sessionKey=${sessionKey} approvalId=${approvalId}`,
              );
              return;
            }
            const stepLines = planSteps.map((step) =>
              step.activeForm
                ? `${step.step} (${step.activeForm})`
                : step.step,
            );
            const fullText =
              stepLines.length > 0
                ? buildApprovedPlanInjection(stepLines)
                : undefined;
            await enqueuePlanApprovedInjection(api, {
              sessionKey,
              approvalId,
              edited: false,
              ...(fullText ? { fullText } : {}),
            });
          },
          log: {
            info: (msg) => api.logger.info(msg),
            warn: (msg) => api.logger.warn(msg),
            error: (msg) =>
              // OpenClawPluginLogger has `error` as optional but the
              // SDK shim always provides it; fall back to warn for
              // defensive completeness.
              (api.logger as { error?: (msg: string) => void }).error?.(msg) ??
              api.logger.warn(msg),
          },
        },
      }),
      {
        name: "exit_plan_mode",
      },
    );
    // P-8: ask_user_question — non-blocking clarification tool.
    // P-12 wires the question→answer flow via the `plan.answer`
    // session-action below; this registration is the model-facing tool.
    api.registerTool(createAskUserQuestionTool(), {
      name: "ask_user_question",
    });

    // P-12: session-actions — operator-side resolution surface.
    // /plan accept|reject|cancel|edit|answer + plan.auto.toggle. UI
    // clients dispatch these by (pluginId, actionId). Each handler
    // verifies the approvalId (stale-event guard), then calls the
    // PlanModeStore mutator + the appropriate injection-writer.
    const sessionActionRegistrations = createPlanModeSessionActions({
      api,
      store,
    });
    const sessionActionHandlers = new Map<
      string,
      (ctx: never) => unknown
    >();
    for (const action of sessionActionRegistrations) {
      api.session.controls.registerSessionAction(action);
      // Snapshot the handler for the /plan slash-command dispatcher
      // below. Keyed on the action id so /plan accept → plan.accept etc.
      sessionActionHandlers.set(
        action.id,
        action.handler as (ctx: never) => unknown,
      );
    }

    // Hotfix (2026-05-13): register `/plan` and `/plan-mode` slash
    // commands so users can resolve approvals from chat (not just
    // sidebar buttons). Approval subcommands route to the matching
    // session-action handler above; `/plan enter` flips state via the
    // store directly (no `plan.enter` session-action exists).
    api.registerCommand(
      createPlanSlashCommand({
        actions: sessionActionHandlers as never,
        store,
      }),
    );
    api.registerCommand(
      createPlanModeSlashCommand({
        actions: sessionActionHandlers as never,
        store,
      }),
    );

    // P-12: sidebar UI descriptor. Declares the "Plan Mode" surface so
    // operator UI clients can render the widget. Rendering is
    // host/client-side; the plugin owns data (via the session-extension
    // projection) + actions (the registrations above).
    api.session.controls.registerControlUiDescriptor(
      buildPlanModeSidebarDescriptor(),
    );

    // P-12: sweep CLI command — `openclaw plan-clear -s <sessionKey>`.
    // Operator rollback drain for sessions stuck in plan mode.
    api.registerCli(createPlanClearCli({ store }));

    // P-5: mutation gate (`before_tool_call` hook). Blocks mutating
    // tools when planMode === "plan". Algorithm is byte-identical to
    // the in-host gate at `src/agents/plan-mode/mutation-gate.ts`
    // (commit ea04ea52c7).
    //
    // Resolution path for the current plan-mode state:
    //
    //   1. ctx.getSessionExtension("plan-mode") — host's projection
    //      cache. Works once P-6 wires real persistence (the gateway
    //      then routes writes through `api.session.state.patchPluginSessionExtension`
    //      or whatever the canonical write seam ends up being).
    //   2. Fall back to the plugin's own PlanModeStore — works TODAY
    //      with the in-memory gateway. Same state until P-6.
    //
    // P-5 ships with the fallback so the gate actually fires during
    // Eva live-smoke #1. P-6 makes the host projection authoritative
    // and the fallback becomes a defense-in-depth path.
    //
    // `before_tool_call` does NOT require `allowConversationAccess`
    // (it operates on tool-name + params, not raw conversation
    // content). Confirmed at hook-types.d.ts; conversation-access
    // gating applies only to before_model_resolve, before_agent_run,
    // llm_input, llm_output, before_agent_reply, before_agent_finalize,
    // agent_end.
    api.on("before_tool_call", async (event, ctx) => {
      const ns = PLAN_MODE_SESSION_EXTENSION_NAMESPACE;
      // 1. Host projection.
      const fromHost = ctx.getSessionExtension?.(ns) as
        | {
            mode?: PlanMode;
            approval?: string;
            autoApprove?: boolean;
          }
        | undefined
        | null;
      // 2. Plugin's own store (authoritative until P-6).
      let mode: PlanMode = "normal";
      let approval: string | undefined;
      let autoApprove = false;
      if (fromHost?.mode) {
        mode = fromHost.mode;
        approval = fromHost.approval;
        autoApprove = fromHost.autoApprove === true;
      } else if (ctx.sessionKey) {
        const snap = await store.readSnapshot(ctx.sessionKey);
        if (snap?.mode) {
          mode = snap.mode;
          approval = snap.approval;
          autoApprove = snap.autoApprove === true;
        }
      }

      // Extract exec command for bash/exec checks. Look at common
      // param names; in-host uses `command` for both bash + exec.
      const params = event.params ?? {};
      const command =
        typeof params.command === "string"
          ? params.command
          : typeof params.cmd === "string"
            ? params.cmd
            : undefined;

      // Layer 1: plan-mode mutation gate (fail-CLOSED).
      // Fires when mode === "plan" — blocks mutations during plan
      // proposal/revision.
      if (mode === "plan") {
        const result = checkMutationGate(event.toolName, mode, command);
        if (result.blocked) {
          api.logger.info(
            `[smarter-claw] mutation gate blocked tool="${event.toolName}" sessionKey="${ctx.sessionKey ?? "?"}" — ${result.reason}`,
          );
          return { block: true, blockReason: result.reason };
        }
        // Pass-through: tool is allowed in plan mode.
        return undefined;
      }

      // Layer 2: accept-edits constraint gate (fail-OPEN).
      // Fires AFTER plan approval, when the agent is in the
      // post-approval execution phase with acceptEdits permission.
      //
      // **Surgical-port S12 (2026-05-12)**: the trigger predicate
      // matches in-host semantics at sessions-patch.ts:982-993:
      //   - action === "edit" → SETS postApprovalPermissions.acceptEdits=true
      //   - action === "approve" → EXPLICITLY CLEARS acceptEdits (verbatim
      //     execution; user did NOT opt into edits)
      //
      // So the gate fires ONLY when approval === "edited" (the plugin's
      // equivalent of in-host's postApprovalPermissions.acceptEdits=true).
      //
      // Prior plugin trigger was `autoApprove === true || approval === "edited"`
      // which over-fired on autoApprove (operator pre-toggled auto-mode).
      // The in-host autoApprove field is a separate runtime concept that
      // auto-resolves plan submission to action === "approve" (NOT to
      // "edit"), so an autoApprove session emits approval === "approved"
      // and should NOT trigger the gate. The over-fire was a UX regression
      // for operators who toggled autoApprove for convenience — they got
      // destructive-action blocks even when the agent was executing in
      // normal mode without an approval cycle.
      //
      // host_ref: gates/accept-edits-gate.ts (layer 2 algorithm; byte-identical)
      // host_ref: sessions-patch.ts:982-993 (acceptEdits set/clear lifecycle)
      // host_ref: pi-tools.before-tool-call.ts:324 (trigger predicate at
      //   `latestPlanMode === "normal" && getLatestAcceptEdits?.()`)
      const isAcceptEditsPhase = approval === "edited";
      if (!isAcceptEditsPhase) return undefined;

      // Extract filePath for write/edit/apply_patch tools.
      const filePath =
        typeof params.file_path === "string"
          ? params.file_path
          : typeof params.path === "string"
            ? params.path
            : typeof params.target === "string"
              ? params.target
              : undefined;
      // apply_patch carries multi-target paths inside its input envelope.
      const additionalPaths = extractApplyPatchTargetPaths(params.input);

      const aeResult = checkAcceptEditsConstraint({
        toolName: event.toolName,
        ...(command !== undefined ? { execCommand: command } : {}),
        ...(filePath !== undefined ? { filePath } : {}),
        ...(additionalPaths.length > 0 ? { additionalPaths } : {}),
      });
      if (aeResult.blocked) {
        api.logger.info(
          `[smarter-claw] accept-edits gate blocked tool="${event.toolName}" constraint=${aeResult.constraint ?? "?"} sessionKey="${ctx.sessionKey ?? "?"}"`,
        );
        return { block: true, blockReason: aeResult.reason };
      }
      return undefined;
    });

    // P-7: before_prompt_build hook — injects the plan-mode archetype
    // system-prompt fragment when planMode === "plan".
    //
    // REQUIRES `plugins.entries.smarter-claw.hooks.allowConversationAccess: true`
    // in operator config. before_prompt_build is in the conversation-
    // access list (docs/plugins/hooks.md:308-310); without the flag,
    // this hook silently no-ops.
    //
    // Output uses `appendSystemContext` (prompt-cached prefix) rather
    // than `prependContext` (per-turn token cost) so the archetype
    // bytes hash into the cache key and don't burn tokens on every
    // turn.
    //
    // Byte-identical parity: the appended fragment must match the
    // in-host inline injection at attempt.ts:702-732 (header + hard
    // rules + PLAN_ARCHETYPE_PROMPT). Tests pin this.
    //
    // P-8 will extend this with PLAN_MODE_REFERENCE_CARD + the
    // pendingAgentInjections drain queue (composePromptWithPendingInjections).
    // P-9: plan-tier model override. before_model_resolve hook —
    // REQUIRES allowConversationAccess (same as before_prompt_build).
    // When the operator has set `planTierModel`, route plan-mode turns
    // to that model. When not set, host's default resolves.
    if (config.planTierModel) {
      api.on("before_model_resolve", async (_event, ctx) => {
        const decision = await decidePlanTierModel(ctx.sessionKey, {
          store,
          planTierModel: config.planTierModel,
          ...(config.planTierProvider
            ? { planTierProvider: config.planTierProvider }
            : {}),
        });
        return decision;
      });
    }

    // P-10: escalating-retry detector. before_agent_finalize hook —
    // REQUIRES allowConversationAccess. When the agent's turn ends in
    // an "incomplete" state (chat without tool call in plan mode,
    // yield after approval, narration without action), return the
    // appropriate retry instruction so the SDK runs another model pass.
    //
    // The SDK enforces maxAttempts via the idempotencyKey we provide;
    // we cap at 3 retries per detector per session.
    //
    // host_ref: src/agents/pi-embedded-runner/run/incomplete-turn.ts
    //   semantic contract, not the algorithmic detail (the in-host's
    //   1070-LOC detection pipeline integrates with runner internals
    //   that the SDK abstracts away).
    api.on("before_agent_finalize", async (event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return undefined;
      const snap = await store.readSnapshot(sessionKey);
      const planMode = snap?.mode ?? "normal";
      // **W1-E6 (#102) — deferred; see docs/audits/parity-refresh/blocker-W1-E6.md.**
      //
      // The hook doesn't expose "did the turn make a tool call?"
      // directly. The original comment claimed `stopHookActive` IS
      // true during tool-call-using turns; that is **wrong** per
      // Claude Code's Stop-hook spec — `stop_hook_active` signals
      // hook re-entrancy (the Stop hook is being re-invoked), not
      // tool use. It is `false` on every normal first-pass turn
      // regardless of whether the turn called a tool. So this
      // derivation collapses tool-use and chat-only turns to the
      // same `madeToolCall = false`, which causes `decideEscalatingRetry`
      // to spuriously fire "you didn't act" retries on turns that
      // actually used tools.
      //
      // The fix requires an SDK change — either populate `messages`
      // on the event (currently declared `unknown[]` but never set)
      // OR add a `madeToolCall?: boolean` field plumbed from the codex
      // native-hook-relay. Investigated and written up in the blocker
      // doc above. Until that ships, the status quo proxy stays —
      // it over-fires on tool-using turns (the agent then redundantly
      // re-issues the same tool call), which wastes a turn but does
      // not break correctness. See the blocker doc for the alternative
      // of disabling `PLAN_YIELD` interim, and why we chose not to.
      const madeToolCall = event.stopHookActive === true;
      const isPostApproval =
        snap?.approval === "approved" || snap?.approval === "edited";
      const decision = decideEscalatingRetry(sessionKey, {
        planMode,
        lastAssistantMessage: event.lastAssistantMessage,
        madeToolCall,
        isPostApprovalTurn: isPostApproval,
      });
      if (!decision) return undefined;
      api.logger.info(
        `[smarter-claw] escalating-retry triggered (${decision.detector}) — sessionKey="${sessionKey}"`,
      );
      return {
        action: "revise" as const,
        reason: decision.detector,
        retry: {
          instruction: decision.instruction,
          idempotencyKey: decision.idempotencyKey,
          maxAttempts: decision.maxAttempts,
        },
      };
    });

    api.on("before_prompt_build", async (_event, ctx) => {
      // before_prompt_build's PluginHookAgentContext doesn't expose
      // getSessionExtension (that's on PluginHookToolContext only).
      // Read via the plugin's own store; P-6's SessionStoreGateway
      // routes through the same on-disk slot the host projection
      // reads, so this is consistent with the mutation gate's path.
      if (!ctx.sessionKey) return undefined;
      const snap = await store.readSnapshot(ctx.sessionKey);
      const mode: PlanMode = snap?.mode ?? "normal";
      if (mode === "plan") {
        return {
          appendSystemContext: buildPlanModeActiveSystemContext(),
        };
      }
      // Hotfix (2026-05-13): wire the in-host PLAN MODE AVAILABLE
      // branch (`attempt.ts:733-749`) so the agent knows it can call
      // `enter_plan_mode` when the user asks for a plan. Without
      // this, the plugin's tools were registered but the model had
      // no idea plan mode existed — explaining the live-test
      // observation "agent didn't enter plan mode when asked."
      // The plugin's presence implies the feature is enabled
      // (no operator opt-in flag — installing the plugin IS the
      // opt-in), so we always inject the AVAILABLE block when not
      // already in plan mode.
      return {
        appendSystemContext: buildPlanModeAvailableSystemContext(),
      };
    });

    // P-1 degraded-state warning. Logs on every new session start so
    // operators see the advisory in gateway logs even before later
    // PRs add user-visible surfacing. The advisory stops being relevant
    // once `allowConversationAccess: true` is set in operator config.
    //
    // `session_start` is a lifecycle event that fires WITHOUT
    // `allowConversationAccess` (docs/plugins/hooks.md:136-137).
    // Confirmed: PluginHookName at `node_modules/openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts:12`.
    api.on("session_start", (event, _ctx) => {
      // Only advise on brand-new sessions; idle/daily/restart events
      // are noise. Per docs reason values: new | reset | idle | daily |
      // compaction | deleted | shutdown | restart | unknown.
      const reason = (event as { reason?: string } | undefined)?.reason;
      if (reason !== "new") return undefined;
      api.logger.info(
        "[smarter-claw] new session opened — see advisory above",
      );
      // session_start return value is ignored. User-visible surfacing
      // lands at P-10 with the runtime self-check.
      return undefined;
    });

    api.logger.info(
      `[smarter-claw] registered v1-port skeleton — namespace="${PLAN_MODE_SESSION_EXTENSION_NAMESPACE}"`,
    );
    api.logger.info(`[smarter-claw] ${buildAdvisorySessionMessage()}`);

    // Chat-stream seam patch advisory: report whether the operator has
    // applied the tactical patch (`npm run patch:chat-stream-seam`) that
    // enables inline chat-stream UI surfaces. Fires once at register-time
    // (not per session) to keep log noise low.
    //
    // The patch is required for the v1.0 inline-UI experience. v0.x
    // sidebar UX works without it. The advisory ONLY informs; it does NOT
    // try to auto-apply (operator opt-in is the contract).
    //
    // Detection is best-effort: looks for the patcher sentinel at
    // `node_modules/openclaw/.smarter-claw-chat-stream-seam-applied.json`.
    // If the openclaw install path can't be resolved (e.g. unusual layout),
    // the advisory is skipped silently.
    api.logger.info(`[smarter-claw] ${buildChatStreamSeamAdvisory()}`);
  },
});

/**
 * Best-effort advisory for whether the chat-stream seam patch is applied
 * to the operator's installed openclaw. Reads a sentinel at
 * `node_modules/openclaw/.smarter-claw-chat-stream-seam-applied.json`.
 *
 * Behavior:
 *   - Sentinel present + parseable: "chat-stream seam patch applied (openclaw X, applied Y)"
 *   - Sentinel absent: "chat-stream seam patch not applied — run `npm run patch:chat-stream-seam` to enable inline UI (v1.0 surface). Sidebar UI works without the patch."
 *   - Detection fails (can't find openclaw): silent no-op (returns generic message)
 */
function buildChatStreamSeamAdvisory(): string {
  // Lazy-require fs to keep the plugin entry side-effect-free at import
  // time for tests + parity harness.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathModule = require("node:path") as typeof import("node:path");

  // Resolve openclaw install dir from this module's location.
  // The plugin imports `openclaw/plugin-sdk/...`, so Node has resolved
  // openclaw's package directory. We walk up from `require.resolve` if
  // available; otherwise fall back to relative path heuristic.
  let openclawDir: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = require("node:module").createRequire(import.meta.url) as NodeRequire;
    const openclawPkg = req.resolve("openclaw/package.json");
    openclawDir = pathModule.dirname(openclawPkg);
  } catch {
    return "chat-stream seam patch: could not detect openclaw install path (advisory skipped).";
  }

  const sentinelPath = pathModule.join(
    openclawDir,
    ".smarter-claw-chat-stream-seam-applied.json",
  );
  if (!fs.existsSync(sentinelPath)) {
    return (
      "chat-stream seam patch: NOT applied. Sidebar UI works as-is. " +
      "For v1.0 inline-UI surfaces, run `npm run patch:chat-stream-seam` (or `node scripts/install-chat-stream-seam.mjs --host=" +
      openclawDir +
      "`). Patch is reversible via `npm run patch:chat-stream-seam:uninstall`."
    );
  }
  try {
    const sentinel = JSON.parse(fs.readFileSync(sentinelPath, "utf8")) as {
      appliedAt?: string;
      openclawVersion?: string;
    };
    return `chat-stream seam patch: APPLIED (openclaw ${sentinel.openclawVersion ?? "?"}, ${sentinel.appliedAt ?? "?"}). Inline UI surfaces enabled.`;
  } catch (err) {
    return `chat-stream seam patch: sentinel present but unreadable (${(err as Error).message}).`;
  }
}

/**
 * Test-only exports. Internal API; not part of the plugin's public
 * surface. Used by tests/p1-skeleton.test.ts to exercise the warning
 * builder in isolation.
 */
export const __testing = {
  buildAdvisorySessionMessage,
  buildChatStreamSeamAdvisory,
  resolveConfig,
  DEFAULT_CONFIG,
};
