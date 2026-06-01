import { describe, expect, it, vi } from "vitest";
import { createPlanModeTaskFlowVisibility } from "../../src/runtime/task-flow-visibility.js";

const SESSION_KEY = "agent:main:main";
const APPROVAL_ID = "plan-11111111-1111-4111-8111-111111111111";
const REVISED_APPROVAL_ID = "plan-22222222-2222-4222-8222-222222222222";

function buildTaskFlowRuntime() {
  const flows: Array<Record<string, unknown>> = [];
  const createManaged = vi.fn((input: Record<string, unknown>) => {
    const flow = {
      ...input,
      flowId: `flow-${flows.length + 1}`,
      revision: 1,
      syncMode: "managed",
      controllerId: input.controllerId,
    };
    flows.push(flow);
    return flow;
  });
  const setWaiting = vi.fn((input: Record<string, unknown>) => {
    const flow = flows.find((candidate) => candidate.flowId === input.flowId);
    if (!flow) return { applied: false, code: "not_found" };
    Object.assign(flow, input, {
      status: "waiting",
      revision: Number(flow.revision) + 1,
    });
    return { applied: true, flow };
  });
  const finish = vi.fn((input: Record<string, unknown>) => {
    const flow = flows.find((candidate) => candidate.flowId === input.flowId);
    if (!flow) return { applied: false, code: "not_found" };
    Object.assign(flow, input, { status: "finished" });
    return { applied: true, flow };
  });
  const bindSession = vi.fn(() => ({
    createManaged,
    list: () => flows,
    setWaiting,
    finish,
  }));
  return { flows, bindSession, createManaged, setWaiting, finish };
}

describe("task-flow visibility bridge", () => {
  it("creates a managed task flow when a plan enters pending approval", async () => {
    const runtime = buildTaskFlowRuntime();
    const visibility = createPlanModeTaskFlowVisibility({
      api: { runtime: { tasks: { managedFlows: { bindSession: runtime.bindSession } } } },
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await visibility.recordTransition({
      sessionKey: SESSION_KEY,
      prev: { mode: "plan", approval: "none", rejectionCount: 0 },
      next: {
        mode: "plan",
        approval: "pending",
        approvalId: APPROVAL_ID,
        title: "Ship the release",
        lastPlanSteps: [{ step: "Run focused tests", status: "pending" }],
        rejectionCount: 0,
      },
      source: "persistApprovalRequest",
    });

    expect(runtime.bindSession).toHaveBeenCalledWith({ sessionKey: SESSION_KEY });
    expect(runtime.createManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        controllerId: "smarter-claw.plan-mode",
        goal: "Plan approval: Ship the release",
        status: "waiting",
        currentStep: "Awaiting operator approval",
        waitJson: expect.objectContaining({
          kind: "plan_approval",
          approvalId: APPROVAL_ID,
        }),
      }),
    );
  });

  it("finishes the matching managed task flow when the plan is approved", async () => {
    const runtime = buildTaskFlowRuntime();
    runtime.flows.push({
      flowId: "flow-1",
      revision: 3,
      syncMode: "managed",
      controllerId: "smarter-claw.plan-mode",
      stateJson: {
        kind: "smarter-claw.plan-mode",
        approvalId: APPROVAL_ID,
        sessionKey: SESSION_KEY,
      },
    });
    const visibility = createPlanModeTaskFlowVisibility({
      api: { runtime: { taskFlow: { bindSession: runtime.bindSession } } },
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await visibility.recordTransition({
      sessionKey: SESSION_KEY,
      prev: {
        mode: "plan",
        approval: "pending",
        approvalId: APPROVAL_ID,
        rejectionCount: 0,
      },
      next: {
        mode: "normal",
        approval: "approved",
        approvalId: APPROVAL_ID,
        rejectionCount: 0,
      },
      source: "recordApproval",
    });

    expect(runtime.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "flow-1",
        expectedRevision: 3,
        stateJson: expect.objectContaining({
          approval: "approved",
          source: "recordApproval",
        }),
      }),
    );
  });

  it("reuses the session task flow when a rejected plan is revised with a new approval id", async () => {
    const runtime = buildTaskFlowRuntime();
    const visibility = createPlanModeTaskFlowVisibility({
      api: { runtime: { tasks: { managedFlows: { bindSession: runtime.bindSession } } } },
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await visibility.recordTransition({
      sessionKey: SESSION_KEY,
      prev: { mode: "plan", approval: "none", rejectionCount: 0 },
      next: {
        mode: "plan",
        approval: "pending",
        approvalId: APPROVAL_ID,
        title: "Ship the release",
        rejectionCount: 0,
      },
      source: "persistApprovalRequest",
    });

    await visibility.recordTransition({
      sessionKey: SESSION_KEY,
      prev: {
        mode: "plan",
        approval: "pending",
        approvalId: APPROVAL_ID,
        rejectionCount: 0,
      },
      next: {
        mode: "plan",
        approval: "rejected",
        approvalId: APPROVAL_ID,
        feedback: "Add a Crabbox smoke",
        rejectionCount: 1,
      },
      source: "recordRejection",
    });

    await visibility.recordTransition({
      sessionKey: SESSION_KEY,
      prev: {
        mode: "plan",
        approval: "rejected",
        approvalId: APPROVAL_ID,
        feedback: "Add a Crabbox smoke",
        rejectionCount: 1,
      },
      next: {
        mode: "plan",
        approval: "pending",
        approvalId: REVISED_APPROVAL_ID,
        title: "Ship the revised release",
        rejectionCount: 1,
      },
      source: "persistApprovalRequest",
    });

    expect(runtime.createManaged).toHaveBeenCalledTimes(1);
    expect(runtime.flows).toHaveLength(1);
    expect(runtime.setWaiting).toHaveBeenLastCalledWith(
      expect.objectContaining({
        flowId: "flow-1",
        expectedRevision: 2,
        currentStep: "Awaiting operator approval",
        waitJson: expect.objectContaining({
          kind: "plan_approval",
          approvalId: REVISED_APPROVAL_ID,
        }),
        stateJson: expect.objectContaining({
          approval: "pending",
          approvalId: REVISED_APPROVAL_ID,
          sessionKey: SESSION_KEY,
        }),
      }),
    );
  });
});
