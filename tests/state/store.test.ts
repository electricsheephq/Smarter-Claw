/**
 * P-3 PlanModeStore tests — encodes all 10 invariants of the in-host
 * persistPlanApprovalRequest at
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/pi-embedded-subscribe.handlers.tools.ts:130-237`
 *
 * Critical: this is the SECURITY-CRITICAL test file for the port. Each
 * invariant has at least one positive + one negative test case. The
 * test names map 1:1 to the 10 invariants documented in
 * architecture-v2/09-AMENDMENT_1_VERIFICATION.md.
 *
 * NOT covered here (deferred):
 * - Invariant 5+6 (lock + fresh-read) end-to-end against the REAL
 *   gateway. The in-memory gateway encodes the semantics; real-gateway
 *   tests land at P-6 when the SDK write API is wired.
 * - Concurrent invocation tests beyond the in-memory chain. The
 *   parity-harness Layer 1 (P-3.5) will exercise the in-host
 *   reference against the same input table to catch any divergence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanModeStore, type AuditEmitter } from "../../src/state/store.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/state/schema-version.js";
import type { PlanModeSessionState } from "../../src/types.js";
import { InMemoryGateway } from "./in-memory-gateway.js";

const SESSION_KEY = "agent:main:main";
const APPROVAL_ID = "plan-aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee";
const APPROVAL_ID_CANDIDATE_2 = "plan-11111111-2222-4333-9444-555555555555";

function planModeSession(
  overrides: Partial<PlanModeSessionState> = {},
): PlanModeSessionState {
  return {
    mode: "plan",
    approval: "none",
    rejectionCount: 0,
    enteredAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("P-3 PlanModeStore — Invariant 2: mode === \"plan\" precondition guard", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;
  let audit: AuditEmitter;

  beforeEach(() => {
    gw = new InMemoryGateway();
    audit = vi.fn();
    store = new PlanModeStore(gw, undefined, audit);
  });

  it("skipped when session has no plan-mode payload", async () => {
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("not-plan-mode");
    expect(gw.writeCount).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("skipped when session is in normal mode", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "normal" }));
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    expect(r.kind).toBe("skipped");
    expect(gw.writeCount).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("proceeds when session is in plan mode", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan" }));
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    expect(r.kind).toBe("persisted");
    expect(gw.writeCount).toBe(1);
  });
});

describe("P-3 PlanModeStore — Invariant 1: sync bundle write (race-fix anchor)", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;

  beforeEach(() => {
    gw = new InMemoryGateway();
    store = new PlanModeStore(gw);
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan" }));
  });

  it("persists approvalId synchronously in a single write", async () => {
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    expect(r.kind).toBe("persisted");
    expect(gw.peek(SESSION_KEY)?.approvalId).toBe(APPROVAL_ID);
    expect(gw.writeCount).toBe(1);
  });

  it("persists title in the SAME write as approvalId", async () => {
    await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      title: "Bump deps",
    });
    const state = gw.peek(SESSION_KEY);
    expect(state?.approvalId).toBe(APPROVAL_ID);
    expect(state?.title).toBe("Bump deps");
    expect(gw.writeCount).toBe(1); // ONE write, not two
  });

  it("persists lastPlanSteps in the SAME write as approvalId", async () => {
    const steps = [
      { step: "a", status: "pending" },
      { step: "b", status: "pending" },
    ];
    await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      lastPlanSteps: steps,
    });
    const state = gw.peek(SESSION_KEY);
    expect(state?.approvalId).toBe(APPROVAL_ID);
    expect(state?.lastPlanSteps).toEqual(steps);
    expect(gw.writeCount).toBe(1);
  });

  it("persists payloadHash in the SAME write as approvalId", async () => {
    await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      payloadHash: "9f1b2a4c5e7d",
    });
    const state = gw.peek(SESSION_KEY);
    expect(state?.approvalId).toBe(APPROVAL_ID);
    expect(state?.lastPlanPayloadHash).toBe("9f1b2a4c5e7d");
    expect(gw.writeCount).toBe(1);
  });

  it("ALL FOUR race-fix fields land atomically in one write (the full race-fix scenario)", async () => {
    const steps = [{ step: "do thing", status: "pending" }];
    await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
      title: "Test plan",
      payloadHash: "9f1b2a4c5e7d",
      lastPlanSteps: steps,
    });
    const state = gw.peek(SESSION_KEY);
    expect(state?.approvalId).toBe(APPROVAL_ID);
    expect(state?.title).toBe("Test plan");
    expect(state?.lastPlanPayloadHash).toBe("9f1b2a4c5e7d");
    expect(state?.lastPlanSteps).toEqual(steps);
    expect(state?.approval).toBe("pending");
    expect(gw.writeCount).toBe(1); // load-bearing: prevents the race
  });

  it("preserves existing state fields not touched by the write", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({
        mode: "plan",
        feedback: "existing feedback",
        rejectionCount: 2,
        enteredAt: 1_700_000_000_000,
      }),
    );
    await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    const state = gw.peek(SESSION_KEY);
    expect(state?.feedback).toBe("existing feedback");
    expect(state?.rejectionCount).toBe(2);
    expect(state?.enteredAt).toBe(1_700_000_000_000);
  });

  it("sets approval=pending on every persist (even from rejected)", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan", approval: "rejected" }));
    await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    expect(gw.peek(SESSION_KEY)?.approval).toBe("pending");
  });
});

describe("P-3 PlanModeStore — Invariant 3+7: 4-conjoined idempotency guard", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;

  const seedReusable = (state: Partial<PlanModeSessionState> = {}) =>
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "pending",
      rejectionCount: 0,
      approvalId: APPROVAL_ID,
      lastPlanPayloadHash: "matched-hash",
      ...state,
    });

  beforeEach(() => {
    gw = new InMemoryGateway();
    store = new PlanModeStore(gw);
  });

  it("REUSES approvalId when ALL FOUR conditions hold (the happy reuse case)", async () => {
    seedReusable();
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID_CANDIDATE_2, // different candidate
      payloadHash: "matched-hash",
    });
    expect(r.kind).toBe("reused");
    if (r.kind === "reused") expect(r.approvalId).toBe(APPROVAL_ID); // existing
    expect(gw.writeCount).toBe(0); // no write on reuse path
  });

  it("ROTATES when payloadHash is missing (condition 1 fails)", async () => {
    seedReusable();
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID_CANDIDATE_2,
      // payloadHash deliberately omitted
    });
    expect(r.kind).toBe("persisted");
    expect(gw.peek(SESSION_KEY)?.approvalId).toBe(APPROVAL_ID_CANDIDATE_2);
    expect(gw.writeCount).toBe(1);
  });

  it("ROTATES when payloadHash does NOT match persisted (condition 1 fails)", async () => {
    seedReusable();
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID_CANDIDATE_2,
      payloadHash: "different-hash",
    });
    expect(r.kind).toBe("persisted");
    expect(gw.peek(SESSION_KEY)?.approvalId).toBe(APPROVAL_ID_CANDIDATE_2);
  });

  it("ROTATES when persisted state is not pending (condition 2 fails)", async () => {
    seedReusable({ approval: "approved" });
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID_CANDIDATE_2,
      payloadHash: "matched-hash",
    });
    expect(r.kind).toBe("persisted");
    expect(gw.peek(SESSION_KEY)?.approvalId).toBe(APPROVAL_ID_CANDIDATE_2);
  });

  it("ROTATES when persisted state is rejected (condition 2 fails — agent retrying after rejection)", async () => {
    seedReusable({ approval: "rejected" });
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID_CANDIDATE_2,
      payloadHash: "matched-hash",
    });
    expect(r.kind).toBe("persisted");
  });

  it("ROTATES when persisted approvalId is missing (condition 3 fails)", async () => {
    seedReusable({ approvalId: undefined });
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID_CANDIDATE_2,
      payloadHash: "matched-hash",
    });
    expect(r.kind).toBe("persisted");
  });

  it("ROTATES when persisted approvalId is empty string (condition 4 fails)", async () => {
    seedReusable({ approvalId: "" });
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID_CANDIDATE_2,
      payloadHash: "matched-hash",
    });
    expect(r.kind).toBe("persisted");
  });
});

describe("P-3 PlanModeStore — Invariant 4+9: audit emission policy", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;
  let audit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gw = new InMemoryGateway();
    audit = vi.fn();
    store = new PlanModeStore(gw, undefined, audit);
  });

  it("emits audit event on the persist path (invariant 4)", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan" }));
    await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    const call = audit.mock.calls[0][0];
    expect(call.sessionKey).toBe(SESSION_KEY);
    expect(call.next.approvalId).toBe(APPROVAL_ID);
    expect(call.source).toContain("persistApprovalRequest");
  });

  it("SKIPS audit on the reuse path (invariant 9 — deliberate)", async () => {
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "pending",
      rejectionCount: 0,
      approvalId: APPROVAL_ID,
      lastPlanPayloadHash: "matched",
    });
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID_CANDIDATE_2,
      payloadHash: "matched",
    });
    expect(r.kind).toBe("reused");
    expect(audit).not.toHaveBeenCalled(); // CRITICAL: invariant 9
  });

  it("SKIPS audit on the skipped path (no transition)", async () => {
    // No seed — session has no plan-mode payload, so the precondition
    // guard skips. No transition → no audit.
    await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("provides prev + next in the audit event payload", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan", approval: "none" }));
    await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    const call = audit.mock.calls[0][0];
    expect(call.prev?.approval).toBe("none");
    expect(call.next.approval).toBe("pending");
  });
});

describe("P-3 PlanModeStore — Invariant 8: IO-error fail-soft", () => {
  it("returns kind:'failed' + candidate approvalId when gateway throws", async () => {
    // Gateway that always throws.
    const brokenGw = {
      withLock: vi.fn(async () => {
        throw new Error("simulated disk failure");
      }),
    };
    const log = { warn: vi.fn() };
    const store = new PlanModeStore(
      brokenGw as never,
      log as never,
    );
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.error.message).toBe("simulated disk failure");
      expect(r.approvalId).toBe(APPROVAL_ID); // candidate returned, NOT undefined
    }
    expect(log.warn).toHaveBeenCalled();
    expect(log.warn.mock.calls[0][0]).toContain("failed to persist");
  });

  it("NEVER throws (callers can rely on Promise<Result>)", async () => {
    const brokenGw = {
      withLock: vi.fn(async () => {
        throw new Error("transient IO");
      }),
    };
    const store = new PlanModeStore(brokenGw as never);
    // No await-rejects expected. The contract is Promise<Result>, not
    // Promise<Result | thrown>.
    await expect(
      store.persistApprovalRequest({
        sessionKey: SESSION_KEY,
        approvalId: APPROVAL_ID,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "failed",
        approvalId: APPROVAL_ID,
      }),
    );
  });
});

describe("P-3 PlanModeStore — caller-contract: discriminated-union return", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;

  beforeEach(() => {
    gw = new InMemoryGateway();
    store = new PlanModeStore(gw);
  });

  it("all 4 result kinds carry an approvalId field", async () => {
    // persisted
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan" }));
    const persisted = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    expect(persisted.approvalId).toBeTruthy();

    // reused
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "pending",
      rejectionCount: 0,
      approvalId: APPROVAL_ID,
      lastPlanPayloadHash: "h",
    });
    const reused = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID_CANDIDATE_2,
      payloadHash: "h",
    });
    expect(reused.approvalId).toBe(APPROVAL_ID);

    // skipped
    gw = new InMemoryGateway();
    store = new PlanModeStore(gw);
    const skipped = await store.persistApprovalRequest({
      sessionKey: "fresh-session",
      approvalId: APPROVAL_ID_CANDIDATE_2,
    });
    expect(skipped.approvalId).toBe(APPROVAL_ID_CANDIDATE_2);

    // failed — covered in the IO-error suite
  });
});

describe("P-3 PlanModeStore — schema-version stamping", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;

  beforeEach(() => {
    gw = new InMemoryGateway();
    store = new PlanModeStore(gw);
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan" }));
  });

  it("stamps __schemaVersion on every successful write", async () => {
    await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID,
    });
    const state = gw.peek(SESSION_KEY) as PlanModeSessionState & {
      __schemaVersion?: number;
    };
    expect(state.__schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("does NOT stamp on the reuse path (no write happens)", async () => {
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "pending",
      rejectionCount: 0,
      approvalId: APPROVAL_ID,
      lastPlanPayloadHash: "h",
    });
    // Pre-seeded state has no __schemaVersion. Reuse path performs NO
    // write, so the unstamped state remains.
    const r = await store.persistApprovalRequest({
      sessionKey: SESSION_KEY,
      approvalId: APPROVAL_ID_CANDIDATE_2,
      payloadHash: "h",
    });
    expect(r.kind).toBe("reused");
    const state = gw.peek(SESSION_KEY) as PlanModeSessionState & {
      __schemaVersion?: number;
    };
    // Reuse path: no write, so the seeded shape remains unstamped.
    expect(state.__schemaVersion).toBeUndefined();
  });
});

describe("P-3 PlanModeStore — readSnapshot", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;

  beforeEach(() => {
    gw = new InMemoryGateway();
    store = new PlanModeStore(gw);
  });

  it("returns undefined for sessions with no plan-mode payload", async () => {
    const snap = await store.readSnapshot(SESSION_KEY);
    expect(snap).toBeUndefined();
  });

  it("returns the current state for sessions with plan-mode payload", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({ mode: "plan", title: "current plan" }),
    );
    const snap = await store.readSnapshot(SESSION_KEY);
    expect(snap?.title).toBe("current plan");
  });

  it("returns undefined when persisted schemaVersion is newer than current build", async () => {
    gw.seed(SESSION_KEY, {
      ...planModeSession({ mode: "plan" }),
      __schemaVersion: CURRENT_SCHEMA_VERSION + 99,
    } as PlanModeSessionState & { __schemaVersion: number });
    const log = { warn: vi.fn() };
    const store2 = new PlanModeStore(gw, log);
    const snap = await store2.readSnapshot(SESSION_KEY);
    expect(snap).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    expect(log.warn.mock.calls[0][0]).toContain("schemaVersion");
  });

  it("readSnapshot does NOT mutate state (no write count increment)", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan" }));
    await store.readSnapshot(SESSION_KEY);
    expect(gw.writeCount).toBe(0);
  });
});

describe("P-11 PlanModeStore.recordRejection — happy path", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;
  let audit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gw = new InMemoryGateway();
    audit = vi.fn();
    store = new PlanModeStore(gw, undefined, audit);
    gw.seed(
      SESSION_KEY,
      planModeSession({
        mode: "plan",
        approval: "pending",
        approvalId: APPROVAL_ID,
        title: "Bump deps",
        rejectionCount: 0,
      }),
    );
  });

  it("transitions approval → rejected on a pending plan", async () => {
    const r = await store.recordRejection({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("recorded");
    if (r.kind === "recorded") {
      expect(r.state.approval).toBe("rejected");
    }
    expect(gw.peek(SESSION_KEY)?.approval).toBe("rejected");
  });

  it("increments rejectionCount by 1", async () => {
    const r = await store.recordRejection({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("recorded");
    if (r.kind === "recorded") {
      expect(r.rejectionCount).toBe(1);
    }
    expect(gw.peek(SESSION_KEY)?.rejectionCount).toBe(1);
  });

  it("increments rejectionCount across multiple rejection cycles", async () => {
    // Cycle 1: reject
    await store.recordRejection({ sessionKey: SESSION_KEY });
    // The state is now rejected with rejectionCount=1; agent revises;
    // sessions-patch sets it back to pending on the next exit_plan_mode.
    // Simulate that path for the test by seeding to pending again.
    gw.seed(
      SESSION_KEY,
      planModeSession({
        mode: "plan",
        approval: "pending",
        approvalId: APPROVAL_ID,
        rejectionCount: 1, // carried over
      }),
    );
    const r2 = await store.recordRejection({ sessionKey: SESSION_KEY });
    expect(r2.kind).toBe("recorded");
    if (r2.kind === "recorded") {
      expect(r2.rejectionCount).toBe(2);
    }
  });

  it("stores feedback on the state when provided", async () => {
    await store.recordRejection({
      sessionKey: SESSION_KEY,
      feedback: "step 2 is wrong",
    });
    expect(gw.peek(SESSION_KEY)?.feedback).toBe("step 2 is wrong");
  });

  it("does NOT set feedback when omitted (preserves prior state's feedback)", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({
        mode: "plan",
        approval: "pending",
        approvalId: APPROVAL_ID,
        feedback: "older feedback",
      }),
    );
    await store.recordRejection({ sessionKey: SESSION_KEY });
    // No feedback provided → prior feedback survives (spread preserves).
    expect(gw.peek(SESSION_KEY)?.feedback).toBe("older feedback");
  });

  it("clears approvalId on rejection (current cycle resolved)", async () => {
    await store.recordRejection({ sessionKey: SESSION_KEY });
    expect(gw.peek(SESSION_KEY)?.approvalId).toBeUndefined();
  });

  it("preserves mode === plan (agent stays in plan mode to revise)", async () => {
    await store.recordRejection({ sessionKey: SESSION_KEY });
    expect(gw.peek(SESSION_KEY)?.mode).toBe("plan");
  });

  it("emits audit event on the recorded path", async () => {
    await store.recordRejection({
      sessionKey: SESSION_KEY,
      feedback: "fb",
    });
    expect(audit).toHaveBeenCalledTimes(1);
    const call = audit.mock.calls[0][0];
    expect(call.sessionKey).toBe(SESSION_KEY);
    expect(call.prev?.approval).toBe("pending");
    expect(call.next.approval).toBe("rejected");
    expect(call.source).toContain("recordRejection");
  });

  it("stamps __schemaVersion on the write", async () => {
    await store.recordRejection({ sessionKey: SESSION_KEY });
    const state = gw.peek(SESSION_KEY) as PlanModeSessionState & {
      __schemaVersion?: number;
    };
    expect(state.__schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("P-11 PlanModeStore.recordRejection — skip paths", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;
  let audit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gw = new InMemoryGateway();
    audit = vi.fn();
    store = new PlanModeStore(gw, undefined, audit);
  });

  it("skips with not-plan-mode when session has no plan-mode payload", async () => {
    const r = await store.recordRejection({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("not-plan-mode");
    expect(gw.writeCount).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("skips with not-plan-mode when session is in normal mode", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "normal" }));
    const r = await store.recordRejection({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("not-plan-mode");
    expect(gw.writeCount).toBe(0);
  });

  it("skips with no-pending-approval when approval is 'none'", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan", approval: "none" }));
    const r = await store.recordRejection({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("no-pending-approval");
    expect(gw.writeCount).toBe(0);
  });

  it("skips with no-pending-approval when approval is already 'rejected'", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({ mode: "plan", approval: "rejected" }),
    );
    const r = await store.recordRejection({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("skipped");
    expect(gw.writeCount).toBe(0);
  });

  it("skips with no-pending-approval when approval is 'approved'", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({ mode: "plan", approval: "approved" }),
    );
    const r = await store.recordRejection({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("skipped");
    expect(gw.writeCount).toBe(0);
  });
});

describe("P-11 PlanModeStore.recordRejection — IO-error fail-soft", () => {
  it("returns kind:'failed' when gateway throws (never throws)", async () => {
    const brokenGw = {
      withLock: vi.fn(async () => {
        throw new Error("simulated disk failure");
      }),
    };
    const log = { warn: vi.fn() };
    const store = new PlanModeStore(brokenGw as never, log as never);
    const r = await store.recordRejection({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.error.message).toBe("simulated disk failure");
    }
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("P-11 PlanModeStore.recordApproval — happy path", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;
  let audit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gw = new InMemoryGateway();
    audit = vi.fn();
    store = new PlanModeStore(gw, undefined, audit);
    gw.seed(
      SESSION_KEY,
      planModeSession({
        mode: "plan",
        approval: "pending",
        approvalId: APPROVAL_ID,
        title: "Bump deps",
      }),
    );
  });

  it("transitions approval → approved by default (edited omitted)", async () => {
    const r = await store.recordApproval({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("recorded");
    if (r.kind === "recorded") {
      expect(r.approval).toBe("approved");
      expect(r.state.approval).toBe("approved");
    }
    expect(gw.peek(SESSION_KEY)?.approval).toBe("approved");
  });

  it("transitions approval → approved when edited is explicitly false", async () => {
    const r = await store.recordApproval({
      sessionKey: SESSION_KEY,
      edited: false,
    });
    expect(r.kind).toBe("recorded");
    if (r.kind === "recorded") expect(r.approval).toBe("approved");
  });

  it("transitions approval → edited when edited=true", async () => {
    const r = await store.recordApproval({
      sessionKey: SESSION_KEY,
      edited: true,
    });
    expect(r.kind).toBe("recorded");
    if (r.kind === "recorded") {
      expect(r.approval).toBe("edited");
      expect(r.state.approval).toBe("edited");
    }
    expect(gw.peek(SESSION_KEY)?.approval).toBe("edited");
  });

  it("sets confirmedAt timestamp on the write", async () => {
    const before = Date.now();
    await store.recordApproval({ sessionKey: SESSION_KEY });
    const after = Date.now();
    const confirmedAt = gw.peek(SESSION_KEY)?.confirmedAt;
    expect(confirmedAt).toBeGreaterThanOrEqual(before);
    expect(confirmedAt).toBeLessThanOrEqual(after);
  });

  it("preserves approvalId across the write (UI binding stays valid)", async () => {
    await store.recordApproval({ sessionKey: SESSION_KEY });
    expect(gw.peek(SESSION_KEY)?.approvalId).toBe(APPROVAL_ID);
  });

  it("preserves mode === plan (runtime processes injection before exiting)", async () => {
    await store.recordApproval({ sessionKey: SESSION_KEY });
    expect(gw.peek(SESSION_KEY)?.mode).toBe("plan");
  });

  it("emits audit event on the recorded path", async () => {
    await store.recordApproval({ sessionKey: SESSION_KEY });
    expect(audit).toHaveBeenCalledTimes(1);
    const call = audit.mock.calls[0][0];
    expect(call.sessionKey).toBe(SESSION_KEY);
    expect(call.prev?.approval).toBe("pending");
    expect(call.next.approval).toBe("approved");
    expect(call.source).toContain("recordApproval");
  });

  it("stamps __schemaVersion on the write", async () => {
    await store.recordApproval({ sessionKey: SESSION_KEY });
    const state = gw.peek(SESSION_KEY) as PlanModeSessionState & {
      __schemaVersion?: number;
    };
    expect(state.__schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("P-11 PlanModeStore.recordApproval — skip paths", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;

  beforeEach(() => {
    gw = new InMemoryGateway();
    store = new PlanModeStore(gw);
  });

  it("skips with not-plan-mode when session has no plan-mode payload", async () => {
    const r = await store.recordApproval({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("not-plan-mode");
    expect(gw.writeCount).toBe(0);
  });

  it("skips with not-plan-mode when session is in normal mode", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "normal" }));
    const r = await store.recordApproval({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("not-plan-mode");
  });

  it("skips with no-pending-approval when approval is 'none'", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan", approval: "none" }));
    const r = await store.recordApproval({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("no-pending-approval");
  });

  it("skips when approval is already 'approved' (idempotent on double-approve)", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({ mode: "plan", approval: "approved" }),
    );
    const r = await store.recordApproval({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("skipped");
    expect(gw.writeCount).toBe(0);
  });

  it("skips when approval is 'rejected' (revise-and-resubmit flow, not approve)", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({ mode: "plan", approval: "rejected" }),
    );
    const r = await store.recordApproval({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("skipped");
  });
});

describe("P-11 PlanModeStore.recordApproval — IO-error fail-soft", () => {
  it("returns kind:'failed' when gateway throws (never throws)", async () => {
    const brokenGw = {
      withLock: vi.fn(async () => {
        throw new Error("simulated disk failure");
      }),
    };
    const log = { warn: vi.fn() };
    const store = new PlanModeStore(brokenGw as never, log as never);
    const r = await store.recordApproval({ sessionKey: SESSION_KEY });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.error.message).toBe("simulated disk failure");
    }
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("P-13 PlanModeStore.setAutoApprove — toggle behavior", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;
  let audit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gw = new InMemoryGateway();
    audit = vi.fn();
    store = new PlanModeStore(gw, undefined, audit);
  });

  it("enables autoApprove on a session with no existing payload (lazy-init in normal mode)", async () => {
    const r = await store.setAutoApprove({
      sessionKey: SESSION_KEY,
      enabled: true,
    });
    expect(r.kind).toBe("updated");
    if (r.kind === "updated") {
      expect(r.enabled).toBe(true);
      expect(r.state.autoApprove).toBe(true);
      expect(r.state.mode).toBe("normal");
    }
    expect(gw.peek(SESSION_KEY)?.autoApprove).toBe(true);
  });

  it("enables autoApprove on an existing plan-mode payload (preserves mode + approval)", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({
        mode: "plan",
        approval: "pending",
        approvalId: APPROVAL_ID,
        title: "Bump deps",
      }),
    );
    const r = await store.setAutoApprove({
      sessionKey: SESSION_KEY,
      enabled: true,
    });
    if (r.kind !== "updated") throw new Error("expected updated");
    expect(r.state.autoApprove).toBe(true);
    expect(r.state.mode).toBe("plan");
    expect(r.state.approval).toBe("pending");
    expect(r.state.title).toBe("Bump deps");
  });

  it("disables autoApprove on an existing payload", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({ mode: "plan", autoApprove: true }),
    );
    const r = await store.setAutoApprove({
      sessionKey: SESSION_KEY,
      enabled: false,
    });
    if (r.kind !== "updated") throw new Error("expected updated");
    expect(r.state.autoApprove).toBe(false);
  });

  it("noop when toggling to the same value (no write, no audit)", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({ mode: "plan", autoApprove: true }),
    );
    const r = await store.setAutoApprove({
      sessionKey: SESSION_KEY,
      enabled: true,
    });
    expect(r.kind).toBe("noop");
    expect(gw.writeCount).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("emits audit on the updated path", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan" }));
    await store.setAutoApprove({
      sessionKey: SESSION_KEY,
      enabled: true,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    const call = audit.mock.calls[0][0];
    expect(call.source).toContain("setAutoApprove");
    expect(call.next.autoApprove).toBe(true);
  });

  it("stamps __schemaVersion on the write", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "plan" }));
    await store.setAutoApprove({
      sessionKey: SESSION_KEY,
      enabled: true,
    });
    const state = gw.peek(SESSION_KEY) as PlanModeSessionState & {
      __schemaVersion?: number;
    };
    expect(state.__schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("survives across multiple toggles (idempotent state)", async () => {
    await store.setAutoApprove({ sessionKey: SESSION_KEY, enabled: true });
    await store.setAutoApprove({ sessionKey: SESSION_KEY, enabled: false });
    await store.setAutoApprove({ sessionKey: SESSION_KEY, enabled: true });
    expect(gw.peek(SESSION_KEY)?.autoApprove).toBe(true);
  });
});

describe("P-13 PlanModeStore.setAutoApprove — IO-error fail-soft", () => {
  it("returns kind:'failed' when gateway throws (never throws)", async () => {
    const brokenGw = {
      withLock: vi.fn(async () => {
        throw new Error("simulated disk failure");
      }),
    };
    const log = { warn: vi.fn() };
    const store = new PlanModeStore(brokenGw as never, log as never);
    const r = await store.setAutoApprove({
      sessionKey: SESSION_KEY,
      enabled: true,
    });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.error.message).toBe("simulated disk failure");
    }
    expect(log.warn).toHaveBeenCalled();
  });
});
