/**
 * PlanModeStore — typed state mutators for the plan-mode session-extension.
 *
 * **Parity contract**: this module encodes the 10 co-located invariants
 * of the in-host `persistPlanApprovalRequest` at
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237`
 * (commit `ea04ea52c7`, the empty-plan-body race-fix anchor `1081067476`).
 *
 * Per `architecture-v2/09-AMENDMENT_1_VERIFICATION.md`, those invariants
 * are:
 *   1. Sync bundle write of approvalId + lastPlanSteps + title + payloadHash
 *   2. mode === "plan" precondition guard (returns null → no write)
 *   3. Payload-hash idempotency (reuse approvalId on hash-match cycle)
 *   4. Audit-event emission via logPlanModeApprovalTransition
 *   5. Atomic lock-around-the-read+update (encapsulated by the gateway)
 *   6. Fresh-read inside the lock (encapsulated by the gateway)
 *   7. 4-conjoined-condition idempotency decomposition
 *   8. Try/catch IO-error swallow — returns candidate approvalId anyway
 *   9. Deliberate audit-skip on the reuse path
 *  10. Lazy-imports (N/A here — plugin is self-contained; preserved as
 *      a discipline note for future state-module extensions)
 *
 * Architecture-v2/02 selected Option C (Hybrid): single namespace owned
 * by this store, decomposed feature surfaces consume the store's typed
 * API. State mutations route ONLY through this store — no free-form
 * write paths.
 *
 * # Why a gateway interface
 *
 * The in-host writes via `updateSessionStoreEntry({ storePath,
 * sessionKey, update })`. The plugin SDK's equivalent (whatever it
 * turns out to be at P-6 — `api.runtime.session.update`, gateway RPC
 * `sessions.pluginPatch`, or future `api.session.state.patch`) is
 * abstracted behind `PlanModeStateGateway`. Tests use an in-memory
 * gateway; P-6 wires the real seam. This keeps P-3 unblocked from
 * SDK-spelunking and makes the 10-invariant logic testable in
 * isolation.
 */

import { resolvePlanApproval } from "../plan-mode/approval.js";
import type { PlanModeSessionState, PlanStep } from "../types.js";
import {
  CURRENT_SCHEMA_VERSION,
  readSchemaVersion,
  stampSchemaVersion,
} from "./schema-version.js";

/**
 * Gateway for atomic read+update of plan-mode state.
 *
 * Encapsulates invariants 5 (atomic lock) and 6 (fresh-read inside
 * the lock). The gateway impl is responsible for:
 *   - Acquiring a per-sessionKey lock BEFORE calling `update(current)`
 *   - Reading `current` AFTER the lock acquires (fresh, not cached)
 *   - If `update` returns `{next: ...}`, writing those fields atomically
 *   - If `update` returns `{next: null}`, NO write (skipped path)
 *   - Releasing the lock AFTER the write (or skip)
 *
 * Invariant 5+6 violations would re-introduce the empty-plan-body race.
 */
export interface PlanModeStateGateway {
  /**
   * Atomic read-then-conditionally-update.
   *
   * @param sessionKey — the session whose plan-mode state is being mutated.
   * @param update — callback receiving the FRESH current state (or undefined
   *   if the session has no plan-mode payload yet). Must return one of:
   *   - `{ next: PlanModeSessionState }` to write atomically
   *   - `{ next: null }` to skip writing (idempotency path)
   *   - And optionally a `transition` object capturing the prev/next
   *     pair for audit emission (handled outside the gateway).
   */
  withLock<TTransition>(
    sessionKey: string,
    update: (current: PlanModeSessionState | undefined) => Promise<{
      next: PlanModeSessionState | null;
      transition?: TTransition;
    }>,
  ): Promise<{ transition?: TTransition }>;
}

/**
 * Optional audit emitter. Mirrors the in-host
 * `logPlanModeApprovalTransition` callsite. Called ONLY on the persist
 * path; deliberately SKIPPED on the reuse path (in-host comment at
 * line 202: "Skip the approval_transition event too since nothing
 * transitioned").
 *
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:222-227
 */
