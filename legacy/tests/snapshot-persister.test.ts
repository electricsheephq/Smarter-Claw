/**
 * Ported from openclaw-1: src/gateway/plan-snapshot-persister.test.ts
 *
 * Adapted for Smarter-Claw API:
 *   - The openclaw-1 file imported `__testingPlanSnapshotPersister`
 *     (private testing surface) to drive `persistApprovalMetadata`
 *     directly. Smarter-Claw exposes `startPlanSnapshotPersister(deps)`
 *     as the public surface and the equivalent assertion is reshaped
 *     to drive the persister via a `subscribe` callback that emits an
 *     approval event with an empty/whitespace runId.
 *   - Adds Smarter-Claw-specific tests for `shouldAutoClosePlan` (the
 *     public predicate the installer wires) since it's the only other
 *     surfaced function.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type PlanEventLike,
  shouldAutoClosePlan,
  type SnapshotPersisterDeps,
  startPlanSnapshotPersister,
} from "../src/snapshot-persister.js";

/**
 * Drive the persister with a single approval event and capture any
 * error that the async handler propagates via the warn log path.
 */
async function emitApprovalEventAndCaptureWarn(
  evt: PlanEventLike,
  depsOverrides: Partial<SnapshotPersisterDeps> = {},
): Promise<{ warnCalls: string[]; metadataCalls: unknown[] }> {
  const warnCalls: string[] = [];
  const metadataCalls: unknown[] = [];
  let emit: ((evt: PlanEventLike) => void) | undefined;
  const subscribe: SnapshotPersisterDeps["subscribe"] = (handler) => {
    emit = handler;
    return () => {};
  };
  const deps: SnapshotPersisterDeps = {
    subscribe,
    getRunPlanSnapshot: () => undefined,
    persistSnapshot: async () => ({ closed: false }),
    persistApprovalMetadata: async (params) => {
      metadataCalls.push(params);
    },
    log: { warn: (m) => warnCalls.push(m) },
    ...depsOverrides,
  };
  const stop = startPlanSnapshotPersister(deps);
  try {
    if (!emit) {
      throw new Error("subscribe was not invoked");
    }
    emit(evt);
    // Allow microtasks to flush so the async handler completes.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    stop();
  }
  return { warnCalls, metadataCalls };
}

describe("snapshot-persister — approvalRunId guard (driven via startPlanSnapshotPersister)", () => {
  // The plan-submission shape required by the persister:
  //   phase: "requested", kind: "plugin", title: <string>,
  //   plan: [<at least one step>], no `question` field.
  const SUBMISSION_DATA = {
    phase: "requested" as const,
    kind: "plugin" as const,
    title: "Test plan",
    approvalId: "a1",
    plan: [{ step: "Run tests", status: "pending" }],
  };

  it("warns (does not call persistApprovalMetadata) when runId is empty string", async () => {
    const { warnCalls, metadataCalls } = await emitApprovalEventAndCaptureWarn({
      stream: "approval",
      sessionKey: "agent:main:main",
      runId: "",
      data: SUBMISSION_DATA,
    });
    expect(metadataCalls).toHaveLength(0);
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls.some((m) => /approvalRunId is required/.test(m))).toBe(true);
  });

  it("warns when runId is whitespace-only", async () => {
    const { warnCalls, metadataCalls } = await emitApprovalEventAndCaptureWarn({
      stream: "approval",
      sessionKey: "agent:main:main",
      runId: "   ",
      data: SUBMISSION_DATA,
    });
    expect(metadataCalls).toHaveLength(0);
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls.some((m) => /approvalRunId is required/.test(m))).toBe(true);
  });

  it("error message mentions the diagnostic implication so operators understand the severity", async () => {
    const { warnCalls } = await emitApprovalEventAndCaptureWarn({
      stream: "approval",
      sessionKey: "agent:main:main",
      runId: "",
      data: SUBMISSION_DATA,
    });
    // Either the original "subagent gate" wording, or another phrase
    // that names the bypass concern.
    expect(warnCalls.some((m) => /subagent gate/i.test(m))).toBe(true);
  });

  it("calls persistApprovalMetadata when runId is non-empty (positive control)", async () => {
    const { warnCalls, metadataCalls } = await emitApprovalEventAndCaptureWarn({
      stream: "approval",
      sessionKey: "agent:main:main",
      runId: "run-abc",
      data: SUBMISSION_DATA,
    });
    expect(warnCalls).toHaveLength(0);
    expect(metadataCalls).toHaveLength(1);
    expect(metadataCalls[0]).toMatchObject({
      sessionKey: "agent:main:main",
      title: "Test plan",
      approvalRunId: "run-abc",
      approvalId: "a1",
    });
  });
});

describe("startPlanSnapshotPersister — wiring guards", () => {
  it("returns no-op shutdown when subscribe is missing", () => {
    const log = { warn: vi.fn() };
    const stop = startPlanSnapshotPersister({
      // Cast to bypass the required types — the persister is
      // explicitly defensive against unwired deps.
      subscribe: undefined as unknown as SnapshotPersisterDeps["subscribe"],
      getRunPlanSnapshot: () => undefined,
      persistSnapshot: async () => ({ closed: false }),
      log,
    });
    expect(typeof stop).toBe("function");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("subscribe + persistSnapshot deps required"),
    );
    stop();
  });

  it("returns no-op shutdown when persistSnapshot is missing", () => {
    const log = { warn: vi.fn() };
    const stop = startPlanSnapshotPersister({
      subscribe: () => () => {},
      getRunPlanSnapshot: () => undefined,
      persistSnapshot: undefined as unknown as SnapshotPersisterDeps["persistSnapshot"],
      log,
    });
    expect(typeof stop).toBe("function");
    expect(log.warn).toHaveBeenCalled();
    stop();
  });
});

describe("shouldAutoClosePlan", () => {
  it("returns true when approval is approved", () => {
    expect(shouldAutoClosePlan({ approval: "approved" })).toBe(true);
  });

  it("returns true when approval is edited", () => {
    expect(shouldAutoClosePlan({ approval: "edited" })).toBe(true);
  });

  it("returns false when approval is pending", () => {
    expect(shouldAutoClosePlan({ approval: "pending" })).toBe(false);
  });

  it("returns false when approval is undefined and there's no recently-approved grace window", () => {
    expect(shouldAutoClosePlan({})).toBe(false);
  });

  it("returns true within 5-minute post-deletion grace window when both cycle markers align", () => {
    expect(
      shouldAutoClosePlan({
        approval: undefined,
        recentlyApprovedAt: Date.now() - 60_000,
        recentlyApprovedCycleId: "c-1",
      }),
    ).toBe(true);
  });

  it("returns false outside the 5-minute grace window", () => {
    expect(
      shouldAutoClosePlan({
        approval: undefined,
        recentlyApprovedAt: Date.now() - 6 * 60_000,
        recentlyApprovedCycleId: "c-1",
      }),
    ).toBe(false);
  });

  it("returns false in grace window when a fresh cycleId is set (a new cycle started)", () => {
    expect(
      shouldAutoClosePlan({
        approval: undefined,
        recentlyApprovedAt: Date.now() - 60_000,
        recentlyApprovedCycleId: "c-1",
        cycleId: "c-new",
      }),
    ).toBe(false);
  });
});
