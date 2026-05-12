/**
 * Gateway-side listener that persists the live plan snapshot onto the
 * plan-mode session state after each `update_plan` tool call. Lets the
 * Control UI rebuild the live-plan sidebar after a hard refresh —
 * without this, `latestPlanMarkdown` lives only in in-memory `@state()`
 * and is lost on page reload.
 *
 * Design: subscribes to agent events with `stream === "plan"`, looks
 * up the run context (already populated by `update-plan-tool.ts` before
 * the emit), and writes the snapshot through the existing session-
 * store update seam so the write respects the same validation +
 * broadcast pipeline as user-initiated patches.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ INSTALLER SEAM:                                                 │
 * │                                                                 │
 * │ This module touches three host surfaces the Plugin SDK does     │
 * │ not yet expose:                                                 │
 * │                                                                 │
 * │   1. Agent event subscription (`onAgentEvent` filtered to       │
 * │      `stream === "plan"` / `stream === "approval"`).            │
 * │   2. Read of in-memory agent run context (the source of the     │
 * │      plan snapshot before it persists).                         │
 * │   3. Session-store write under a single lock that mirrors the   │
 * │      gateway's `applySessionsPatchToStore` validation surface.  │
 * │                                                                 │
 * │ The installer-side patch is responsible for injecting these     │
 * │ via the `SnapshotPersisterDeps` shape passed to                 │
 * │ `startPlanSnapshotPersister`. Until those seams are wired,      │
 * │ calling the start helper without `deps.subscribe` /             │
 * │ `deps.persistSnapshot` returns a no-op shutdown handle so       │
 * │ the plugin can still load and run its other surfaces.           │
 * └─────────────────────────────────────────────────────────────────┘
 */

import { logPlanModeDebug } from "./debug-log.js";
import { appendToInjectionQueue, type PendingAgentInjectionEntry } from "./injections.js";

// ---------------------------------------------------------------------------
// Loose host-event shapes — kept generic so this module doesn't constrain
// on the host's exact AgentEvent type. The installer-side adapter is
// expected to pass through events whose `stream` and `data` fields match
// these shapes; out-of-band events are safely ignored by the predicates.
// ---------------------------------------------------------------------------

export interface PlanEventLike {
  stream: "plan" | "approval" | string;
  sessionKey?: string;
  runId: string;
  data?: unknown;
}

export interface PlanSnapshotStep {
  step: string;
  status: string;
  activeForm?: string;
  acceptanceCriteria?: string[];
  verifiedCriteria?: string[];
}

/**
 * Loose injectable surface — the installer wires these to the host
 * gateway. The persister is otherwise pure logic: receive an event,
 * decide what to persist, hand the patch to the host writer.
 */