export type AuditEmitter = (event: {
  sessionKey: string;
  prev: PlanModeSessionState | undefined;
  next: PlanModeSessionState;
  source: string;
}) => void;

/**
 * Optional logger. Matches the SDK's PluginLogger.warn shape.
 */
export interface StoreLogger {
  warn?: (message: string) => void;
  info?: (message: string) => void;
  debug?: (message: string) => void;
}

/**
 * Input to `persistApprovalRequest`. Required: approvalId (candidate),
 * sessionKey. Optional: title, payloadHash, lastPlanSteps.
 *
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:132-149
 */
export interface PersistApprovalRequestInput {
  sessionKey: string;
  /** Candidate approvalId minted by `newPlanApprovalId()` upstream. */
  approvalId: string;
  /** Plan title — persisted synchronously per the race-fix invariant. */
  title?: string;
  /**
   * Plan payload hash — used for invariant 3 + 7 (idempotency match).
   * Compute via `computePlanPayloadHash` from helpers/payload-hash.ts.
   */
  payloadHash?: string;
  /** Plan steps — persisted synchronously per the race-fix invariant. */
  lastPlanSteps?: PlanStep[];
}

/**
 * Discriminated-union result of `persistApprovalRequest`. The shape is
 * part of the caller-contract: callers (P-4 exit_plan_mode tool) read
 * `kind` to decide whether to emit a duplicate-detected warning, and
 * `approvalId` to bind the UI's approval card.
 *
 * host_ref: caller-contract at
 *   src/agents/pi-embedded-subscribe.handlers.tools.ts:1881-1886
 *   (uses the `reused` flag from the returned object to emit warning)
 */
export type PersistApprovalRequestResult =
  | {
      /** Fresh write happened. Audit event emitted. */
      kind: "persisted";
      approvalId: string;
    }
  | {
      /** Hash matched existing pending cycle; existing approvalId reused.
       *  Audit event was DELIBERATELY SKIPPED (invariant 9). */
      kind: "reused";
      approvalId: string;
    }
  | {
      /** Precondition failed (mode !== "plan" or missing required
       *  fields). No write, no audit. Caller may proceed with candidate
       *  approvalId or treat as a soft no-op. */
      kind: "skipped";
      reason: "not-plan-mode" | "missing-fields";
      approvalId: string;
    }
  | {
      /** IO error during write. Per invariant 8: returns candidate
       *  approvalId so caller can proceed; logs warning; does NOT throw. */
      kind: "failed";
      error: Error;
      approvalId: string;
    };

/**
 * The PlanModeStore. Owns ALL state mutations for the "plan-mode"
 * session-extension namespace.
 *
 * Construction: pass a gateway impl + optional logger + optional audit
 * emitter. Tests use an in-memory gateway; production wires the SDK
 * seam at P-6.
 */
export class PlanModeStore {
  constructor(
    private readonly gateway: PlanModeStateGateway,
    private readonly logger?: StoreLogger,
    private readonly audit?: AuditEmitter,
  ) {}

