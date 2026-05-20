/**
 * `/plan` slash-command tests.
 *
 * Covers the command dispatcher: subcommand routing, the `/plan enter`
 * store path, the dispatcher's try/catch error guard, and the
 * `/plan answer` cross-surface flow (Wave-1 W1-F5).
 */

import { describe, expect, it, vi } from "vitest";
import {
  createPlanSlashCommand,
  createPlanModeSlashCommand,
  type CreatePlanSlashCommandInput,
} from "../../src/ui/slash-commands.js";
import type { PlanModeStore } from "../../src/state/store.js";

const SESSION_KEY = "agent:main:main";

type ActionHandler = CreatePlanSlashCommandInput["actions"] extends Map<
  string,
  infer H
>
  ? H
  : never;

function makeInput(overrides?: {
  actions?: Map<string, ActionHandler>;
  store?: Partial<PlanModeStore>;
}): CreatePlanSlashCommandInput {
  const okHandler: ActionHandler = vi.fn(async () => ({
    ok: true as const,
    continueAgent: true,
  }));
  const actions =
    overrides?.actions ??
    new Map<string, ActionHandler>([
      ["plan.accept", okHandler],
      ["plan.edit", okHandler],
      ["plan.reject", okHandler],
      ["plan.cancel", okHandler],
      ["plan.auto.toggle", okHandler],
    ]);
  const store = {
    enterPlanMode: vi.fn(async () => ({
      kind: "entered" as const,
      state: {} as never,
    })),
    ...overrides?.store,
  } as unknown as PlanModeStore;
  return { actions, store };
}

function cmdCtx(args: string, opts?: { noSession?: boolean }) {
  return {
    channel: "chat",
    isAuthorizedSender: true,
    commandBody: `/plan ${args}`,
    args,
    config: {} as never,
    // Default carries a sessionKey; pass { noSession: true } to omit it.
    ...(opts?.noSession ? {} : { sessionKey: SESSION_KEY }),
  };
}

describe("/plan slash command — registration shape", () => {
  it("createPlanSlashCommand returns a `plan` command accepting args", () => {
    const cmd = createPlanSlashCommand(makeInput());
    expect(cmd.name).toBe("plan");
    expect(cmd.acceptsArgs).toBe(true);
    expect(typeof cmd.handler).toBe("function");
  });

  it("createPlanModeSlashCommand returns a `plan-mode` alias", () => {
    const cmd = createPlanModeSlashCommand(makeInput());
    expect(cmd.name).toBe("plan-mode");
    expect(cmd.acceptsArgs).toBe(true);
  });

  it("`/plan` sets NO `channels` filter — canonical command on every channel", () => {
    // `/plan` must stay eligible for every channel's native menu AND
    // the universal text pipeline. A `channels` filter would narrow
    // both. It is the primary plan-mode command on Telegram included.
    expect(createPlanSlashCommand(makeInput()).channels).toBeUndefined();
  });

  it("`/plan-mode` alias EXCLUDES telegram from `channels` (W1-S18-1)", () => {
    // The alias is scoped off Telegram so it does not consume a second
    // scarce Telegram native-menu slot (100-command cap). It stays
    // functional on webchat / Slack / Discord / CLI. `pluginCommand-
    // SupportsChannel` gates BOTH dispatch paths with this list, so on
    // Telegram `/plan-mode` is fully off (menu + text) — `/plan` is the
    // Telegram surface. See the doc comment in slash-commands.ts.
    const channels = createPlanModeSlashCommand(makeInput()).channels;
    expect(channels).toBeDefined();
    expect(channels).not.toContain("telegram");
    // Positive: the alias is still available on the non-Telegram
    // channels (it must remain reachable everywhere else).
    expect(channels).toEqual(
      expect.arrayContaining(["webchat", "slack", "discord", "cli"]),
    );
  });

  it("both commands expose `agentPromptGuidance` (Telegram-menu fallback)", () => {
    // When the Telegram native "/" menu is full and drops `/plan`, the
    // host injects this guidance into the agent's system prompt so the
    // agent can still tell the user to type `/plan accept` etc.
    const planGuidance = createPlanSlashCommand(makeInput()).agentPromptGuidance;
    expect(planGuidance).toBeDefined();
    expect(planGuidance!.length).toBeGreaterThan(0);
    expect(planGuidance!.join(" ")).toMatch(/\/plan accept/);
    expect(
      createPlanModeSlashCommand(makeInput()).agentPromptGuidance,
    ).toBeDefined();
  });
});

