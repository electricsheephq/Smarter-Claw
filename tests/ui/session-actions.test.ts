/**
 * P-12 session-actions tests.
 *
 * Validates each plan.* session action handler:
 *   - sessionKey requirement
 *   - approvalId stale-event guard
 *   - terminal-state guard (no pending approval)
 *   - PlanModeStore mutator integration
 *   - injection-writer integration
 *   - continueAgent flag
 *   - error code propagation
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_ACTION_ERROR_CODES,
  createPlanModeSessionActions,
} from "../../src/ui/session-actions.js";
import { PlanModeStore } from "../../src/state/store.js";
import type { PlanModeSessionState } from "../../src/types.js";
import { InMemoryGateway } from "../state/in-memory-gateway.js";

const SESSION_KEY = "agent:main:main";
const APPROVAL_ID = "plan-aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee";

function planModeSession(
  overrides: Partial<PlanModeSessionState> = {},
): PlanModeSessionState {
  return {
    mode: "plan",
    approval: "pending",
    rejectionCount: 0,
    approvalId: APPROVAL_ID,
    enteredAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeStubApi() {
  const enqueueNextTurnInjection = vi.fn(async (injection: unknown) => ({
    enqueued: true,
    id: "stub-injection-id",
    sessionKey: (injection as { sessionKey: string }).sessionKey,
  }));
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    api: {
      session: { workflow: { enqueueNextTurnInjection } },
      logger,
    } as never,
    enqueueNextTurnInjection,
    logger,
  };
}

describe("P-12 session-actions — registration shape", () => {
  it("exposes the 6 plan.* action ids", () => {
    const { api } = makeStubApi();
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const actions = createPlanModeSessionActions({ api, store });
    const ids = actions.map((a) => a.id).sort();
    expect(ids).toEqual([
      "plan.accept",
      "plan.answer",
      "plan.auto.toggle",
      "plan.cancel",
      "plan.edit",
      "plan.reject",
    ]);
  });

  it("every action has a description", () => {
    const { api } = makeStubApi();
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const actions = createPlanModeSessionActions({ api, store });
    for (const a of actions) {
      expect(a.description).toBeTruthy();
      expect(a.description!.length).toBeGreaterThan(10);
    }
  });
});

describe("P-12 session-actions — plan.accept", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;
  let api: ReturnType<typeof makeStubApi>["api"];
  let enqueue: ReturnType<typeof makeStubApi>["enqueueNextTurnInjection"];
  let acceptHandler: ReturnType<
    typeof createPlanModeSessionActions
  >[number]["handler"];

  beforeEach(() => {
    gw = new InMemoryGateway();
    store = new PlanModeStore(gw);
    const stub = makeStubApi();
    api = stub.api;
    enqueue = stub.enqueueNextTurnInjection;
    const actions = createPlanModeSessionActions({ api, store });
    acceptHandler = actions.find((a) => a.id === "plan.accept")!.handler;
    gw.seed(SESSION_KEY, planModeSession());
  });

  it("approves with no expectedApprovalId (no stale-check requested)", async () => {
    const r = await acceptHandler({
      pluginId: "smarter-claw",
      actionId: "plan.accept",
      sessionKey: SESSION_KEY,
    });
    expect(r).toBeDefined();
    if (!r) throw new Error("no result");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.continueAgent).toBe(true);
      expect(r.result).toMatchObject({
        approval: "approved",
        approvalId: APPROVAL_ID,
      });
    }
    expect(gw.peek(SESSION_KEY)?.approval).toBe("approved");
  });

  it("approves with matching expectedApprovalId", async () => {
    const r = await acceptHandler({
      pluginId: "smarter-claw",
      actionId: "plan.accept",
      sessionKey: SESSION_KEY,
      payload: { approvalId: APPROVAL_ID },
    });
    if (!r || !r.ok) throw new Error("expected ok");
    expect(gw.peek(SESSION_KEY)?.approval).toBe("approved");
  });

  it("rejects with STALE_APPROVAL_ID when expectedApprovalId mismatches", async () => {
    const r = await acceptHandler({
      pluginId: "smarter-claw",
      actionId: "plan.accept",
      sessionKey: SESSION_KEY,
      payload: { approvalId: "plan-different" },
    });
    if (!r || r.ok !== false) throw new Error("expected error");
    expect(r.code).toBe(SESSION_ACTION_ERROR_CODES.STALE_APPROVAL_ID);
    expect(gw.peek(SESSION_KEY)?.approval).toBe("pending"); // unchanged
  });

  it("rejects with MISSING_SESSION_KEY when no sessionKey", async () => {
    const r = await acceptHandler({
      pluginId: "smarter-claw",
      actionId: "plan.accept",
    });
    if (!r || r.ok !== false) throw new Error("expected error");
    expect(r.code).toBe(SESSION_ACTION_ERROR_CODES.MISSING_SESSION_KEY);
  });

  it("rejects with NOT_IN_PLAN_MODE when session not in plan mode", async () => {
    gw.seed(SESSION_KEY, planModeSession({ mode: "normal" }));
    const r = await acceptHandler({
      pluginId: "smarter-claw",
      actionId: "plan.accept",
      sessionKey: SESSION_KEY,
    });
    if (!r || r.ok !== false) throw new Error("expected error");
    expect(r.code).toBe(SESSION_ACTION_ERROR_CODES.NOT_IN_PLAN_MODE);
  });

  it("rejects with NO_PENDING_APPROVAL when approval state is not pending", async () => {
    gw.seed(SESSION_KEY, planModeSession({ approval: "rejected" }));
    const r = await acceptHandler({
      pluginId: "smarter-claw",
      actionId: "plan.accept",
      sessionKey: SESSION_KEY,
    });
    if (!r || r.ok !== false) throw new Error("expected error");
    expect(r.code).toBe(SESSION_ACTION_ERROR_CODES.NO_PENDING_APPROVAL);
  });

  it("enqueues an approved injection with the right text + idempotency key (no plan steps → bare opener fallback)", async () => {
    await acceptHandler({
      pluginId: "smarter-claw",
      actionId: "plan.accept",
      sessionKey: SESSION_KEY,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const call = enqueue.mock.calls[0][0];
    expect(call.text).toBe("[PLAN_DECISION]: approved");
    expect(call.idempotencyKey).toBe(
      `smarter-claw:plan_decision:${APPROVAL_ID}:approved`,
    );
  });

  it("emits the FULL buildApprovedPlanInjection preamble when lastPlanSteps is set (surgical-port S5 fix)", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({
        lastPlanSteps: [
          { step: "Update package.json", status: "pending" },
          { step: "Run pnpm install", status: "pending" },
        ],
      }),
    );
    await acceptHandler({
      pluginId: "smarter-claw",
      actionId: "plan.accept",
      sessionKey: SESSION_KEY,
    });
    const call = enqueue.mock.calls[0][0];
    expect(call.text).toMatch(/^\[PLAN_DECISION\]: approved\n/);
    expect(call.text).toContain(
      "The user has approved the following plan. Execute it now without re-planning",
    );
    expect(call.text).toContain("1. Update package.json");
    expect(call.text).toContain("2. Run pnpm install");
  });

  it("annotates non-pending step statuses in the injection (in-host parity)", async () => {
    gw.seed(
      SESSION_KEY,
      planModeSession({
        lastPlanSteps: [
          { step: "Investigation", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      }),
    );
    await acceptHandler({
      pluginId: "smarter-claw",
      actionId: "plan.accept",
      sessionKey: SESSION_KEY,
    });
    const call = enqueue.mock.calls[0][0];
    expect(call.text).toContain("1. Investigation (completed)");
    expect(call.text).toContain("2. Apply patch (in_progress)");
    expect(call.text).toContain("3. Run tests"); // pending → no annotation
  });
});

describe("P-12 session-actions — plan.edit", () => {
  it("transitions approval to edited and enqueues the edited injection with body", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api, enqueueNextTurnInjection } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.edit")!.handler;
    gw.seed(SESSION_KEY, planModeSession());

    const r = await handler({
      pluginId: "smarter-claw",
      actionId: "plan.edit",
      sessionKey: SESSION_KEY,
      payload: { approvalId: APPROVAL_ID, body: "Step 1: do X\nStep 2: do Y" },
    });
    if (!r || !r.ok) throw new Error("expected ok");
    expect(r.result).toMatchObject({ approval: "edited" });
    expect(gw.peek(SESSION_KEY)?.approval).toBe("edited");
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe(
      "[PLAN_DECISION]: edited\nStep 1: do X\nStep 2: do Y",
    );
  });

  it("omits body when not provided AND no plan steps stored (bare opener fallback)", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api, enqueueNextTurnInjection } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.edit")!.handler;
    gw.seed(SESSION_KEY, planModeSession());

    await handler({
      pluginId: "smarter-claw",
      actionId: "plan.edit",
      sessionKey: SESSION_KEY,
      payload: { approvalId: APPROVAL_ID },
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe("[PLAN_DECISION]: edited");
  });

  it("emits the FULL buildAcceptEditsPlanInjection preamble when no body but lastPlanSteps set (surgical-port S5 fix)", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api, enqueueNextTurnInjection } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.edit")!.handler;
    gw.seed(
      SESSION_KEY,
      planModeSession({
        lastPlanSteps: [
          { step: "Refactor reconnect logic", status: "pending" },
          { step: "Add retry test", status: "pending" },
        ],
      }),
    );

    await handler({
      pluginId: "smarter-claw",
      actionId: "plan.edit",
      sessionKey: SESSION_KEY,
      payload: { approvalId: APPROVAL_ID },
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toMatch(/^\[PLAN_DECISION\]: edited\n/);
    expect(call.text).toContain(
      "The user has approved the following plan with acceptEdits permission",
    );
    expect(call.text).toContain("Hard constraints");
    expect(call.text).toContain("No destructive actions");
    expect(call.text).toContain("1. Refactor reconnect logic");
    expect(call.text).toContain("2. Add retry test");
  });

  it("body field takes priority over acceptEdits preamble (manual user edit)", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api, enqueueNextTurnInjection } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.edit")!.handler;
    gw.seed(
      SESSION_KEY,
      planModeSession({
        lastPlanSteps: [{ step: "X", status: "pending" }],
      }),
    );

    await handler({
      pluginId: "smarter-claw",
      actionId: "plan.edit",
      sessionKey: SESSION_KEY,
      payload: { approvalId: APPROVAL_ID, body: "My edited body" },
    });
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toBe("[PLAN_DECISION]: edited\nMy edited body");
    expect(call.text).not.toContain("acceptEdits permission");
  });
});

describe("P-12 session-actions — plan.reject", () => {
  let gw: InMemoryGateway;
  let store: PlanModeStore;
  let api: ReturnType<typeof makeStubApi>["api"];
  let enqueue: ReturnType<typeof makeStubApi>["enqueueNextTurnInjection"];
  let rejectHandler: ReturnType<
    typeof createPlanModeSessionActions
  >[number]["handler"];

  beforeEach(() => {
    gw = new InMemoryGateway();
    store = new PlanModeStore(gw);
    const stub = makeStubApi();
    api = stub.api;
    enqueue = stub.enqueueNextTurnInjection;
    const actions = createPlanModeSessionActions({ api, store });
    rejectHandler = actions.find((a) => a.id === "plan.reject")!.handler;
    gw.seed(SESSION_KEY, planModeSession());
  });

  it("transitions approval to rejected and increments rejectionCount", async () => {
    const r = await rejectHandler({
      pluginId: "smarter-claw",
      actionId: "plan.reject",
      sessionKey: SESSION_KEY,
      payload: { approvalId: APPROVAL_ID, feedback: "step 2 wrong" },
    });
    if (!r || !r.ok) throw new Error("expected ok");
    expect(r.result).toMatchObject({
      approval: "rejected",
      rejectionCount: 1,
    });
    const persisted = gw.peek(SESSION_KEY)!;
    expect(persisted.approval).toBe("rejected");
    expect(persisted.rejectionCount).toBe(1);
    expect(persisted.feedback).toBe("step 2 wrong");
  });

  it("enqueues a rejected injection with feedback + rejectionCount", async () => {
    await rejectHandler({
      pluginId: "smarter-claw",
      actionId: "plan.reject",
      sessionKey: SESSION_KEY,
      payload: { approvalId: APPROVAL_ID, feedback: "bad plan" },
    });
    const call = enqueue.mock.calls[0][0];
    expect(call.text).toMatch(/^\[PLAN_DECISION\]: rejected/);
    expect(call.text).toMatch(/feedback: "bad plan"/);
    expect(call.idempotencyKey).toBe(
      `smarter-claw:plan_decision:${APPROVAL_ID}:rejected`,
    );
    expect(call.metadata).toMatchObject({
      kind: "plan_decision",
      decision: "rejected",
      rejectionCount: 1,
    });
  });

  it("emits the deescalation hint at rejectionCount=3", async () => {
    gw.seed(SESSION_KEY, planModeSession({ rejectionCount: 2 }));
    await rejectHandler({
      pluginId: "smarter-claw",
      actionId: "plan.reject",
      sessionKey: SESSION_KEY,
      payload: { approvalId: APPROVAL_ID, feedback: "still bad" },
    });
    const call = enqueue.mock.calls[0][0];
    expect(call.text).toMatch(/Multiple revisions have been rejected/);
  });

  it("works without feedback", async () => {
    const r = await rejectHandler({
      pluginId: "smarter-claw",
      actionId: "plan.reject",
      sessionKey: SESSION_KEY,
      payload: { approvalId: APPROVAL_ID },
    });
    if (!r || !r.ok) throw new Error("expected ok");
    expect(gw.peek(SESSION_KEY)?.approval).toBe("rejected");
  });

  it("rejects with STALE_APPROVAL_ID when expectedApprovalId mismatches", async () => {
    const r = await rejectHandler({
      pluginId: "smarter-claw",
      actionId: "plan.reject",
      sessionKey: SESSION_KEY,
      payload: { approvalId: "plan-different", feedback: "x" },
    });
    if (!r || r.ok !== false) throw new Error("expected error");
    expect(r.code).toBe(SESSION_ACTION_ERROR_CODES.STALE_APPROVAL_ID);
    expect(gw.peek(SESSION_KEY)?.approval).toBe("pending");
  });
});

describe("P-12 session-actions — plan.cancel", () => {
  it("transitions to normal mode via exitPlanMode", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.cancel")!.handler;
    gw.seed(SESSION_KEY, planModeSession());

    const r = await handler({
      pluginId: "smarter-claw",
      actionId: "plan.cancel",
      sessionKey: SESSION_KEY,
    });
    if (!r || !r.ok) throw new Error("expected ok");
    expect(r.continueAgent).toBe(false);
    expect(gw.peek(SESSION_KEY)?.mode).toBe("normal");
  });

  it("idempotent: no-op when already in normal mode", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.cancel")!.handler;
    gw.seed(SESSION_KEY, planModeSession({ mode: "normal" }));

    const r = await handler({
      pluginId: "smarter-claw",
      actionId: "plan.cancel",
      sessionKey: SESSION_KEY,
    });
    if (!r || !r.ok) throw new Error("expected ok");
    if (r.result && typeof r.result === "object" && "kind" in r.result) {
      expect((r.result as { kind: string }).kind).toBe("noop");
    }
  });

  it("rejects with MISSING_SESSION_KEY when no sessionKey", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.cancel")!.handler;
    const r = await handler({
      pluginId: "smarter-claw",
      actionId: "plan.cancel",
    });
    if (!r || r.ok !== false) throw new Error("expected error");
    expect(r.code).toBe(SESSION_ACTION_ERROR_CODES.MISSING_SESSION_KEY);
  });
});

describe("P-12 session-actions — plan.answer", () => {
  it("enqueues a question-answer injection with the user's selectedOption", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api, enqueueNextTurnInjection } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.answer")!.handler;

    const r = await handler({
      pluginId: "smarter-claw",
      actionId: "plan.answer",
      sessionKey: SESSION_KEY,
      payload: {
        questionId: "q-1",
        questionPrompt: "Which lint?",
        selectedOption: "eslint v9",
      },
    });
    if (!r || !r.ok) throw new Error("expected ok");
    const call = enqueueNextTurnInjection.mock.calls[0][0];
    expect(call.text).toMatch(/^\[QUESTION_ANSWER\]: "eslint v9"/);
    expect(call.idempotencyKey).toBe("smarter-claw:question_answer:q-1");
  });

  it("rejects with INVALID_PAYLOAD when required fields missing", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.answer")!.handler;

    const r = await handler({
      pluginId: "smarter-claw",
      actionId: "plan.answer",
      sessionKey: SESSION_KEY,
      payload: { questionId: "q-1" }, // missing prompt + option
    });
    if (!r || r.ok !== false) throw new Error("expected error");
    expect(r.code).toBe(SESSION_ACTION_ERROR_CODES.INVALID_PAYLOAD);
  });
});

describe("P-12 session-actions — plan.auto.toggle", () => {
  it("accepts a boolean enabled payload", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.auto.toggle")!.handler;

    const r = await handler({
      pluginId: "smarter-claw",
      actionId: "plan.auto.toggle",
      sessionKey: SESSION_KEY,
      payload: { enabled: true },
    });
    if (!r || !r.ok) throw new Error("expected ok");
    expect((r.result as { enabled: boolean }).enabled).toBe(true);
  });

  it("rejects with INVALID_PAYLOAD when enabled is missing or non-boolean", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.auto.toggle")!.handler;

    const r = await handler({
      pluginId: "smarter-claw",
      actionId: "plan.auto.toggle",
      sessionKey: SESSION_KEY,
      payload: { enabled: "yes" }, // wrong type
    });
    if (!r || r.ok !== false) throw new Error("expected error");
    expect(r.code).toBe(SESSION_ACTION_ERROR_CODES.INVALID_PAYLOAD);
  });
});

describe("P-12 session-actions — payload type guards", () => {
  it("rejects non-object payload with INVALID_PAYLOAD", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.accept")!.handler;
    gw.seed(SESSION_KEY, planModeSession());

    const r = await handler({
      pluginId: "smarter-claw",
      actionId: "plan.accept",
      sessionKey: SESSION_KEY,
      payload: "not-an-object" as never,
    });
    if (!r || r.ok !== false) throw new Error("expected error");
    expect(r.code).toBe(SESSION_ACTION_ERROR_CODES.INVALID_PAYLOAD);
  });

  it("accepts undefined payload (no fields)", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { api } = makeStubApi();
    const actions = createPlanModeSessionActions({ api, store });
    const handler = actions.find((a) => a.id === "plan.accept")!.handler;
    gw.seed(SESSION_KEY, planModeSession());

    const r = await handler({
      pluginId: "smarter-claw",
      actionId: "plan.accept",
      sessionKey: SESSION_KEY,
    });
    if (!r || !r.ok) throw new Error("expected ok");
  });
});