  /**
   * Persist a plan-approval-pending state on the session.
   *
   * Encodes invariants 1-9 (10 is N/A here — see module-level docstring).
   *
   * @example
   *   const result = await store.persistApprovalRequest({
   *     sessionKey: "agent:main:main",
   *     approvalId: newPlanApprovalId(),
   *     title: "Bump deps",
   *     payloadHash: computePlanPayloadHash({title, summary, steps}),
   *     lastPlanSteps: steps,
   *   });
   *   if (result.kind === "reused") {
   *     log.warn(`exit_plan_mode duplicate detected; reused ${result.approvalId}`);
   *   }
   *   // Use result.approvalId for downstream UI binding (works for all 4 kinds).
   */
  async persistApprovalRequest(
    input: PersistApprovalRequestInput,
  ): Promise<PersistApprovalRequestResult> {
    const { sessionKey, approvalId, title, payloadHash, lastPlanSteps } = input;

    // Invariant 5+6 (encapsulated in gateway.withLock): lock acquires
    // BEFORE the read; fresh-read inside the lock; write atomic with
    // read.
    let txResult: PersistApprovalRequestResult;
    try {
      const { transition } = await this.gateway.withLock<{
        prev: PlanModeSessionState | undefined;
        next: PlanModeSessionState;
      }>(sessionKey, async (current) => {
        // Invariant 2: mode === "plan" precondition guard.
        if (!current || current.mode !== "plan") {
          txResult = {
            kind: "skipped",
            reason: "not-plan-mode",
            approvalId,
          };
          return { next: null };
        }

        // Invariant 3+7: 4-conjoined-condition idempotency guard.
        // ALL FOUR must hold to reuse — partial match falls through to
        // the rotate path. The conjunction is load-bearing: a 3-of-4
        // match would either re-emit a stale approvalId (false-reuse)
        // or rotate when we should preserve (false-overwrite, the
        // orphan-card regression Eva surfaced 2026-04-28).
        const hashMatch =
          payloadHash !== undefined &&
          current.lastPlanPayloadHash === payloadHash;
        const stillPending = current.approval === "pending";
        const hasApprovalId =
          typeof current.approvalId === "string" && current.approvalId.length > 0;
        if (hashMatch && stillPending && hasApprovalId) {
          // Invariant 9: deliberate audit-skip on reuse. No transition
          // object → no audit event downstream.
          txResult = {
            kind: "reused",
            approvalId: current.approvalId as string,
          };
          return { next: null };
        }

        // Invariant 1: sync bundle write of approvalId + title +
        // payloadHash + lastPlanSteps. ALL the race-fix-critical
        // fields land in a single update so the sessions-patch.ts
        // equivalent (P-6) reads the populated steps when the user
        // approves fast.
        const now = Date.now();
        const next: PlanModeSessionState = {
          ...current,
          approval: "pending",
          approvalId,
          updatedAt: now,
          ...(title !== undefined && title !== "" ? { title } : {}),
          ...(payloadHash !== undefined && payloadHash !== ""
            ? { lastPlanPayloadHash: payloadHash }
            : {}),
          ...(lastPlanSteps && lastPlanSteps.length > 0
            ? { lastPlanSteps }
            : {}),
        };
        txResult = {
          kind: "persisted",
          approvalId,
        };
        return {
          // Stamp schema version on every successful write.
          next: stampSchemaVersion(next) as PlanModeSessionState,
          transition: { prev: current, next },
        };
      });

      // Invariant 4: audit emission ONLY on the persist path (invariant 9
      // excludes reuse + skip + failed paths).
      if (transition && this.audit) {
        this.audit({
          sessionKey,
          prev: transition.prev,
          next: transition.next,
          source: "smarter-claw:PlanModeStore.persistApprovalRequest",
        });
      }

      // The `txResult` is assigned in every branch above. The TS
      // analyzer can't prove it, so assert non-null here. Behavior:
      // if a future refactor leaves it unassigned, the throw fires
      // loud and we know to add the missing branch.
      if (!txResult!) {
        throw new Error(
          "PlanModeStore.persistApprovalRequest: txResult not assigned — refactor bug",
        );
      }
      return txResult;
    } catch (err) {
      // Invariant 8: IO-error fail-soft. Log + return candidate
      // approvalId so the caller proceeds. NEVER throws.
      const wrapped =
        err instanceof Error ? err : new Error(String(err));
      this.logger?.warn?.(
        `PlanModeStore.persistApprovalRequest: failed to persist (sessionKey=${sessionKey}): ${wrapped.message}`,
      );
      return { kind: "failed", error: wrapped, approvalId };
    }
  }