describe("/plan slash command — usage", () => {
  it("no args returns usage text", async () => {
    const cmd = createPlanSlashCommand(makeInput());
    const r = await cmd.handler(cmdCtx(""));
    expect(r.text).toMatch(/Plan-mode commands:/);
    expect(r.text).toMatch(/\/plan enter/);
  });

  it("unknown subcommand returns a help pointer", async () => {
    const cmd = createPlanSlashCommand(makeInput());
    const r = await cmd.handler(cmdCtx("frobnicate"));
    expect(r.text).toMatch(/Unknown \/plan subcommand/);
  });
});

describe("/plan slash command — approval routing", () => {
  it("/plan accept dispatches plan.accept", async () => {
    const input = makeInput();
    const handler = input.actions.get("plan.accept")!;
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("accept"));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "plan.accept", sessionKey: SESSION_KEY }),
    );
    expect(r.text).toMatch(/Plan approved/);
    expect(r.continueAgent).toBe(true);
  });

  it("/plan approve is an alias for accept", async () => {
    const input = makeInput();
    const cmd = createPlanSlashCommand(input);
    await cmd.handler(cmdCtx("approve"));
    expect(input.actions.get("plan.accept")).toHaveBeenCalled();
  });

  it("/plan edit <body> dispatches plan.edit with the body", async () => {
    const input = makeInput();
    const handler = input.actions.get("plan.edit")!;
    const cmd = createPlanSlashCommand(input);
    await cmd.handler(cmdCtx("edit revised step one\nrevised step two"));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "plan.edit",
        payload: { body: "revised step one\nrevised step two" },
      }),
    );
  });

  it("/plan edit without a body returns an error (no dispatch)", async () => {
    const input = makeInput();
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("edit"));
    expect(r.text).toMatch(/requires an edited body/);
    expect(input.actions.get("plan.edit")).not.toHaveBeenCalled();
  });

  it("/plan reject forwards optional feedback", async () => {
    const input = makeInput();
    const handler = input.actions.get("plan.reject")!;
    const cmd = createPlanSlashCommand(input);
    await cmd.handler(cmdCtx("reject too many steps"));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "plan.reject",
        payload: { feedback: "too many steps" },
      }),
    );
  });

  it("/plan reject with no feedback dispatches an empty payload", async () => {
    const input = makeInput();
    const handler = input.actions.get("plan.reject")!;
    const cmd = createPlanSlashCommand(input);
    await cmd.handler(cmdCtx("reject"));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "plan.reject", payload: {} }),
    );
  });

  it("/plan cancel and /plan exit both dispatch plan.cancel", async () => {
    const input = makeInput();
    const cmd = createPlanSlashCommand(input);
    await cmd.handler(cmdCtx("cancel"));
    await cmd.handler(cmdCtx("exit"));
    expect(input.actions.get("plan.cancel")).toHaveBeenCalledTimes(2);
  });

  it("/plan auto on|off dispatches plan.auto.toggle with the right flag", async () => {
    const input = makeInput();
    const handler = input.actions.get("plan.auto.toggle")!;
    const cmd = createPlanSlashCommand(input);
    await cmd.handler(cmdCtx("auto on"));
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: { enabled: true } }),
    );
    await cmd.handler(cmdCtx("auto off"));
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: { enabled: false } }),
    );
  });

  it("/plan auto with no on|off arg returns an error", async () => {
    const cmd = createPlanSlashCommand(makeInput());
    const r = await cmd.handler(cmdCtx("auto"));
    expect(r.text).toMatch(/requires `on` or `off`/);
  });
});

