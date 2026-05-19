/**
 * `/plan` slash-command tests.
 *
 * Covers the command dispatcher: subcommand routing, the `/plan enter`
 * store path, the dispatcher's try/catch error guard, and the
 * `/plan answer` known-gap message.
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

describe("/plan answer — known-gap message", () => {
  it("/plan answer does NOT dispatch and returns the known-gap message", async () => {
    const input = makeInput({
      actions: new Map<string, ActionHandler>([
        ["plan.answer", vi.fn(async () => ({ ok: true as const })) as ActionHandler],
      ]),
    });
    const cmd = createPlanSlashCommand(input);
    const r = await cmd.handler(cmdCtx("answer option one"));
    expect(r.text).toMatch(/approval card/);
    expect(input.actions.get("plan.answer")).not.toHaveBeenCalled();
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
