/**
 * Ported from openclaw-1: src/auto-reply/reply/commands-plan.test.ts
 *
 * Adapted for Smarter-Claw API:
 *   - The openclaw-1 file mocked `gateway/call.js` (`callGateway`),
 *     `globals.js` (`logVerbose`), `infra/channel-approval-auth.js`,
 *     and various reply-handler internals. Smarter-Claw's surface is
 *     `createPlanCommandHandler({ resolveSession, applyPlanPatch, ... })`
 *     — pure dep injection, no host imports to mock.
 *   - The handler returns `{ text: string }` (PluginCommandResult /
 *     ReplyPayload) instead of `{ shouldContinue, reply }`. Reshape
 *     assertions accordingly.
 *   - Session shape uses `pluginMetadata: { "smarter-claw":
 *     <SmarterClawSessionState> }` instead of openclaw-1's flat
 *     `planMode` / `pendingInteraction` fields. SmarterClawSessionState
 *     uses the namespaced approval vocabulary
 *     (idle | proposed | awaiting-approval | approved | rejected).
 *   - The "isAuthorizedSender" auth-skip semantics are upstream-only
 *     (the host plugin-command dispatcher checks before invoking the
 *     handler); the plugin handler itself does not gate on it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApplyPlanPatch,
  createPlanCommandHandler,
  parsePlanCommand,
  type PlanCommandHandlerDeps,
} from "../src/slash-commands.js";
import { SMARTER_CLAW_PLUGIN_ID, type SmarterClawSessionState } from "../src/types.js";

function makeSession(state?: Partial<SmarterClawSessionState>): Record<string, unknown> {
  if (!state) {
    return {};
  }
  const fullState: SmarterClawSessionState = {
    planMode: "normal",
    planApproval: "idle",
    autoApprove: false,
    ...state,
  };
  return {
    pluginMetadata: {
      [SMARTER_CLAW_PLUGIN_ID]: fullState,
    },
  };
}

function makeCtx(args: {
  body: string;
  channel?: string;
  sessionKey?: string;
}): Parameters<ReturnType<typeof createPlanCommandHandler>>[0] {
  // Cast through unknown — tests don't exercise the channel binding APIs.
  return {
    senderId: "u1",
    channel: args.channel ?? "telegram",
    isAuthorizedSender: true,
    sessionKey: args.sessionKey ?? "agent:main:main",
    args: args.body.replace(/^\/?plan\s*/i, "").trim() || undefined,
    commandBody: args.body,
    config: {} as unknown as Parameters<
      ReturnType<typeof createPlanCommandHandler>
    >[0]["config"],
  } as unknown as Parameters<ReturnType<typeof createPlanCommandHandler>>[0];
}