describe("/plan enter — store path", () => {
  it("/plan enter calls store.enterPlanMode and reports success", async () => {
    const input = makeInput();
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("enter"));
    expect(input.store.enterPlanMode).toHaveBeenCalledWith({
      sessionKey: SESSION_KEY,
    });
    expect(r.text).toMatch(/Plan mode entered/);
  });

  it("/plan enter reports the noop case when already in plan mode", async () => {
    const input = makeInput({
      store: {
        enterPlanMode: vi.fn(async () => ({
          kind: "noop" as const,
          state: {} as never,
        })),
      },
    });
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("enter"));
    expect(r.text).toMatch(/Already in plan mode/);
  });

  it("/plan enter surfaces a store failure as a clean reply", async () => {
    const input = makeInput({
      store: {
        enterPlanMode: vi.fn(async () => ({
          kind: "failed" as const,
          error: new Error("disk full"),
        })),
      },
    });
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("enter"));
    expect(r.text).toMatch(/\/plan enter failed: disk full/);
  });

  it("/plan enter surfaces a thrown store error as a clean reply", async () => {
    const input = makeInput({
      store: {
        enterPlanMode: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("enter"));
    expect(r.text).toMatch(/\/plan enter failed: boom/);
  });

  it("/plan enter without a sessionKey returns a clean reply", async () => {
    const cmd = createPlanSlashCommand(makeInput());
    const r = await cmd.handler(cmdCtx("enter", { noSession: true }));
    expect(r.text).toMatch(/requires a session context/);
  });
});

