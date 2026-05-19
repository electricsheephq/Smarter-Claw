/**
 * Eva Live-Smoke #5 — End-to-end `/plan auto on` → exit_plan_mode →
 *                      auto-approve → injection enqueued.
 *
 * Scenario (W1-F4 fix, 2026-05-20):
 *   1. Plugin loads.
 *   2. Operator dispatches `plan.auto.toggle` with `{ enabled: true }`
 *      (the same action `/plan auto on` routes to). State picks up
 *      `autoApprove: true`.
 *   3. Agent calls `enter_plan_mode`. State.mode === "plan",
 *      autoApprove preserved across the mode flip.
 *   4. Agent calls `exit_plan_mode` with a proposed plan.
 *      `persistApprovalRequest` lands the pending approval, the
 *      auto-approve trigger void-fires after the persist returns,
 *      and the trigger callback (wired in `src/index.ts`) runs the
 *      `recordApproval` + `enqueuePlanApprovedInjection` pair —
 *      exactly the same two operations `plan.accept` runs.
 *   5. The captured injection is the FULL `buildApprovedPlanInjection`
 *      preamble (opener + "execute it now" guidance + numbered step
 *      list) — byte-identical to the `plan.accept` path.
 *   6. The state machine has advanced from `pending` → `approved` /
 *      `mode === "normal"`. `autoApprove` is preserved on the state
 *      so the NEXT cycle also auto-approves (in-host PR-10 carry
 *      semantics).
 *
 * Pre-W1-F4 behavior: step 4's exit_plan_mode left state in
 * `approval: "pending"` with no injection enqueued. The operator
 * had to click Approve in the UI to advance — auto-approve was a
 * flag with no caller. This smoke is the proof that W1-F4 wired
 * the missing caller.
 *
 * # What this proves vs. the tool unit tests
 *
 * `tests/tools/exit-plan-mode.test.ts` (W1-F4 group) pins the tool-
 * layer firing rules (when does the trigger run / not run). This
 * smoke pins the END-TO-END contract: the trigger, when wired in
 * `src/index.ts` to `recordApproval` + `enqueuePlanApprovedInjection`,
 * produces the same observable agent-facing state as the manual
 * `plan.accept` flow.
 *
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:387-477
 *   (`autoApproveIfEnabled` — the in-host trigger).
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:1949-1962
 *   (the in-host callsite, void-fired after the approval emit).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "./harness.js";

const SESSION_KEY = "agent:main:main";

interface ToolFactory {
  (ctx: { sessionKey?: string }): {
    execute: (
      callId: string,
      args: unknown,
    ) => Promise<{
      details: {
        status?: string;
        approvalId?: string;
        mode?: string;
      };
    }>;
  };
}

/**
 * Wait one tick for the void-fired auto-approve trigger to drain.
 * The trigger is fire-and-forget (matches in-host
 * `void autoApproveIfEnabled(...)` at
 * `subscribe.handlers.tools.ts:1956`), so the test loop has to
 * yield once to let the microtask queue flush before asserting on
 * post-trigger state.
 *
 * 25ms is the same flush-cushion the smoke #4 accept-edits suite
 * uses for void-fired plan-archetype dispatches. It's deliberately
 * loose — the in-host's poll-loop is 50ms intervals + 2s cap, which
 * doesn't apply here (plugin has no poll loop) — and gives slow CI
 * boxes plenty of headroom.
 */
async function drainAutoApprove(): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
}