describe("parsePlanCommand", () => {
  it("returns null for non-plan input", () => {
    expect(parsePlanCommand("hello", "telegram")).toBeNull();
  });

  it("/plan with no args parses as status", () => {
    const result = parsePlanCommand("/plan", "telegram");
    expect(result).toEqual({ ok: true, sub: { kind: "status" } });
  });

  it("/plan accept parses as accept (allowEdits=false)", () => {
    expect(parsePlanCommand("/plan accept", "telegram")).toEqual({
      ok: true,
      sub: { kind: "accept", allowEdits: false },
    });
  });

  it("/plan accept edits parses as accept (allowEdits=true)", () => {
    expect(parsePlanCommand("/plan accept edits", "telegram")).toEqual({
      ok: true,
      sub: { kind: "accept", allowEdits: true },
    });
  });

  it("/plan accept editss is rejected as unknown argument", () => {
    const result = parsePlanCommand("/plan accept editss", "telegram");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("editss");
  });

  it("/plan accept edits now is rejected as trailing argument", () => {
    const result = parsePlanCommand("/plan accept edits now", "telegram");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("trailing");
  });

  it("/plan revise <feedback> parses with feedback", () => {
    expect(parsePlanCommand("/plan revise add error handling", "telegram")).toEqual({
      ok: true,
      sub: { kind: "revise", feedback: "add error handling" },
    });
  });

  it("/plan revise without feedback is rejected", () => {
    const result = parsePlanCommand("/plan revise", "telegram");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("Usage: /plan revise");
  });

  it("/plan auto with no arg defaults to autoEnabled=true", () => {
    expect(parsePlanCommand("/plan auto", "telegram")).toEqual({
      ok: true,
      sub: { kind: "auto", autoEnabled: true },
    });
  });

  it("/plan auto on enables", () => {
    expect(parsePlanCommand("/plan auto on", "telegram")).toEqual({
      ok: true,
      sub: { kind: "auto", autoEnabled: true },
    });
  });

  it("/plan auto off disables", () => {
    expect(parsePlanCommand("/plan auto off", "telegram")).toEqual({
      ok: true,
      sub: { kind: "auto", autoEnabled: false },
    });
  });

  it("/plan auto bogus is rejected", () => {
    const result = parsePlanCommand("/plan auto bogus", "telegram");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("Unrecognized");
  });

  it("/plan on parses", () => {
    expect(parsePlanCommand("/plan on", "telegram")).toEqual({
      ok: true,
      sub: { kind: "on" },
    });
  });

  it("/plan off parses", () => {
    expect(parsePlanCommand("/plan off", "telegram")).toEqual({
      ok: true,
      sub: { kind: "off" },
    });
  });

  it("rejects /plan@otherbot mention prefix on Telegram", () => {
    const result = parsePlanCommand("/plan@otherbot accept", "telegram");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("targets a different");
  });

  it("does NOT reject /plan@<word> on non-Telegram channels", () => {
    // On Discord/Slack the parser doesn't fire its Telegram-specific
    // foreign-bot guard — the body either falls through or matches
    // however the parser sees it.
    const result = parsePlanCommand("/plan@alice accept", "discord");
    if (result && !result.ok) {
      expect(result.error).not.toContain("targets a different");
    }
  });

  it("rejects trailing tokens after /plan off", () => {
    const result = parsePlanCommand("/plan off later", "telegram");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("trailing");
  });

  it("rejects trailing tokens after /plan on", () => {
    const result = parsePlanCommand("/plan on please", "telegram");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("trailing");
  });

  it("rejects trailing tokens after /plan status", () => {
    const result = parsePlanCommand("/plan status now", "telegram");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("trailing");
  });
});