export interface SnapshotPersisterDeps {
  /**
   * Subscribe to agent events. Must invoke `handler` for every event
   * the persister cares about (typically `stream === "plan"` or
   * `stream === "approval"`). Returns an unsubscribe function.
   */
  subscribe: (handler: (evt: PlanEventLike) => void) => () => void;
  /**
   * Read the plan snapshot for an in-flight run. The host's
   * `update_plan` tool emit populates this before firing the
   * agent event; the persister reads it back to write the snapshot
   * onto the session.
   */
  getRunPlanSnapshot: (runId: string) => readonly PlanSnapshotStep[] | undefined;
  /**
   * Persist a snapshot patch onto the named session. The installer
   * implements this by routing through the gateway's `sessions.patch`
   * pipeline (so wire-schema validation, state-machine guards, and
   * downstream broadcast all run as if a user had patched).
   *
   * `closeOnComplete` instructs the host to also flip the session out
   * of plan mode in the same write, when the supplied snapshot has
   * every step in a terminal status AND the host's pre-flight check
   * confirms an approved/edited cycle (or recently-approved post-
   * deletion grace window). When the host suppresses the close, it
   * still persists the snapshot.
   */
  persistSnapshot: (params: {
    sessionKey: string;
    snapshot: readonly PlanSnapshotStep[];
    closeOnComplete: boolean;
  }) => Promise<{ closed: boolean }>;
  /**
   * Persist the approval metadata (title + parent runId + approvalId)
   * onto the session's plan-mode state when an `exit_plan_mode`
   * approval event is observed. Optional — when omitted, the persister
   * skips this branch.
   */
  persistApprovalMetadata?: (params: {
    sessionKey: string;
    title: string;
    approvalRunId: string;
    approvalId?: string;
  }) => Promise<void>;
  /**
   * Persist a fresh `pendingQuestionApprovalId` so the gateway's
   * `/plan answer` patch handler can validate the incoming approvalId.
   * Optional — when omitted, the persister skips question-approval
   * persistence (the answer-validation path then rejects with "no
   * pending question").
   */
  persistPendingQuestionApprovalId?: (params: {
    sessionKey: string;
    approvalId: string;
    questionId?: string;
    title: string;
    prompt: string;
    options: string[];
    allowFreetext: boolean;
  }) => Promise<void>;
  /**
   * Mirror the session-state flip into in-memory run context so
   * concurrent / subsequent `sessions_spawn` calls in this session
   * see the cleared state immediately (no session-store re-read on
   * the spawn hot path). Optional.
   */
  clearInPlanModeForSession?: (sessionKey: string) => void;
  /**
   * Append a `[PLAN_COMPLETE]` injection onto the named session's
   * pending-injection queue. Optional — when omitted, the persister
   * uses the in-memory append (this module's own `appendToInjection
   * Queue`) against a host-supplied state object via
   * `enqueueInjection`.
   */
  enqueueInjection?: (params: {
    sessionKey: string;
    entry: PendingAgentInjectionEntry;
  }) => Promise<void>;
  /**
   * Optional notifier — fires after each successful persistSnapshot
   * write so the host can broadcast a sessions-changed event to
   * connected UIs.
   */
  emitSessionsChanged?: (opts: { sessionKey: string; reason: string }) => void;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

/**
 * Start the persister. Returns a shutdown handle that unsubscribes
 * from the host event stream when called.
 *
 * When the installer-side wiring isn't ready (no `subscribe` or no
 * `persistSnapshot`), returns a no-op handle so the plugin can still
 * load — the persister simply doesn't fire until the seam lands.
 */
export function startPlanSnapshotPersister(deps: SnapshotPersisterDeps): () => void {
  if (!deps.subscribe || !deps.persistSnapshot) {
    deps.log?.warn?.(
      "snapshot-persister: subscribe + persistSnapshot deps required to fire. Returning no-op shutdown handle.",
    );
    return () => {};
  }
  const log = deps.log;
  const unsubscribe = deps.subscribe((evt) => {
    if (evt.stream === "approval") {
      handleApprovalEvent(evt, deps).catch((err) => {
        log?.warn?.(
          `snapshot-persister: approval-event handler failed runId=${evt.runId}: ${String(err)}`,
        );
      });
      return;
    }
    if (evt.stream !== "plan") {
      return;
    }
    handlePlanEvent(evt, deps).catch((err) => {
      log?.warn?.(
        `snapshot-persister: plan-event handler failed runId=${evt.runId}: ${String(err)}`,
      );
    });
  });
  return unsubscribe;
}

async function handleApprovalEvent(
  evt: PlanEventLike,
  deps: SnapshotPersisterDeps,
): Promise<void> {
  const sessionKey = evt.sessionKey;
  if (!sessionKey) {
    return;
  }
  const data = evt.data as Record<string, unknown> | undefined;
  if (!data) {
    return;
  }
  // Only fire on the request phase of plan submissions (kind="plugin"
  // means tool-driven, the title field is set, and we have an
  // approvalId to track). Updates / completions don't carry a fresh
  // title; skip them. Accept BOTH `phase: "requested"` and `phase:
  // "request"` since the legacy emitter shape used both.
  const phase = typeof data.phase === "string" ? data.phase : undefined;
  const kind = typeof data.kind === "string" ? data.kind : undefined;
  const title = typeof data.title === "string" ? data.title : undefined;
  const approvalId = typeof data.approvalId === "string" ? data.approvalId : undefined;
  // The `ask_user_question` tool emits the same `kind: "plugin"`
  // approval shape as `exit_plan_mode`, with `title: "Agent has a
  // question"` and `plan: []` (empty array). To distinguish: also
  // require a NON-EMPTY `plan` array, and explicitly exclude any
  // payload with `question` set.
  const hasQuestionShape = Boolean(
    data && typeof data === "object" && "question" in data && (data as { question?: unknown }).question,
  );
  const planArray = Array.isArray(data.plan) ? data.plan : null;
  const isPlanSubmission =
    (phase === "requested" || phase === "request") &&
    kind === "plugin" &&
    title !== undefined &&
    title.length > 0 &&
    planArray !== null &&
    planArray.length > 0 &&
    !hasQuestionShape;
  const isQuestionSubmission =
    (phase === "requested" || phase === "request") &&
    kind === "plugin" &&
    hasQuestionShape &&
    typeof approvalId === "string" &&
    approvalId.length > 0;

  if (isQuestionSubmission && deps.persistPendingQuestionApprovalId) {
    const questionData =
      data && typeof data === "object" && "question" in data
        ? ((data as { question?: unknown }).question as Record<string, unknown> | undefined)
        : undefined;
    const optionsRaw = questionData?.options;
    const persistedOptions = Array.isArray(optionsRaw)
      ? optionsRaw.filter((o): o is string => typeof o === "string")
      : [];
    const persistedAllowFreetext =
      typeof questionData?.allowFreetext === "boolean" ? questionData.allowFreetext : false;
    const persistedQuestionId =
      typeof questionData?.questionId === "string" ? questionData.questionId : undefined;
    const questionPrompt = typeof questionData?.prompt === "string" ? questionData.prompt : "";
    const titleText = typeof data.title === "string" ? data.title : "Agent has a question";
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey,
      tool: "ask_user_question",
      runId: evt.runId,
      details: {
        approvalId,
        optionCount: persistedOptions.length,
        allowFreetext: persistedAllowFreetext,
      },
    });
    await deps.persistPendingQuestionApprovalId({
      sessionKey,
      approvalId: approvalId!,
      ...(persistedQuestionId ? { questionId: persistedQuestionId } : {}),
      title: titleText,
      prompt: questionPrompt,
      options: persistedOptions,
      allowFreetext: persistedAllowFreetext,
    });
    deps.emitSessionsChanged?.({
      sessionKey,
      reason: "pending_question_approval_id_persist",
    });
    return;
  }
  if (!isPlanSubmission || !deps.persistApprovalMetadata) {
    return;
  }
  // Defensive guard against silent bypass when the approvalRunId is
  // empty/missing. Without this guard, the write would silently
  // succeed with an empty `approvalRunId`, later breaking the
  // approval-side subagent gate that reads this field via
  // `getAgentRunContext(approvalRunId)`. Throwing here surfaces the
  // gap immediately so the caller's catch logs it.
  if (!evt.runId || evt.runId.trim().length === 0) {
    throw new Error(
      `snapshot-persister: approvalRunId is required (got: ${JSON.stringify(evt.runId)}). Without it the approval-side subagent gate cannot look up parent-run state, silently bypassing the concurrency check.`,
    );
  }
  logPlanModeDebug({
    kind: "tool_call",
    sessionKey,
    tool: "exit_plan_mode",
    runId: evt.runId,
    details: { title, approvalId },
  });
  await deps.persistApprovalMetadata({
    sessionKey,
    title: title!,
    approvalRunId: evt.runId,
    ...(approvalId ? { approvalId } : {}),
  });
  deps.emitSessionsChanged?.({
    sessionKey,
    reason: "plan_approval_metadata_persist",
  });
}