  /**
   * Transition the session INTO plan mode.
   *
   * Idempotent: if the session is already in plan mode, returns a
   * `noop` outcome without writing. Else writes the fresh plan-mode
   * payload (mode=plan, approval=none, rejectionCount=0, enteredAt=now).
   *
   * host_ref: src/agents/tools/enter-plan-mode-tool.ts (the tool surface)
   *   + the runtime's session-state transition wired in
   *   pi-embedded-runner/run.ts (the actual write — we encode the
   *   write logic here directly since the plugin owns the state).
   */
  async enterPlanMode(input: {
    sessionKey: string;
    reason?: string;
  }): Promise<
    | { kind: "entered"; state: PlanModeSessionState }
    | { kind: "noop"; state: PlanModeSessionState }
    | { kind: "failed"; error: Error }
  > {
    const { sessionKey, reason } = input;
    try {
      let outcome:
        | { kind: "entered"; state: PlanModeSessionState }
        | { kind: "noop"; state: PlanModeSessionState };

      const { transition } = await this.gateway.withLock<{
        prev: PlanModeSessionState | undefined;
        next: PlanModeSessionState;
      }>(sessionKey, async (current) => {
        // Idempotent: already in plan mode.
        if (current && current.mode === "plan") {
          outcome = { kind: "noop", state: current };
          return { next: null };
        }
        const now = Date.now();
        const next: PlanModeSessionState = {
          ...(current ?? {}),
          mode: "plan",
          approval: "none",
          rejectionCount: current?.rejectionCount ?? 0,
          enteredAt: now,
          updatedAt: now,
          // Reason is not persisted on the state (it's a one-shot tool
          // arg used in the event payload). Reserved for future telemetry.
          ...(reason && reason.length > 0 ? {} : {}),
        };
        outcome = { kind: "entered", state: next };
        return {
          next: stampSchemaVersion(next) as PlanModeSessionState,
          transition: { prev: current, next },
        };
      });

      if (transition && this.audit) {
        this.audit({
          sessionKey,
          prev: transition.prev,
          next: transition.next,
          source: "smarter-claw:PlanModeStore.enterPlanMode",
        });
      }
      return outcome!;
    } catch (err) {
      const wrapped =
        err instanceof Error ? err : new Error(String(err));
      this.logger?.warn?.(
        `PlanModeStore.enterPlanMode: failed to persist (sessionKey=${sessionKey}): ${wrapped.message}`,
      );
      return { kind: "failed", error: wrapped };
    }
  }

  /**
   * Transition the session OUT of plan mode. Clears the approval-pending
   * payload (approvalId, lastPlanSteps, lastPlanPayloadHash) so a future
   * enterPlanMode starts clean.
   *
   * Idempotent: if the session is already in normal mode, returns `noop`.
   *
   * host_ref: src/agents/tools/exit-plan-mode-tool.ts (the tool surface).
   *   In-host the state-transition is wired in the runner; we encode it
   *   in the store directly.
   */
  async exitPlanMode(input: { sessionKey: string }): Promise<
    | { kind: "exited"; state: PlanModeSessionState }
    | { kind: "noop"; state: PlanModeSessionState | undefined }
    | { kind: "failed"; error: Error }
  > {
    const { sessionKey } = input;
    try {
      let outcome:
        | { kind: "exited"; state: PlanModeSessionState }
        | { kind: "noop"; state: PlanModeSessionState | undefined };

      const { transition } = await this.gateway.withLock<{
        prev: PlanModeSessionState | undefined;
        next: PlanModeSessionState;
      }>(sessionKey, async (current) => {
        // Idempotent: no payload, or already in normal mode.
        if (!current || current.mode === "normal") {
          outcome = { kind: "noop", state: current };
          return { next: null };
        }
        const now = Date.now();
        // Clear plan-mode-specific fields; preserve enteredAt only for
        // post-mortem (the next enterPlanMode resets it).
        const next: PlanModeSessionState = {
          mode: "normal",
          approval: "none",
          rejectionCount: 0,
          updatedAt: now,
          // approvalId / title / lastPlanSteps / lastPlanPayloadHash /
          // approvalRunId / feedback all deliberately OMITTED.
        };
        outcome = { kind: "exited", state: next };
        return {
          next: stampSchemaVersion(next) as PlanModeSessionState,
          transition: { prev: current, next },
        };
      });

      if (transition && this.audit) {
        this.audit({
          sessionKey,
          prev: transition.prev,
          next: transition.next,
          source: "smarter-claw:PlanModeStore.exitPlanMode",
        });
      }
      return outcome!;
    } catch (err) {
      const wrapped =
        err instanceof Error ? err : new Error(String(err));
      this.logger?.warn?.(
        `PlanModeStore.exitPlanMode: failed to persist (sessionKey=${sessionKey}): ${wrapped.message}`,
      );
      return { kind: "failed", error: wrapped };
    }
  }

