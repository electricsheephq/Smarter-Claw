import { describe, expect, it, vi } from "vitest";
import {
  __resetPlanNotificationTokensForTest,
  createPlanModeNotifications,
  TELEGRAM_PLAN_INTERACTIVE_NAMESPACE,
} from "../../src/runtime/plan-notifications.js";
import { InMemoryGateway } from "../../src/state/in-memory-gateway.js";
import { PlanModeStore } from "../../src/state/store.js";

const SESSION_KEY = "agent:main:main";

function build() {
  __resetPlanNotificationTokensForTest();
  const gw = new InMemoryGateway();
  gw.seed(SESSION_KEY, {
    mode: "plan",
    approval: "pending",
    approvalId: "plan-11111111-1111-4111-8111-111111111111",
    rejectionCount: 0,
  });
  const store = new PlanModeStore(gw);
  let handler: ((ctx: unknown) => Promise<{ handled: true }>) | undefined;
  const sendSessionAttachment = vi.fn(async () => ({
    ok: true as const,
    channel: "telegram",
    deliveredTo: "12345",
    count: 1,
  }));
  const api = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    session: {
      workflow: {
        sendSessionAttachment,
      },
    },
    registerInteractiveHandler: vi.fn((registration: { handler: typeof handler }) => {
      handler = registration.handler;
    }),
  };
  return { gw, store, api, sendSessionAttachment, getHandler: () => handler };
}

function firstButtonValue(call: unknown, label: string): string {
  const presentation = (call as { presentation?: { blocks?: unknown[] } }).presentation;
  const blocks = presentation?.blocks ?? [];
  for (const block of blocks) {
    const buttons = (block as { buttons?: Array<{ label: string; value: string }> }).buttons;
    const found = buttons?.find((button) => button.label === label);
    if (found) return found.value;
  }
  throw new Error(`missing button ${label}`);
}

function telegramCtx(payload: string) {
  return {
    channel: "telegram",
    auth: { isAuthorizedSender: true },
    callback: { payload },
    respond: {
      reply: vi.fn(async () => {}),
      clearButtons: vi.fn(async () => {}),
    },
  };
}