async function handlePlanEvent(evt: PlanEventLike, deps: SnapshotPersisterDeps): Promise<void> {
  const sessionKey = evt.sessionKey;
  if (!sessionKey) {
    return;
  }
  const snapshot = deps.getRunPlanSnapshot(evt.runId);
  if (!snapshot || snapshot.length === 0) {
    return;
  }
  // When the plan-event phase is "completed", request close-on-
  // complete in the same patch. The agent doesn't need to call
  // exit_plan_mode separately — completion is structural. Mutations
  // were already unlocked by the prior approval; this ensures the
  // session-state and UI reflect the closed plan.
  const phase =
    evt.data && typeof evt.data === "object" && "phase" in evt.data
      ? (evt.data as { phase?: unknown }).phase
      : undefined;
  const closeOnComplete = phase === "completed";
  // Normalize the snapshot's status field into the closed enum the
  // host wire-schema expects. Map unrecognized/legacy status values
  // to "cancelled" so the close-on-complete logic doesn't false-
  // positive on them, but still surfaces them in the rendered plan.
  const normalizedSnapshot: PlanSnapshotStep[] = snapshot.map((s) => ({
    step: s.step,
    status: ((): "pending" | "in_progress" | "completed" | "cancelled" => {
      switch (s.status) {
        case "pending":
        case "in_progress":
        case "completed":
        case "cancelled":
          return s.status;
        default:
          return "cancelled";
      }
    })(),
    ...(s.activeForm !== undefined ? { activeForm: s.activeForm } : {}),
    ...(s.acceptanceCriteria !== undefined ? { acceptanceCriteria: s.acceptanceCriteria } : {}),
    ...(s.verifiedCriteria !== undefined ? { verifiedCriteria: s.verifiedCriteria } : {}),
  }));

  const completionStepCount = normalizedSnapshot.length;
  const result = await deps.persistSnapshot({
    sessionKey,
    snapshot: normalizedSnapshot,
    closeOnComplete,
  });
  if (closeOnComplete && result.closed) {
    deps.clearInPlanModeForSession?.(sessionKey);
    deps.log?.info?.(
      `plan completed → planMode auto-flipped to normal: sessionKey=${sessionKey}`,
    );
    // Emit a `[PLAN_COMPLETE]` injection so the agent's NEXT turn
    // explicitly knows the plan is done (and can summarize what was
    // accomplished). The agent prompt contract is "if you see
    // [PLAN_COMPLETE]: <title> — <N>/<M> steps, post a brief summary
    // of what was done and stop". Without this, the agent has no
    // signal that the plan auto-closed and may keep churning.
    if (deps.enqueueInjection) {
      try {
        const completionInjectionText = `[PLAN_COMPLETE]: ${completionStepCount} step${
          completionStepCount === 1 ? "" : "s"
        } completed. Post a brief summary of what was done and stop. The plan has been auto-closed; the user can start a new plan cycle if needed.`;
        await deps.enqueueInjection({
          sessionKey,
          entry: {
            id: `plan-complete-${sessionKey}-${Date.now()}`,
            kind: "plan_complete",
            text: completionInjectionText,
            createdAt: Date.now(),
          },
        });
      } catch (err) {
        deps.log?.warn?.(
          `[PLAN_COMPLETE] injection write failed: sessionKey=${sessionKey} err=${String(err)}`,
        );
      }
    }
  } else if (closeOnComplete && !result.closed) {
    deps.log?.info?.(
      `plan completed but auto-close suppressed (no approved state): sessionKey=${sessionKey} — agent must call exit_plan_mode for explicit user approval before mutations unlock`,
    );
  }
  deps.emitSessionsChanged?.({ sessionKey, reason: "patch" });
}

