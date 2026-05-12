/**
 * P-9 plan-tier model override tests.
 *
 * Covers the decision logic (when to override, when to defer to host
 * default) without exercising the full before_model_resolve hook
 * pipeline (that's Eva live-smoke #2/#3 territory).
 */

import { describe, expect, it } from "vitest";
import { decidePlanTierModel } from "../../src/runtime/plan-tier-model.js";
import { InMemoryGateway } from "../../src/state/in-memory-gateway.js";
import { PlanModeStore } from "../../src/state/store.js";

const SESSION_KEY = "agent:main:main";

function build(seed?: { mode: "plan" | "normal" }) {
  const gw = new InMemoryGateway();
  if (seed) {
    gw.seed(SESSION_KEY, {
      mode: seed.mode,
      approval: "none",
      rejectionCount: 0,
    });
  }
  const store = new PlanModeStore(gw);
  return { gw, store };
}

describe("P-9 plan-tier model — decision", () => {
  it("returns undefined when no sessionKey (defensive)", async () => {
    const { store } = build({ mode: "plan" });
    const d = await decidePlanTierModel(undefined, {
      store,
      planTierModel: "model-x",
    });
    expect(d).toBeUndefined();
  });

  it("returns undefined when no operator-configured planTierModel", async () => {
    const { store } = build({ mode: "plan" });
    const d = await decidePlanTierModel(SESSION_KEY, {
      store,
      planTierModel: undefined,
    });
    expect(d).toBeUndefined();
  });

  it("returns undefined when session has no plan-mode payload", async () => {
    const { store } = build(); // unseeded
    const d = await decidePlanTierModel(SESSION_KEY, {
      store,
      planTierModel: "anthropic/claude-opus-4-7",
    });
    expect(d).toBeUndefined();
  });

  it("returns undefined when session is in normal mode", async () => {
    const { store } = build({ mode: "normal" });
    const d = await decidePlanTierModel(SESSION_KEY, {
      store,
      planTierModel: "anthropic/claude-opus-4-7",
    });
    expect(d).toBeUndefined();
  });

  it("returns modelOverride when session is in plan mode + planTierModel set", async () => {
    const { store } = build({ mode: "plan" });
    const d = await decidePlanTierModel(SESSION_KEY, {
      store,
      planTierModel: "anthropic/claude-opus-4-7",
    });
    expect(d).toEqual({ modelOverride: "anthropic/claude-opus-4-7" });
  });

  it("includes providerOverride when paired with planTierProvider", async () => {
    const { store } = build({ mode: "plan" });
    const d = await decidePlanTierModel(SESSION_KEY, {
      store,
      planTierModel: "claude-opus-4-7",
      planTierProvider: "anthropic",
    });
    expect(d).toEqual({
      modelOverride: "claude-opus-4-7",
      providerOverride: "anthropic",
    });
  });

  it("OMITS providerOverride field when not provided (not just undefined)", async () => {
    const { store } = build({ mode: "plan" });
    const d = await decidePlanTierModel(SESSION_KEY, {
      store,
      planTierModel: "model-x",
    });
    // The SDK's before_model_resolve result reads modelOverride +
    // providerOverride as discriminated optionals. Including
    // `providerOverride: undefined` would still be in Object.keys.
    expect(d).toBeDefined();
    expect("providerOverride" in (d ?? {})).toBe(false);
  });
});

describe("P-9 subagent isolation — independent plan-mode state per sessionKey", () => {
  // The architecture is structurally isolated: PlanModeStateGateway
  // keys all state by sessionKey, and subagents always get a distinct
  // sessionKey from their parent. This test pins that invariant.

  it("two different sessionKeys keep independent plan-mode state", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const PARENT = "agent:main:main";
    const CHILD = "agent:research-1:abc";

    // Parent enters plan mode.
    await store.enterPlanMode({ sessionKey: PARENT });
    // Child remains in default (no payload).
    const childSnap = await store.readSnapshot(CHILD);
    expect(childSnap).toBeUndefined();
    const parentSnap = await store.readSnapshot(PARENT);
    expect(parentSnap?.mode).toBe("plan");
  });

  it("child entering plan mode does NOT affect parent state", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const PARENT = "agent:main:main";
    const CHILD = "agent:research-1:abc";

    await store.enterPlanMode({ sessionKey: PARENT });
    await store.enterPlanMode({ sessionKey: CHILD });

    // Now exit the child; parent should still be in plan mode.
    await store.exitPlanMode({ sessionKey: CHILD });
    const parentSnap = await store.readSnapshot(PARENT);
    expect(parentSnap?.mode).toBe("plan");
    const childSnap = await store.readSnapshot(CHILD);
    expect(childSnap?.mode).toBe("normal");
  });

  it("approvals on different sessions don't cross-contaminate", async () => {
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const A = "agent:main:main";
    const B = "agent:main:b";

    await store.enterPlanMode({ sessionKey: A });
    await store.enterPlanMode({ sessionKey: B });

    const rA = await store.persistApprovalRequest({
      sessionKey: A,
      approvalId: "plan-aaaaaaaa-1111-4222-9333-aaaaaaaaaaaa",
      title: "A's plan",
    });
    const rB = await store.persistApprovalRequest({
      sessionKey: B,
      approvalId: "plan-bbbbbbbb-2222-4333-9444-bbbbbbbbbbbb",
      title: "B's plan",
    });
    expect(rA.kind).toBe("persisted");
    expect(rB.kind).toBe("persisted");

    const snapA = await store.readSnapshot(A);
    const snapB = await store.readSnapshot(B);
    expect(snapA?.approvalId).toBe(
      "plan-aaaaaaaa-1111-4222-9333-aaaaaaaaaaaa",
    );
    expect(snapB?.approvalId).toBe(
      "plan-bbbbbbbb-2222-4333-9444-bbbbbbbbbbbb",
    );
    expect(snapA?.title).toBe("A's plan");
    expect(snapB?.title).toBe("B's plan");
  });
});