describe("/plan answer — W1-F5 cross-surface answer", () => {
  // Helper: build a store stub with a configurable pendingQuestion
  // and clear semantics.
  function storeWithPendingQuestion(pending?: {
    questionId: string;
    questionPrompt: string;
    options: string[];
    allowFreetext: boolean;
  }) {
    const clearCalls: Array<{ sessionKey: string; expectedQuestionId?: string }> = [];
    return {
      store: {
        readSnapshot: vi.fn(async () => {
          if (!pending) return undefined;
          return {
            mode: "plan" as const,
            approval: "none" as const,
            rejectionCount: 0,
            pendingQuestion: { ...pending, askedAt: Date.now() },
          };
        }),
        clearPendingQuestion: vi.fn(async (input: { sessionKey: string; expectedQuestionId?: string }) => {
          clearCalls.push(input);
          return { kind: "cleared" as const, state: {} as never };
        }),
        enterPlanMode: vi.fn(async () => ({
          kind: "entered" as const,
          state: {} as never,
        })),
      } as unknown as PlanModeStore,
      clearCalls,
    };
  }

  it("with no pending question, returns a friendly 'no pending' reply and does NOT dispatch", async () => {
    const { store } = storeWithPendingQuestion(undefined);
    const planAnswer = vi.fn(async () => ({ ok: true as const })) as ActionHandler;
    const input = {
      actions: new Map<string, ActionHandler>([["plan.answer", planAnswer]]),
      store,
    };
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("answer something"));
    expect(r.text).toMatch(/No pending question/);
    expect(planAnswer).not.toHaveBeenCalled();
  });

  it("requires a non-empty tail (the answer text)", async () => {
    const { store } = storeWithPendingQuestion({
      questionId: "q-abc",
      questionPrompt: "Pick a color",
      options: ["red", "blue"],
      allowFreetext: false,
    });
    const planAnswer = vi.fn(async () => ({ ok: true as const })) as ActionHandler;
    const input = {
      actions: new Map<string, ActionHandler>([["plan.answer", planAnswer]]),
      store,
    };
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("answer"));
    expect(r.text).toMatch(/requires an answer/);
    expect(planAnswer).not.toHaveBeenCalled();
  });

  it("requires a session context", async () => {
    const { store } = storeWithPendingQuestion({
      questionId: "q-abc",
      questionPrompt: "Pick a color",
      options: ["red", "blue"],
      allowFreetext: false,
    });
    const planAnswer = vi.fn(async () => ({ ok: true as const })) as ActionHandler;
    const input = {
      actions: new Map<string, ActionHandler>([["plan.answer", planAnswer]]),
      store,
    };
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("answer red", { noSession: true }));
    expect(r.text).toMatch(/requires a session context/);
    expect(planAnswer).not.toHaveBeenCalled();
  });

  it("when allowFreetext=false, rejects an answer NOT in the offered options", async () => {
    const { store } = storeWithPendingQuestion({
      questionId: "q-abc",
      questionPrompt: "Pick a color",
      options: ["red", "blue"],
      allowFreetext: false,
    });
    const planAnswer = vi.fn(async () => ({ ok: true as const })) as ActionHandler;
    const input = {
      actions: new Map<string, ActionHandler>([["plan.answer", planAnswer]]),
      store,
    };
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("answer purple"));
    expect(r.text).toMatch(/not in the offered options/);
    expect(r.text).toMatch(/"red"/);
    expect(r.text).toMatch(/"blue"/);
    expect(planAnswer).not.toHaveBeenCalled();
  });

  it("when allowFreetext=true, accepts an arbitrary answer", async () => {
    const { store } = storeWithPendingQuestion({
      questionId: "q-abc",
      questionPrompt: "Describe the bug",
      options: ["short", "long"],
      allowFreetext: true,
    });
    const planAnswer = vi.fn(async () => ({
      ok: true as const,
      continueAgent: true,
    })) as ActionHandler;
    const input = {
      actions: new Map<string, ActionHandler>([["plan.answer", planAnswer]]),
      store,
    };
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("answer the parser drops trailing newlines"));
    expect(r.text).toMatch(/Answer recorded/);
    expect(planAnswer).toHaveBeenCalledOnce();
    expect(planAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "plan.answer",
        payload: expect.objectContaining({
          questionId: "q-abc",
          selectedOption: "the parser drops trailing newlines",
        }),
      }),
    );
  });

  it("dispatches plan.answer with the correct payload on a valid option choice", async () => {
    const { store, clearCalls } = storeWithPendingQuestion({
      questionId: "q-abc",
      questionPrompt: "Pick a color",
      options: ["red", "blue"],
      allowFreetext: false,
    });
    const planAnswer = vi.fn(async () => ({
      ok: true as const,
      continueAgent: true,
    })) as ActionHandler;
    const input = {
      actions: new Map<string, ActionHandler>([["plan.answer", planAnswer]]),
      store,
    };
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("answer red"));
    expect(planAnswer).toHaveBeenCalledOnce();
    expect(planAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "plan.answer",
        sessionKey: SESSION_KEY,
        payload: {
          questionId: "q-abc",
          questionPrompt: "Pick a color",
          selectedOption: "red",
        },
      }),
    );
    expect(r.text).toMatch(/Answer recorded/);
    // On success, the pending-question slot is cleared
    // (idempotency layer (a)).
    expect(clearCalls).toEqual([
      { sessionKey: SESSION_KEY, expectedQuestionId: "q-abc" },
    ]);
  });

  it("idempotency: a second /plan answer finds the slot cleared and returns 'no pending'", async () => {
    // Simulate two-call sequence by toggling the pending state between
    // calls. After the first /plan answer resolves, real production
    // clears the slot via clearPendingQuestion; we simulate that by
    // returning undefined from readSnapshot on the second call.
    let callCount = 0;
    const pending = {
      questionId: "q-abc",
      questionPrompt: "Pick a color",
      options: ["red", "blue"],
      allowFreetext: false,
    };
    const store = {
      readSnapshot: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            mode: "plan" as const,
            approval: "none" as const,
            rejectionCount: 0,
            pendingQuestion: { ...pending, askedAt: Date.now() },
          };
        }
        return undefined; // second call: cleared
      }),
      clearPendingQuestion: vi.fn(async () => ({
        kind: "cleared" as const,
        state: {} as never,
      })),
      enterPlanMode: vi.fn(async () => ({
        kind: "entered" as const,
        state: {} as never,
      })),
    } as unknown as PlanModeStore;
    const planAnswer = vi.fn(async () => ({
      ok: true as const,
      continueAgent: true,
    })) as ActionHandler;
    const input = {
      actions: new Map<string, ActionHandler>([["plan.answer", planAnswer]]),
      store,
    };
    const cmd = createPlanSlashCommand(input);
    const r1 = await cmd.handler(cmdCtx("answer red"));
    expect(r1.text).toMatch(/Answer recorded/);
    const r2 = await cmd.handler(cmdCtx("answer red"));
    expect(r2.text).toMatch(/No pending question/);
    // The session-action handler fires ONLY for the first call.
    expect(planAnswer).toHaveBeenCalledOnce();
  });

  it("on dispatch failure, does NOT clear the pending-question slot", async () => {
    const { store, clearCalls } = storeWithPendingQuestion({
      questionId: "q-abc",
      questionPrompt: "Pick a color",
      options: ["red", "blue"],
      allowFreetext: false,
    });
    const failing: ActionHandler = vi.fn(async () => {
      throw new Error("handler exploded");
    });
    const input = {
      actions: new Map<string, ActionHandler>([["plan.answer", failing]]),
      store,
    };
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("answer red"));
    expect(r.text).toMatch(/\/plan answer failed/);
    // Question state preserved → user can retry without losing the
    // question context.
    expect(clearCalls).toEqual([]);
  });

  it("accepts the `/plan ans` short alias", async () => {
    const { store } = storeWithPendingQuestion({
      questionId: "q-abc",
      questionPrompt: "Pick a color",
      options: ["red", "blue"],
      allowFreetext: false,
    });
    const planAnswer = vi.fn(async () => ({
      ok: true as const,
      continueAgent: true,
    })) as ActionHandler;
    const input = {
      actions: new Map<string, ActionHandler>([["plan.answer", planAnswer]]),
      store,
    };
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("ans red"));
    expect(planAnswer).toHaveBeenCalledOnce();
    expect(r.text).toMatch(/Answer recorded/);
  });
});