  /**
   * Record a plan-approval rejection.
   *
   * Delegates to `resolvePlanApproval(action: "reject")` for byte-identical
   * parity with the in-host state machine. Returns the discriminated-union
   * result expected by `session-actions.plan.reject`.
   *
   * host_ref: src/agents/plan-mode/approval.ts:resolvePlanApproval
   *   (commit ea04ea52c7). The surgical port at src/plan-mode/approval.ts
   *   is byte-identical with import-path adaptation only.
   */
  async recordRejection(input: {
    sessionKey: string;
    feedback?: string;
    /**
     * Optional version token from the approval event. Forwarded to
     * `resolvePlanApproval`'s stale-event guard — a mismatch with the
     * session's current `approvalId` no-ops the action. Wave-1 finding
     * W1-C1: without this, the re-ported guard was dead code.
     */
    expectedApprovalId?: string;
  }): Promise<
    | { kind: "recorded"; rejectionCount: number; state: PlanModeSessionState }
    | { kind: "skipped"; reason: "not-plan-mode" | "no-pending-approval" }
    | { kind: "failed"; error: Error }
  > {
    const result = await this.applyApprovalAction({
      sessionKey: input.sessionKey,
      action: "reject",
      ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
      ...(input.expectedApprovalId !== undefined
        ? { expectedApprovalId: input.expectedApprovalId }
        : {}),
    });
    if (result.kind === "recorded") {
      return {
        kind: "recorded",
        rejectionCount: result.state.rejectionCount,
        state: result.state,
      };
    }
    return result;
  }

  /**
   * Record a plan-approval acceptance.
   *
   * Delegates to `resolvePlanApproval(action: "approve" | "edit")` for
   * byte-identical parity with the in-host state machine. Both approve
   * and edit transition mode → "normal", clear feedback, and reset
   * `rejectionCount` to 0 (the user is moving forward; cycle history
   * is no longer relevant).
   *
   * host_ref: src/agents/plan-mode/approval.ts:resolvePlanApproval
   *   (commit ea04ea52c7).
   */
  async recordApproval(input: {
    sessionKey: string;
    edited?: boolean;
    /**
     * Optional version token from the approval event — see
     * `recordRejection`. Wave-1 finding W1-C1.
     */
    expectedApprovalId?: string;
  }): Promise<
    | { kind: "recorded"; approval: "approved" | "edited"; state: PlanModeSessionState }
    | { kind: "skipped"; reason: "not-plan-mode" | "no-pending-approval" }
    | { kind: "failed"; error: Error }
  > {
    const action: "approve" | "edit" = input.edited ? "edit" : "approve";
    const result = await this.applyApprovalAction({
      sessionKey: input.sessionKey,
      action,
      ...(input.expectedApprovalId !== undefined
        ? { expectedApprovalId: input.expectedApprovalId }
        : {}),
    });
    if (result.kind === "recorded") {
      return {
        kind: "recorded",
        approval: action === "edit" ? "edited" : "approved",
        state: result.state,
      };
    }
    return result;
  }

  /**
   * Record a plan-approval timeout.
   *
   * Delegates to `resolvePlanApproval(action: "timeout")` for parity with
   * the in-host state machine. Timeout only applies on `approval ===
   * "pending"`; any other state is a no-op (returns `skipped`).
   *
   * host_ref: src/agents/plan-mode/approval.ts:resolvePlanApproval
   *   (commit ea04ea52c7).
   */
  async recordTimeout(input: {
    sessionKey: string;
    /**
     * Optional version token from the approval event — see
     * `recordRejection`. Wave-1 finding W1-C1.
     */
    expectedApprovalId?: string;
  }): Promise<
    | { kind: "recorded"; state: PlanModeSessionState }
    | { kind: "skipped"; reason: "not-plan-mode" | "no-pending-approval" }
    | { kind: "failed"; error: Error }
  > {
    return this.applyApprovalAction({
      sessionKey: input.sessionKey,
      action: "timeout",
      ...(input.expectedApprovalId !== undefined
        ? { expectedApprovalId: input.expectedApprovalId }
        : {}),
    });
  }