describe("createPlanCommandHandler", () => {
  let applyPlanPatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    applyPlanPatch = vi.fn(async () => undefined);
  });

  function deps(overrides: Partial<PlanCommandHandlerDeps> = {}): PlanCommandHandlerDeps {
    return {
      applyPlanPatch: applyPlanPatch as unknown as ApplyPlanPatch,
      ...overrides,
    };
  }

  it("/plan returns plan-mode-off status when no session state present", async () => {
    const handler = createPlanCommandHandler(deps());
    const result = await handler(makeCtx({ body: "/plan" }));
    expect(result.text).toContain("Plan mode is **off**");
  });

  it("/plan status with active plan-mode session reports mode + approval state", async () => {
    const handler = createPlanCommandHandler(
      deps({
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "awaiting-approval",
            autoApprove: true,
          }),
      }),
    );
    const result = await handler(makeCtx({ body: "/plan status" }));
    expect(result.text).toContain("plan");
    expect(result.text).toContain("awaiting-approval");
    expect(result.text).toContain("Auto-approve: **on**");
  });

  it("/plan view points users to /plan restate on text channels", async () => {
    const handler = createPlanCommandHandler(deps());
    const result = await handler(makeCtx({ body: "/plan view" }));
    expect(result.text).toContain("Use /plan restate");
  });

  it("/plan accept without an active pending approval bails with friendly error", async () => {
    const handler = createPlanCommandHandler(deps({ resolveSession: () => makeSession() }));
    const result = await handler(makeCtx({ body: "/plan accept" }));
    expect(applyPlanPatch).not.toHaveBeenCalled();
    expect(result.text).toContain("No pending plan to accept");
  });

  it("/plan accept patches with action=approve when pending approval exists", async () => {
    const handler = createPlanCommandHandler(
      deps({
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "awaiting-approval",
            pendingInteraction: {
              kind: "approval",
              approvalId: "a1",
              deliveredAt: "2026-04-22T00:00:00Z",
            },
          }),
      }),
    );
    await handler(makeCtx({ body: "/plan accept" }));
    expect(applyPlanPatch).toHaveBeenCalledTimes(1);
    expect(applyPlanPatch.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:main:main",
      patch: { planApproval: { action: "approve", approvalId: "a1" } },
    });
  });

  it("/plan accept edits patches with action=edit", async () => {
    const handler = createPlanCommandHandler(
      deps({
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "awaiting-approval",
            pendingInteraction: {
              kind: "approval",
              approvalId: "a2",
              deliveredAt: "2026-04-22T00:00:00Z",
            },
          }),
      }),
    );
    await handler(makeCtx({ body: "/plan accept edits" }));
    expect(applyPlanPatch.mock.calls[0]?.[0]).toMatchObject({
      patch: { planApproval: { action: "edit", approvalId: "a2" } },
    });
  });

  it("/plan revise <feedback> patches with action=reject + feedback", async () => {
    const handler = createPlanCommandHandler(
      deps({
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "proposed",
            pendingInteraction: {
              kind: "approval",
              approvalId: "a1",
              deliveredAt: "2026-04-22T00:00:00Z",
            },
          }),
      }),
    );
    await handler(makeCtx({ body: "/plan revise add error handling" }));
    expect(applyPlanPatch.mock.calls[0]?.[0]).toMatchObject({
      patch: {
        planApproval: { action: "reject", feedback: "add error handling", approvalId: "a1" },
      },
    });
  });

  it("/plan revise without feedback rejects with usage error", async () => {
    const handler = createPlanCommandHandler(deps());
    const result = await handler(makeCtx({ body: "/plan revise" }));
    expect(applyPlanPatch).not.toHaveBeenCalled();
    expect(result.text).toContain("Usage: /plan revise");
  });

  it("/plan answer threads approvalId from pendingInteraction", async () => {
    const handler = createPlanCommandHandler(
      deps({
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "idle",
            pendingInteraction: {
              kind: "question",
              approvalId: "q-approval-1",
              deliveredAt: "2026-04-22T00:00:00Z",
            },
          }),
      }),
    );
    await handler(makeCtx({ body: "/plan answer Option A" }));
    expect(applyPlanPatch.mock.calls[0]?.[0]).toMatchObject({
      patch: {
        planApproval: { action: "answer", answer: "Option A", approvalId: "q-approval-1" },
      },
    });
  });

  it("/plan answer without a pending question bails with friendly error", async () => {
    const handler = createPlanCommandHandler(deps({ resolveSession: () => makeSession() }));
    const result = await handler(makeCtx({ body: "/plan answer Option A" }));
    expect(applyPlanPatch).not.toHaveBeenCalled();
    expect(result.text).toContain("No pending ask_user_question");
  });

  it("/plan auto on enables auto-approve via apply", async () => {
    const handler = createPlanCommandHandler(deps());
    await handler(makeCtx({ body: "/plan auto on" }));
    expect(applyPlanPatch.mock.calls[0]?.[0]).toMatchObject({
      patch: { planApproval: { action: "auto", autoEnabled: true } },
    });
  });

  it("/plan on patches planMode='plan'", async () => {
    const handler = createPlanCommandHandler(deps());
    const result = await handler(makeCtx({ body: "/plan on" }));
    expect(applyPlanPatch.mock.calls[0]?.[0]).toMatchObject({
      patch: { planMode: "plan" },
    });
    expect(result.text).toContain("**enabled**");
  });

  it("/plan off patches planMode='normal'", async () => {
    const handler = createPlanCommandHandler(deps());
    const result = await handler(makeCtx({ body: "/plan off" }));
    expect(applyPlanPatch.mock.calls[0]?.[0]).toMatchObject({
      patch: { planMode: "normal" },
    });
    expect(result.text).toContain("**disabled**");
  });

  it("/plan restate without an active plan returns a friendly message", async () => {
    const handler = createPlanCommandHandler(deps({ resolveSession: () => makeSession() }));
    const result = await handler(makeCtx({ body: "/plan restate" }));
    expect(applyPlanPatch).not.toHaveBeenCalled();
    expect(result.text).toContain("No active plan to restate");
  });

  it("/plan restate renders the plan checklist (Telegram → HTML)", async () => {
    const handler = createPlanCommandHandler(
      deps({
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "proposed",
            lastPlanSteps: {
              title: "Test plan",
              steps: [
                { index: 1, description: "Read the docs", done: true },
                { index: 2, description: "Wire the handler", done: false },
                { index: 3, description: "Add tests", done: false },
              ],
            },
          }),
      }),
    );
    const result = await handler(makeCtx({ body: "/plan restate", channel: "telegram" }));
    expect(result.text).toContain("<b>Current plan:</b>");
  });

  it("/plan restate uses Slack mrkdwn on Slack channels", async () => {
    const handler = createPlanCommandHandler(
      deps({
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "proposed",
            lastPlanSteps: {
              title: "Test",
              steps: [{ index: 1, description: "Hello" }],
            },
          }),
      }),
    );
    const result = await handler(makeCtx({ body: "/plan restate", channel: "slack" }));
    expect(result.text?.startsWith("*Current plan:*")).toBe(true);
  });

  it("/plan restate uses plaintext on iMessage / Signal channels (markdown-incapable)", async () => {
    const handler = createPlanCommandHandler(
      deps({
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "proposed",
            lastPlanSteps: {
              title: "Test",
              steps: [{ index: 1, description: "Hello" }],
            },
          }),
        isMarkdownCapableChannel: (ch) => !["imessage", "signal", "voice-call"].includes(ch),
      }),
    );
    const result = await handler(makeCtx({ body: "/plan restate", channel: "imessage" }));
    expect(result.text?.startsWith("Current plan:")).toBe(true);
    expect(result.text).not.toContain("<b>");
    expect(result.text).not.toContain("*Current");
  });

  it("rejects /plan@otherbot mention prefix on Telegram (handler echoes parser error)", async () => {
    const handler = createPlanCommandHandler(deps());
    const result = await handler(
      makeCtx({ body: "/plan@otherbot accept", channel: "telegram" }),
    );
    expect(applyPlanPatch).not.toHaveBeenCalled();
    expect(result.text).toContain("targets a different");
  });

  it("maps gateway 'stale approvalId' error to a friendly chat message", async () => {
    const failingApply = vi.fn(async () => {
      throw new Error(
        "planApproval ignored: stale approvalId or session is in a terminal approval state",
      );
    });
    const handler = createPlanCommandHandler(
      deps({
        applyPlanPatch: failingApply as unknown as ApplyPlanPatch,
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "awaiting-approval",
            pendingInteraction: {
              kind: "approval",
              approvalId: "old",
              deliveredAt: "2026-04-22T00:00:00Z",
            },
          }),
      }),
    );
    const result = await handler(makeCtx({ body: "/plan accept" }));
    expect(result.text).toContain("Plan was already resolved");
  });

  it("maps the fail-closed subagent gate-unavailable error to a friendly retry message", async () => {
    const failingApply = vi.fn(async () => {
      throw new Error("PLAN_APPROVAL_GATE_STATE_UNAVAILABLE: gate state unavailable");
    });
    const handler = createPlanCommandHandler(
      deps({
        applyPlanPatch: failingApply as unknown as ApplyPlanPatch,
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "awaiting-approval",
            pendingInteraction: {
              kind: "approval",
              approvalId: "approval-1",
              deliveredAt: "2026-04-22T00:00:00Z",
            },
          }),
      }),
    );
    const result = await handler(makeCtx({ body: "/plan accept" }));
    expect(result.text).toContain("Refresh the session");
  });

  it("surfaces 'plan mode is disabled' config error legibly", async () => {
    const failingApply = vi.fn(async () => {
      throw new Error(
        "plan mode is disabled — set agents.defaults.planMode.enabled: true to enable",
      );
    });
    const handler = createPlanCommandHandler(
      deps({ applyPlanPatch: failingApply as unknown as ApplyPlanPatch }),
    );
    const result = await handler(makeCtx({ body: "/plan on" }));
    expect(result.text).toContain("Plan mode is disabled");
  });

  it("surfaces other gateway errors with the raw message prefix", async () => {
    const failingApply = vi.fn(async () => {
      throw new Error("network blip");
    });
    const handler = createPlanCommandHandler(
      deps({
        applyPlanPatch: failingApply as unknown as ApplyPlanPatch,
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "awaiting-approval",
            pendingInteraction: {
              kind: "approval",
              approvalId: "a3",
              deliveredAt: "2026-04-22T00:00:00Z",
            },
          }),
      }),
    );
    const result = await handler(makeCtx({ body: "/plan accept" }));
    expect(result.text).toContain("Failed to apply /plan command");
    expect(result.text).toContain("network blip");
  });

  it("/plan restate truncates output above the channel size cap", async () => {
    const longSteps = Array.from({ length: 100 }, (_, i) => ({
      index: i + 1,
      description: `step ${i.toString().padStart(3, "0")} — long descriptive sentence text`,
    }));
    const handler = createPlanCommandHandler(
      deps({
        resolveSession: () =>
          makeSession({
            planMode: "plan",
            planApproval: "proposed",
            lastPlanSteps: { title: "Long plan", steps: longSteps },
          }),
      }),
    );
    const result = await handler(makeCtx({ body: "/plan restate", channel: "telegram" }));
    expect(result.text).toBeDefined();
    expect(result.text!.length).toBeLessThanOrEqual(4096);
    expect(result.text).toContain("more step");
  });
});
