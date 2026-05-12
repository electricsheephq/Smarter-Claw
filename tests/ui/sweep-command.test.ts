/**
 * P-12 sweep-command tests.
 *
 * Validates the plan-clear CLI registrar:
 *   - registers the `plan-clear` command with the right name + flags
 *   - --session is required and must be non-empty
 *   - reports no-op for sessions in normal mode or with no payload
 *   - --dry-run skips the write
 *   - successful path calls exitPlanMode + logs the kind
 *   - exitPlanMode IO failure logs error and doesn't throw
 */

import { describe, expect, it, vi } from "vitest";
import { createPlanClearCli } from "../../src/ui/sweep-command.js";
import { PlanModeStore } from "../../src/state/store.js";
import { InMemoryGateway } from "../state/in-memory-gateway.js";

const SESSION_KEY = "agent:main:main";

function makeStubCtx() {
  // Simulate commander's chained API
  let actionFn: (opts: Record<string, unknown>) => Promise<void> = async () => {};
  const cmdChain = {
    description: vi.fn().mockReturnThis(),
    requiredOption: vi.fn().mockReturnThis(),
    option: vi.fn().mockReturnThis(),
    action: vi.fn((fn: (opts: Record<string, unknown>) => Promise<void>) => {
      actionFn = fn;
      return cmdChain;
    }),
  };
  const program = {
    command: vi.fn(() => cmdChain),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    ctx: { program, logger } as never,
    cmdChain,
    logger,
    runAction: (opts: Record<string, unknown>) => actionFn(opts),
  };
}

describe("P-12 sweep-command — registration", () => {
  it("registers a `plan-clear` command", () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { ctx, cmdChain } = makeStubCtx();
    const registrar = createPlanClearCli({ store });
    registrar(ctx);
    expect(cmdChain.description).toHaveBeenCalled();
    expect(cmdChain.requiredOption).toHaveBeenCalledWith(
      "-s, --session <sessionKey>",
      expect.any(String),
    );
    expect(cmdChain.option).toHaveBeenCalledWith(
      "--dry-run",
      expect.any(String),
      false,
    );
  });

  it("description mentions plan-mode clear semantics", () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { ctx, cmdChain } = makeStubCtx();
    const registrar = createPlanClearCli({ store });
    registrar(ctx);
    const desc = cmdChain.description.mock.calls[0][0];
    expect(desc).toMatch(/plan.mode/i);
  });
});

describe("P-12 sweep-command — action behavior", () => {
  it("logs error when --session is empty", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { ctx, logger, runAction } = makeStubCtx();
    createPlanClearCli({ store })(ctx);
    await runAction({ session: "" });
    expect(logger.error).toHaveBeenCalled();
    expect(logger.error.mock.calls[0][0]).toMatch(/--session is required/);
  });

  it("reports no-op for sessions with no plan-mode payload", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const { ctx, logger, runAction } = makeStubCtx();
    createPlanClearCli({ store })(ctx);
    await runAction({ session: SESSION_KEY });
    const lines = logger.info.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes("no plan-mode payload"))).toBe(true);
  });

  it("reports no-op for sessions already in normal mode", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    gw.seed(SESSION_KEY, {
      mode: "normal",
      approval: "none",
      rejectionCount: 0,
    });
    const { ctx, logger, runAction } = makeStubCtx();
    createPlanClearCli({ store })(ctx);
    await runAction({ session: SESSION_KEY });
    const lines = logger.info.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes("already in normal mode"))).toBe(true);
  });

  it("--dry-run reports what would change without writing", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "pending",
      rejectionCount: 1,
      approvalId: "plan-x",
      title: "Test plan",
    });
    const { ctx, logger, runAction } = makeStubCtx();
    createPlanClearCli({ store })(ctx);
    await runAction({ session: SESSION_KEY, dryRun: true });
    const lines = logger.info.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes("dry-run"))).toBe(true);
    // Session state should be unchanged after dry-run.
    expect(gw.peek(SESSION_KEY)?.mode).toBe("plan");
    expect(gw.writeCount).toBe(0);
  });

  it("writes exitPlanMode + logs the kind on the success path", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "pending",
      rejectionCount: 0,
    });
    const { ctx, logger, runAction } = makeStubCtx();
    createPlanClearCli({ store })(ctx);
    await runAction({ session: SESSION_KEY });
    expect(gw.peek(SESSION_KEY)?.mode).toBe("normal");
    const lines = logger.info.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes("exitPlanMode kind=exited"))).toBe(
      true,
    );
  });

  it("logs error when exitPlanMode fails (IO error)", async () => {
    const brokenGw = {
      withLock: vi.fn(async () => {
        throw new Error("simulated disk failure");
      }),
    };
    const store = new PlanModeStore(brokenGw as never);
    // Seed not possible against broken gw — instead we set up so the
    // first readSnapshot returns something then exitPlanMode breaks.
    // Easier: use a "two-step" gateway that returns valid state from
    // readSnapshot but throws on the write.
    const validState = {
      mode: "plan" as const,
      approval: "pending" as const,
      rejectionCount: 0,
    };
    let call = 0;
    const semiBrokenGw = {
      writeCount: 0,
      withLock: vi.fn(async (_sk: string, update: (s: unknown) => Promise<{ next: unknown }>) => {
        call += 1;
        if (call === 1) {
          // readSnapshot's no-op call
          await update(validState);
          return {};
        }
        throw new Error("simulated disk failure");
      }),
    };
    const semiStore = new PlanModeStore(semiBrokenGw as never);
    const { ctx, logger, runAction } = makeStubCtx();
    createPlanClearCli({ store: semiStore })(ctx);
    await runAction({ session: SESSION_KEY });
    expect(logger.error).toHaveBeenCalled();
    expect(logger.error.mock.calls[0][0]).toMatch(/exitPlanMode failed/);
  });

  it("trims whitespace from --session value", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "pending",
      rejectionCount: 0,
    });
    const { ctx, runAction } = makeStubCtx();
    createPlanClearCli({ store })(ctx);
    await runAction({ session: `  ${SESSION_KEY}  ` });
    expect(gw.peek(SESSION_KEY)?.mode).toBe("normal");
  });
});