describe("/plan dispatcher — error handling", () => {
  it("a thrown session-action handler becomes a clean reply, not a crash", async () => {
    const throwing: ActionHandler = vi.fn(async () => {
      throw new Error("handler exploded");
    });
    const input = makeInput({
      actions: new Map<string, ActionHandler>([["plan.accept", throwing]]),
    });
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("accept"));
    expect(r.text).toMatch(/\/plan accept failed: handler exploded/);
  });

  it("an ok:false session-action result surfaces its code + error", async () => {
    const failing: ActionHandler = vi.fn(async () => ({
      ok: false as const,
      code: "STALE_APPROVAL_ID",
      error: "approvalId mismatch",
    }));
    const input = makeInput({
      actions: new Map<string, ActionHandler>([["plan.accept", failing]]),
    });
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("accept"));
    expect(r.text).toMatch(/STALE_APPROVAL_ID/);
    expect(r.text).toMatch(/approvalId mismatch/);
  });

  it("a missing session-action registration returns a wiring-bug reply", async () => {
    const input = makeInput({ actions: new Map() });
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("accept"));
    expect(r.text).toMatch(/not registered/);
  });

  it("a dispatched subcommand without a sessionKey returns a clean reply", async () => {
    const cmd = createPlanSlashCommand(makeInput());
    const r = await cmd.handler(cmdCtx("accept", { noSession: true }));
    expect(r.text).toMatch(/require a session context/);
  });
});