describe("plan notifications", () => {
  it("sends a Markdown plan attachment plus native Telegram approval buttons", async () => {
    const { api, store, sendSessionAttachment } = build();
    const actions = new Map();
    await createPlanModeNotifications({
      api: api as never,
      store,
      actions,
    }).notifyPlanApproval({
      sessionKey: SESSION_KEY,
      approvalId: "plan-11111111-1111-4111-8111-111111111111",
      title: "Ship plan",
      summary: "Review before execution.",
      plan: [{ step: "Run focused tests", status: "pending" }],
      persistedPlan: {
        absPath: "/tmp/plan.md",
        filename: "plan.md",
      },
    });

    expect(api.registerInteractiveHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        namespace: TELEGRAM_PLAN_INTERACTIVE_NAMESPACE,
      }),
    );
    expect(sendSessionAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: SESSION_KEY,
        files: [{ path: "/tmp/plan.md" }],
        forceDocument: true,
        presentation: expect.objectContaining({
          title: "Ship plan",
        }),
      }),
    );
    const attachment = sendSessionAttachment.mock.calls[0]?.[0];
    expect(firstButtonValue(attachment, "Approve")).toMatch(
      new RegExp(`^${TELEGRAM_PLAN_INTERACTIVE_NAMESPACE}:a:`),
    );
  });

  it("dispatches approved Telegram callbacks through plan.accept and clears buttons", async () => {
    const { api, store, sendSessionAttachment, getHandler } = build();
    const accept = vi.fn(async () => ({ ok: true as const, continueAgent: true }));
    const notifications = createPlanModeNotifications({
      api: api as never,
      store,
      actions: new Map([["plan.accept", accept]]),
    });
    await notifications.notifyPlanApproval({
      sessionKey: SESSION_KEY,
      approvalId: "plan-11111111-1111-4111-8111-111111111111",
      title: "Ship plan",
      plan: [{ step: "Run focused tests", status: "pending" }],
    });
    const value = firstButtonValue(sendSessionAttachment.mock.calls[0]?.[0], "Approve");
    const payload = value.slice(`${TELEGRAM_PLAN_INTERACTIVE_NAMESPACE}:`.length);
    const ctx = telegramCtx(payload);

    await getHandler()?.(ctx);

    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "plan.accept",
        sessionKey: SESSION_KEY,
        payload: {
          approvalId: "plan-11111111-1111-4111-8111-111111111111",
        },
      }),
    );
    expect(ctx.respond.clearButtons).toHaveBeenCalledOnce();
    expect(ctx.respond.reply).toHaveBeenCalledWith({
      text: "Plan approved. The agent will resume.",
    });
  });

  it("dispatches Telegram cancel callbacks through plan.cancel with approvalId", async () => {
    const { api, store, sendSessionAttachment, getHandler } = build();
    const cancel = vi.fn(async () => ({ ok: true as const, continueAgent: false }));
    const notifications = createPlanModeNotifications({
      api: api as never,
      store,
      actions: new Map([["plan.cancel", cancel]]),
    });
    await notifications.notifyPlanApproval({
      sessionKey: SESSION_KEY,
      approvalId: "plan-11111111-1111-4111-8111-111111111111",
      title: "Ship plan",
      plan: [{ step: "Run focused tests", status: "pending" }],
    });
    const value = firstButtonValue(sendSessionAttachment.mock.calls[0]?.[0], "Cancel");
    const payload = value.slice(`${TELEGRAM_PLAN_INTERACTIVE_NAMESPACE}:`.length);
    const ctx = telegramCtx(payload);

    await getHandler()?.(ctx);

    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "plan.cancel",
        sessionKey: SESSION_KEY,
        payload: {
          approvalId: "plan-11111111-1111-4111-8111-111111111111",
        },
      }),
    );
    expect(ctx.respond.clearButtons).toHaveBeenCalledOnce();
    expect(ctx.respond.reply).toHaveBeenCalledWith({
      text: "Plan mode cancelled.",
    });
  });

  it("rejects stale Telegram approval callbacks without dispatching the action", async () => {
    const { gw, api, store, sendSessionAttachment, getHandler } = build();
    const accept = vi.fn(async () => ({ ok: true as const }));
    const notifications = createPlanModeNotifications({
      api: api as never,
      store,
      actions: new Map([["plan.accept", accept]]),
    });
    await notifications.notifyPlanApproval({
      sessionKey: SESSION_KEY,
      approvalId: "plan-11111111-1111-4111-8111-111111111111",
      title: "Ship plan",
      plan: [{ step: "Run focused tests", status: "pending" }],
    });
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "pending",
      approvalId: "plan-22222222-2222-4222-8222-222222222222",
      rejectionCount: 0,
    });
    const value = firstButtonValue(sendSessionAttachment.mock.calls[0]?.[0], "Approve");
    const payload = value.slice(`${TELEGRAM_PLAN_INTERACTIVE_NAMESPACE}:`.length);
    const ctx = telegramCtx(payload);

    await getHandler()?.(ctx);

    expect(accept).not.toHaveBeenCalled();
    expect(ctx.respond.clearButtons).toHaveBeenCalledOnce();
    expect(ctx.respond.reply).toHaveBeenCalledWith({
      text: "That plan button is stale. Use /plan status for the current state.",
    });
  });

  it("dispatches Telegram question option callbacks and clears pending question state", async () => {
    const { api, store, sendSessionAttachment, getHandler } = build();
    await store.persistPendingQuestion({
      sessionKey: SESSION_KEY,
      questionId: "q-call-1",
      questionPrompt: "Major or minor bump?",
      options: ["major", "minor"],
      allowFreetext: false,
    });
    const answer = vi.fn(async () => ({ ok: true as const, continueAgent: true }));
    const notifications = createPlanModeNotifications({
      api: api as never,
      store,
      actions: new Map([["plan.answer", answer]]),
    });
    await notifications.notifyQuestion({
      sessionKey: SESSION_KEY,
      questionId: "q-call-1",
      questionPrompt: "Major or minor bump?",
      options: ["major", "minor"],
    });
    const value = firstButtonValue(sendSessionAttachment.mock.calls[0]?.[0], "major");
    const payload = value.slice(`${TELEGRAM_PLAN_INTERACTIVE_NAMESPACE}:`.length);
    const ctx = telegramCtx(payload);

    await getHandler()?.(ctx);

    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "plan.answer",
        sessionKey: SESSION_KEY,
        payload: {
          questionId: "q-call-1",
          questionPrompt: "Major or minor bump?",
          selectedOption: "major",
        },
      }),
    );
    expect((await store.readSnapshot(SESSION_KEY))?.pendingQuestion).toBeUndefined();
    expect(ctx.respond.clearButtons).toHaveBeenCalledOnce();
  });
});