describe("Eva live-smoke #5 — auto-approve end-to-end (W1-F4)", () => {
  let harness: ReturnType<typeof createHarness>;
  let enter: ToolFactory;
  let exit: ToolFactory;

  beforeEach(() => {
    harness = createHarness({ forceInMemory: true });
    enter = harness.findTool("enter_plan_mode") as ToolFactory;
    exit = harness.findTool("exit_plan_mode") as ToolFactory;
  });

  afterEach(() => {
    delete process.env.SMARTER_CLAW_USE_INMEMORY;
  });

  it("happy path: /plan auto on → enter → exit → auto-approved injection enqueued", async () => {
    // Step 1: operator toggles autoApprove on (no plan mode active yet
    // — `setAutoApprove` lazy-inits a normal-mode payload with the
    // flag set; the next enterPlanMode carries it over).
    const toggleResult = (await harness.invokeAction("plan.auto.toggle", {
      sessionKey: SESSION_KEY,
      payload: { enabled: true },
    })) as { ok: boolean; result?: { kind?: string } };
    expect(toggleResult.ok).toBe(true);
    expect(toggleResult.result?.kind).toBe("updated");

    // Step 2: enter plan mode. autoApprove carries over via spread.
    const enterResult = await enter({ sessionKey: SESSION_KEY }).execute(
      "call-enter",
      {},
    );
    expect(enterResult.details.mode).toBe("plan");

    // Step 3: exit_plan_mode with a real plan. The trigger void-fires
    // after persist; we drain a tick before asserting on the injection.
    const exitResult = await exit({ sessionKey: SESSION_KEY }).execute(
      "call-exit",
      {
        title: "Bump deps",
        plan: [
          { step: "Update package.json", status: "pending" },
          { step: "Run pnpm install", status: "pending" },
        ],
        summary: "Two-step dep bump.",
      },
    );
    expect(exitResult.details.status).toBe("approval-requested");
    const approvalId = exitResult.details.approvalId;
    expect(typeof approvalId).toBe("string");

    await drainAutoApprove();

    // Step 4: the injection should be enqueued — same payload as the
    // manual `plan.accept` path produces.
    expect(harness.captures.enqueuedInjections).toHaveLength(1);
    const inj = harness.captures.enqueuedInjections[0] as {
      sessionKey: string;
      text: string;
      idempotencyKey: string;
      placement: string;
      metadata?: { decision?: string; approvalId?: string };
    };
    expect(inj.sessionKey).toBe(SESSION_KEY);
    // Full preamble (opener + "execute it now" + step list) —
    // matches the plan.accept path exactly (surgical-port S5 parity).
    expect(inj.text).toMatch(/^\[PLAN_DECISION\]: approved\n/);
    expect(inj.text).toMatch(
      /The user has approved the following plan\. Execute it now without re-planning\./,
    );
    expect(inj.text).toMatch(/1\. Update package\.json/);
    expect(inj.text).toMatch(/2\. Run pnpm install/);
    // approvalId thread: the injection key is keyed on the SAME
    // approvalId the exit_plan_mode result reported (audit trail
    // stays threaded).
    expect(inj.idempotencyKey).toBe(
      `smarter-claw:plan_decision:${approvalId}:approved`,
    );
    expect(inj.metadata?.approvalId).toBe(approvalId);
    expect(inj.metadata?.decision).toBe("approved");
    expect(inj.placement).toBe("prepend_context");

    // Step 5: an info log line marks the auto-approve fire (for
    // operator visibility). The text contract is loose — we only
    // pin the diagnostic prefix that telemetry / log-grep relies on.
    expect(
      harness.captures.loggerInfo.some((m) =>
        /auto-approve fired/i.test(m),
      ),
    ).toBe(true);
  });

  it("a subsequent manual /plan accept on the same approvalId is rejected (already-resolved)", async () => {
    // Auto-approve has fired — the state machine moved to
    // mode:"normal" / approval:"approved". A LATER manual plan.accept
    // (e.g. UI was slow to update + user clicked the stale card)
    // should be cleanly rejected by the session-action layer's
    // NOT_IN_PLAN_MODE gate.
    await harness.invokeAction("plan.auto.toggle", {
      sessionKey: SESSION_KEY,
      payload: { enabled: true },
    });
    await enter({ sessionKey: SESSION_KEY }).execute("call-enter", {});
    const exitResult = await exit({ sessionKey: SESSION_KEY }).execute(
      "call-exit",
      {
        title: "X",
        plan: [{ step: "a", status: "pending" }],
      },
    );
    const approvalId = exitResult.details.approvalId;
    await drainAutoApprove();

    const stale = (await harness.invokeAction("plan.accept", {
      sessionKey: SESSION_KEY,
      payload: { approvalId },
    })) as { ok: boolean; code?: string };
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("NOT_IN_PLAN_MODE");
  });

  it("autoApprove flag carries across cycles — second exit_plan_mode also auto-approves", async () => {
    // The in-host's PR-10 carry contract
    // (`pi-embedded-subscribe.handlers.tools.ts:313-345`) preserves
    // `autoApprove` across plan cycles. The plugin's resolvePlanApproval
    // does the same via `...current` spread on the approve branch. So
    // a SECOND enter_plan_mode → exit_plan_mode under the same session
    // should also fire the auto-approve.
    await harness.invokeAction("plan.auto.toggle", {
      sessionKey: SESSION_KEY,
      payload: { enabled: true },
    });

    // Cycle 1
    await enter({ sessionKey: SESSION_KEY }).execute("c1-enter", {});
    await exit({ sessionKey: SESSION_KEY }).execute("c1-exit", {
      title: "Cycle 1",
      plan: [{ step: "first", status: "pending" }],
    });
    await drainAutoApprove();

    // Cycle 2 — re-enter (autoApprove carries) + re-exit.
    await enter({ sessionKey: SESSION_KEY }).execute("c2-enter", {});
    await exit({ sessionKey: SESSION_KEY }).execute("c2-exit", {
      title: "Cycle 2",
      plan: [{ step: "second", status: "pending" }],
    });
    await drainAutoApprove();

    // Both cycles fired the trigger → two injections enqueued.
    expect(harness.captures.enqueuedInjections).toHaveLength(2);
    const [first, second] = harness.captures.enqueuedInjections as Array<{
      text: string;
    }>;
    expect(first.text).toMatch(/1\. first/);
    expect(second.text).toMatch(/1\. second/);
  });

  it("toggling auto OFF mid-session disables the trigger for the next cycle", async () => {
    // Toggle on → cycle 1 (auto fires) → toggle off → cycle 2
    // (auto does NOT fire, approval stays pending).
    await harness.invokeAction("plan.auto.toggle", {
      sessionKey: SESSION_KEY,
      payload: { enabled: true },
    });

    // Cycle 1: auto fires.
    await enter({ sessionKey: SESSION_KEY }).execute("c1-enter", {});
    await exit({ sessionKey: SESSION_KEY }).execute("c1-exit", {
      title: "Cycle 1",
      plan: [{ step: "first", status: "pending" }],
    });
    await drainAutoApprove();
    expect(harness.captures.enqueuedInjections).toHaveLength(1);

    // Toggle off.
    const toggleOff = (await harness.invokeAction("plan.auto.toggle", {
      sessionKey: SESSION_KEY,
      payload: { enabled: false },
    })) as { ok: boolean };
    expect(toggleOff.ok).toBe(true);

    // Cycle 2: manual mode expected.
    await enter({ sessionKey: SESSION_KEY }).execute("c2-enter", {});
    const exitR = await exit({ sessionKey: SESSION_KEY }).execute(
      "c2-exit",
      {
        title: "Cycle 2",
        plan: [{ step: "second", status: "pending" }],
      },
    );
    expect(exitR.details.status).toBe("approval-requested");
    await drainAutoApprove();
    // STILL only the cycle-1 injection — cycle 2 awaits manual click.
    expect(harness.captures.enqueuedInjections).toHaveLength(1);
  });
});