  /**
   * Private helper: wraps the gateway lock + the verbatim-ported
   * `resolvePlanApproval` state machine + audit emission.
   *
   * No-op detection: `resolvePlanApproval` returns `current` (by
   * reference) when its guards fire (terminal-state, stale-event, or
   * timeout-on-non-pending). We compare `next === current` for skip.
   */
  private async applyApprovalAction(input: {
    sessionKey: string;
    action: "approve" | "edit" | "reject" | "timeout";
    feedback?: string;
    /**
     * Optional approval-version token. Forwarded as `resolvePlanApproval`'s
     * 4th argument so its stale-event guard is live (Wave-1 W1-C1).
     */
    expectedApprovalId?: string;
  }): Promise<
    | { kind: "recorded"; state: PlanModeSessionState }
    | { kind: "skipped"; reason: "not-plan-mode" | "no-pending-approval" }
    | { kind: "failed"; error: Error }
  > {
    const { sessionKey, action, feedback, expectedApprovalId } = input;
    try {
      let outcome:
        | { kind: "recorded"; state: PlanModeSessionState }
        | { kind: "skipped"; reason: "not-plan-mode" | "no-pending-approval" };
      const { transition } = await this.gateway.withLock<{
        prev: PlanModeSessionState | undefined;
        next: PlanModeSessionState;
      }>(sessionKey, async (current) => {
        if (!current || current.mode !== "plan") {
          outcome = { kind: "skipped", reason: "not-plan-mode" };
          return { next: null };
        }
        const next = resolvePlanApproval(
          current,
          action,
          feedback,
          expectedApprovalId,
        );
        if (next === current) {
          // Reference equality: resolvePlanApproval's guards fired
          // (terminal-state for approve/edit/reject, or
          // timeout-on-non-pending). No write.
          outcome = { kind: "skipped", reason: "no-pending-approval" };
          return { next: null };
        }
        outcome = { kind: "recorded", state: next };
        return {
          next: stampSchemaVersion(next) as PlanModeSessionState,
          transition: { prev: current, next },
        };
      });
      if (transition && this.audit) {
        const source =
          action === "reject"
            ? "smarter-claw:PlanModeStore.recordRejection"
            : action === "timeout"
              ? "smarter-claw:PlanModeStore.recordTimeout"
              : "smarter-claw:PlanModeStore.recordApproval";
        this.audit({
          sessionKey,
          prev: transition.prev,
          next: transition.next,
          source,
        });
      }
      return outcome!;
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      this.logger?.warn?.(
        `PlanModeStore.applyApprovalAction[${action}]: failed (sessionKey=${sessionKey}): ${wrapped.message}`,
      );
      return { kind: "failed", error: wrapped };
    }
  }

