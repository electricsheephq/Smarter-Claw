/**
 * Eva Live-Smoke #3 — Rejection cycle + rejectionCount tracking.
 *
 * Scenario:
 *   1. Plugin loads.
 *   2. Agent enters plan mode.
 *   3. Loop 3 times:
 *      a. Agent calls exit_plan_mode (proposes plan)
 *      b. User dispatches plan.reject with feedback
 *      c. Verify rejectionCount + [PLAN_DECISION]: rejected enqueued
 *   4. Each rejection emits the in-host runtime form: 2 lines,
 *      raw feedback, mention-stripped.
 *
 * Originally scheduled as Eva live-smoke #3 after P-11. The SDK-stub
 * harness verifies the cycle-tracking + injection bytes land correctly
 * across full enter/exit/reject loops.
 *
 * # Wave-1 W1-D1 update
 *
 * The plugin's runtime reject emitter now mirrors the in-host's inline
 * 2-line form at `sessions-patch.ts:1045-1050` (raw feedback, no
 * `Revise your plan…` line, no deescalation hint, `@channel`/`<@`
 * mention-stripping). The `rejectionCount` is still tracked in
 * injection metadata so callers can observe the cycle, but it does NOT
 * influence the injection text — matching the in-host runtime exactly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "./harness.js";

const SESSION_KEY = "agent:main:main";

interface ToolFactory {
  (ctx: { sessionKey?: string }): {
    execute: (
      callId: string,
      args: unknown,
    ) => Promise<{ details: { approvalId?: string; status?: string } }>;
  };
}

async function exitWithPlan(
  exit: ToolFactory,
  callId: string,
  title: string,
): Promise<string> {
  const tool = exit({ sessionKey: SESSION_KEY });
  const result = await tool.execute(callId, {
    title,
    plan: [{ step: "step", status: "pending" }],
  });
  const approvalId = result.details.approvalId;
  if (!approvalId) {
    throw new Error(`exit_plan_mode did not produce approvalId: ${JSON.stringify(result)}`);
  }
  return approvalId;
}

describe("Eva live-smoke #3 — rejection cycle + deescalation (P-11)", () => {
  let harness: ReturnType<typeof createHarness>;
  let enter: ToolFactory;
  let exit: ToolFactory;

  beforeEach(async () => {
    harness = createHarness({ forceInMemory: true });
    enter = harness.findTool("enter_plan_mode") as ToolFactory;
    exit = harness.findTool("exit_plan_mode") as ToolFactory;
    const enterTool = enter({ sessionKey: SESSION_KEY });
    await enterTool.execute("enter-1", {});
  });

  afterEach(() => {
    delete process.env.SMARTER_CLAW_USE_INMEMORY;
  });

  it("3 rejection cycles emit in-host runtime form with rejectionCount tracked in metadata", async () => {
    // Cycle 1
    const approvalId1 = await exitWithPlan(exit, "exit-1", "Plan v1");
    const r1 = (await harness.invokeAction("plan.reject", {
      sessionKey: SESSION_KEY,
      payload: { approvalId: approvalId1, feedback: "too many steps" },
    })) as { ok: boolean; result?: { rejectionCount?: number } };
    expect(r1.ok).toBe(true);
    expect(r1.result?.rejectionCount).toBe(1);

    // Cycle 2
    const approvalId2 = await exitWithPlan(exit, "exit-2", "Plan v2");
    const r2 = (await harness.invokeAction("plan.reject", {
      sessionKey: SESSION_KEY,
      payload: { approvalId: approvalId2, feedback: "still wrong order" },
    })) as { ok: boolean; result?: { rejectionCount?: number } };
    expect(r2.ok).toBe(true);
    expect(r2.result?.rejectionCount).toBe(2);

    // Cycle 3
    const approvalId3 = await exitWithPlan(exit, "exit-3", "Plan v3");
    const r3 = (await harness.invokeAction("plan.reject", {
      sessionKey: SESSION_KEY,
      payload: { approvalId: approvalId3, feedback: "still bad" },
    })) as { ok: boolean; result?: { rejectionCount?: number } };
    expect(r3.ok).toBe(true);
    expect(r3.result?.rejectionCount).toBe(3);

    // Verify 3 injections enqueued.
    expect(harness.captures.enqueuedInjections).toHaveLength(3);
    const injections = harness.captures.enqueuedInjections as Array<{
      text: string;
      idempotencyKey: string;
      metadata: { decision: string; rejectionCount: number };
    }>;

    // W1-D1 (in-host runtime parity): each rejection emits the 2-line
    // in-host form — NO "Revise your plan…" line, NO deescalation hint
    // (even at count=3 the text shape is fixed).
    expect(injections[0].text).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: too many steps",
    );
    expect(injections[0].text).not.toMatch(/Revise your plan/);
    expect(injections[0].text).not.toMatch(/Multiple revisions/);
    expect(injections[0].metadata.rejectionCount).toBe(1);

    expect(injections[1].text).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: still wrong order",
    );
    expect(injections[1].text).not.toMatch(/Revise your plan/);
    expect(injections[1].text).not.toMatch(/Multiple revisions/);
    expect(injections[1].metadata.rejectionCount).toBe(2);

    // Cycle 3: text stays 2-line even at rejectionCount=3 (the count
    // is metadata-only — the in-host runtime emits the same 2-line form
    // regardless of cycle).
    expect(injections[2].text).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: still bad",
    );
    expect(injections[2].text).not.toMatch(/Multiple revisions/);
    expect(injections[2].metadata.rejectionCount).toBe(3);
  });

  it("each rejection has a distinct idempotencyKey (different approvalId per cycle)", async () => {
    const approvalId1 = await exitWithPlan(exit, "exit-1", "Plan v1");
    await harness.invokeAction("plan.reject", {
      sessionKey: SESSION_KEY,
      payload: { approvalId: approvalId1, feedback: "f1" },
    });
    const approvalId2 = await exitWithPlan(exit, "exit-2", "Plan v2");
    await harness.invokeAction("plan.reject", {
      sessionKey: SESSION_KEY,
      payload: { approvalId: approvalId2, feedback: "f2" },
    });
    const keys = harness.captures.enqueuedInjections.map(
      (e) => (e as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("feedback is sanitized inside the injection — mention-stripping (in-host runtime parity W1-D1)", async () => {
    // The W1-D1 in-host runtime sanitizer neutralizes Slack/Discord
    // broadcast triggers (`@channel`, `@here`, `@everyone`) and user-
    // mention syntax (`<@U…>`). It does NOT apply the
    // `[/PLAN_DECISION]` ZWSP rewrite that the latent
    // `buildPlanDecisionInjection` uses.
    const approvalId = await exitWithPlan(exit, "exit-1", "X");
    const adversarial = "too risky @channel <@U123>";
    await harness.invokeAction("plan.reject", {
      sessionKey: SESSION_KEY,
      payload: { approvalId, feedback: adversarial },
    });
    const inj = harness.captures.enqueuedInjections[0] as { text: string };
    // Byte-for-byte match against the in-host runtime form.
    expect(inj.text).toBe(
      "[PLAN_DECISION]: rejected\nfeedback: too risky @\u{FE6B}channel <\u{200B}@U123>",
    );
    // Positive sanitization checks: raw triggers MUST NOT appear.
    expect(inj.text).not.toMatch(/@channel\b/);
    expect(inj.text).not.toMatch(/<@/);
    // Other characters in the feedback flow through raw (no JSON-quote).
    expect(inj.text).not.toMatch(/feedback: "/);
  });

  it("preserves non-mention feedback verbatim (no JSON quoting; raw text)", async () => {
    const approvalId = await exitWithPlan(exit, "exit-1", "X");
    await harness.invokeAction("plan.reject", {
      sessionKey: SESSION_KEY,
      payload: {
        approvalId,
        feedback: 'try a different ordering: "step 3 should run last"',
      },
    });
    const inj = harness.captures.enqueuedInjections[0] as { text: string };
    expect(inj.text).toBe(
      '[PLAN_DECISION]: rejected\nfeedback: try a different ordering: "step 3 should run last"',
    );
  });

  it("rejectionCount persists across enter/exit/reject cycles (not reset on new exit_plan_mode)", async () => {
    // Cycle 1
    const a1 = await exitWithPlan(exit, "exit-1", "P1");
    await harness.invokeAction("plan.reject", {
      sessionKey: SESSION_KEY,
      payload: { approvalId: a1, feedback: "fb" },
    });
    // Cycle 2 — note rejectionCount should ALREADY be 1 (carried over).
    const a2 = await exitWithPlan(exit, "exit-2", "P2");
    const r2 = (await harness.invokeAction("plan.reject", {
      sessionKey: SESSION_KEY,
      payload: { approvalId: a2, feedback: "fb" },
    })) as { result?: { rejectionCount?: number } };
    expect(r2.result?.rejectionCount).toBe(2);
  });
});