/**
 * Pure helper exported for the installer-side patch. Given a snapshot
 * + the current session state, decides whether the auto-close branch
 * should fire (or whether the host should suppress the close because
 * there's no approved cycle). The host's own pre-flight check is the
 * source of truth; this helper centralizes the predicate logic so
 * installer-side wiring stays declarative.
 *
 * Returns `true` when the close is safe to apply.
 */
export function shouldAutoClosePlan(state: {
  approval?: string;
  cycleId?: string;
  recentlyApprovedAt?: number;
  recentlyApprovedCycleId?: string;
}): boolean {
  const isRecentlyApproved =
    typeof state.recentlyApprovedAt === "number" &&
    Date.now() - state.recentlyApprovedAt < 5 * 60_000;
  if (state.approval === "pending") {
    return false;
  }
  if (state.approval === "approved" || state.approval === "edited") {
    return true;
  }
  // Post-deletion grace window: planMode is entirely missing (prior
  // close deleted it) but `recentlyApprovedAt` survives at root for
  // the 5-minute window. The runtime emitted a late completion event
  // after the close — accept the close as the structural answer. No
  // new cycle has started, so there's no fresh approval state to
  // violate.
  if (
    state.approval === undefined &&
    isRecentlyApproved &&
    state.recentlyApprovedCycleId &&
    !state.cycleId
  ) {
    return true;
  }
  return false;
}

// Re-export the in-memory injection helper so installer wiring can pass
// the same routine to `deps.enqueueInjection` if it stores state via the
// plugin's own session-state slot rather than a host-side queue.
export { appendToInjectionQueue };