  /**
   * Toggle the autoApprove flag on the session's plan-mode state.
   *
   * When `autoApprove === true`, the next `exit_plan_mode` will resolve
   * approval IMMEDIATELY (W1-F4 wiring, 2026-05-20) — the runtime
   * persists the approval as `pending` (visible to UI for the brief
   * window before auto-resolve) and then fires `recordApproval` +
   * enqueues the [PLAN_DECISION]: approved injection on the agent's
   * next turn. The agent self-executes the submitted plan verbatim.
   *
   * # Safety
   *
   * Auto-approve fires `approve` (NOT `edit`), so it does NOT grant
   * the agent the `acceptEdits` permission. The 3 hard constraints
   * enforced by the accept-edits gate (no destructive / no
   * self-restart / no config changes) are scoped to acceptEdits-granted
   * sessions; auto-approve sessions execute the plan as the operator
   * pre-approved it. Toggling this flag is a trust delegation — use
   * `/plan auto off` to revoke at any time. The trigger re-reads the
   * flag immediately before firing so mid-cycle toggles are honored.
   *
   * Idempotent: setting the flag to its current value still writes
   * (to refresh updatedAt) but emits no audit event (transition is
   * a no-op).
   *
   * @example
   *   await store.setAutoApprove({ sessionKey, enabled: true });
   *   // Next exit_plan_mode auto-approves; agent self-executes.
   *
   * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:387-477
   *   (`autoApproveIfEnabled` — the in-host trigger this flag now wires
   *   to via `src/tools/exit-plan-mode.ts ExitPlanModeAutoApproveOptions`).
   * host_ref: in-host `auto-enable.ts` toggle wiring (PR-10 auto-mode).
   */
  async setAutoApprove(input: {
    sessionKey: string;
    enabled: boolean;
  }): Promise<
    | { kind: "updated"; enabled: boolean; state: PlanModeSessionState }
    | { kind: "noop"; enabled: boolean }
    | { kind: "failed"; error: Error }
  > {
    const { sessionKey, enabled } = input;
    try {
      let outcome:
        | { kind: "updated"; enabled: boolean; state: PlanModeSessionState }
        | { kind: "noop"; enabled: boolean };
      const { transition } = await this.gateway.withLock<{
        prev: PlanModeSessionState | undefined;
        next: PlanModeSessionState;
      }>(sessionKey, async (current) => {
        // Auto-approve toggle requires a plan-mode payload. Allow
        // toggling regardless of approval state — operator can pre-set
        // auto-approve before the next exit_plan_mode cycle.
        if (!current) {
          // Lazy-init: create a fresh plan-mode payload in normal
          // mode with autoApprove set. The next enterPlanMode will
          // preserve the flag (via spread).
          const now = Date.now();
          const next: PlanModeSessionState = {
            mode: "normal",
            approval: "none",
            rejectionCount: 0,
            updatedAt: now,
            autoApprove: enabled,
          };
          outcome = { kind: "updated", enabled, state: next };
          return {
            next: stampSchemaVersion(next) as PlanModeSessionState,
            transition: { prev: current, next },
          };
        }
        if (current.autoApprove === enabled) {
          outcome = { kind: "noop", enabled };
          return { next: null };
        }
        const now = Date.now();
        const next: PlanModeSessionState = {
          ...current,
          autoApprove: enabled,
          updatedAt: now,
        };
        outcome = { kind: "updated", enabled, state: next };
        return {
          next: stampSchemaVersion(next) as PlanModeSessionState,
          transition: { prev: current, next },
        };
      });
      if (transition && this.audit) {
        this.audit({
          sessionKey,
          prev: transition.prev,
          next: transition.next,
          source: "smarter-claw:PlanModeStore.setAutoApprove",
        });
      }
      return outcome!;
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      this.logger?.warn?.(
        `PlanModeStore.setAutoApprove: failed (sessionKey=${sessionKey}): ${wrapped.message}`,
      );
      return { kind: "failed", error: wrapped };
    }
  }

  /**
   * Read the current plan-mode state for a session. Returns undefined
   * when no payload exists yet (fresh session, or one that has never
   * touched plan mode).
   *
   * Forward-compat: if the persisted payload has a schema version we
   * don't know how to read, returns undefined and logs a warning.
   * Future major versions can extend this with migration logic.
   *
   * NOTE: this is a non-locking READ. Use only for projection / display.
   * For mutations, use the typed mutators (persistApprovalRequest,
   * etc.) which lock internally.
   */
  async readSnapshot(
    sessionKey: string,
  ): Promise<PlanModeSessionState | undefined> {
    // Snapshot via the gateway's withLock with a no-op update. This
    // gives us the lock-protected fresh read even though we're not
    // mutating. Future PRs may add a non-locking `read(sessionKey)`
    // method on the gateway if the projection path needs to be hotter.
    let snapshot: PlanModeSessionState | undefined;
    await this.gateway.withLock(sessionKey, async (current) => {
      snapshot = current;
      return { next: null };
    });
    if (!snapshot) return undefined;
    const version = readSchemaVersion(snapshot);
    if (version > CURRENT_SCHEMA_VERSION) {
      this.logger?.warn?.(
        `PlanModeStore.readSnapshot: persisted schemaVersion=${version} is newer than this plugin's CURRENT_SCHEMA_VERSION=${CURRENT_SCHEMA_VERSION}; returning undefined to avoid type-unsafe access`,
      );
      return undefined;
    }
    return snapshot;
  }
}
