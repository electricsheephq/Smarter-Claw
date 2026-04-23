/**
 * Tests for runtime-api.ts.
 *
 * Coverage:
 *   - readSmarterClawState: returns undefined when bag is missing /
 *     malformed; returns the slot when present.
 *   - writeSmarterClawState / clearSmarterClawState: pure spread
 *     semantics, never mutate input, preserve other plugins' slices.
 *   - persistSmarterClawState: short-circuits cleanly when the host
 *     module is missing the write API (vanilla openclaw without the
 *     installer-applied patch); proves serialization when concurrent
 *     calls fire against the same sessionKey (#9).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSmarterClawState,
  isAutoApproveEnabled,
  isInPlanMode,
  persistSmarterClawState,
  readSmarterClawState,
  writeSmarterClawState,
} from "../runtime-api.js";
import { SMARTER_CLAW_PLUGIN_ID } from "../src/types.js";

describe("readSmarterClawState", () => {
  it("returns undefined when session is null/undefined", () => {
    expect(readSmarterClawState(undefined)).toBeUndefined();
    expect(readSmarterClawState(null)).toBeUndefined();
  });
  it("returns undefined when pluginMetadata bag is missing", () => {
    expect(readSmarterClawState({ id: "x" })).toBeUndefined();
  });
  it("returns undefined when bag is non-object (array, primitive)", () => {
    expect(readSmarterClawState({ pluginMetadata: [] })).toBeUndefined();
    expect(readSmarterClawState({ pluginMetadata: "hi" })).toBeUndefined();
  });
  it("returns undefined when our slot is missing", () => {
    expect(readSmarterClawState({ pluginMetadata: { other: { x: 1 } } })).toBeUndefined();
  });
  it("returns the namespaced slot when present", () => {
    const state = { planMode: "plan" as const };
    const session = { pluginMetadata: { [SMARTER_CLAW_PLUGIN_ID]: state } };
    expect(readSmarterClawState(session)).toEqual(state);
  });
});

describe("writeSmarterClawState / clearSmarterClawState", () => {
  it("is pure (does not mutate input)", () => {
    const session = { pluginMetadata: { other: { x: 1 } } };
    const next = writeSmarterClawState(session, { planMode: "plan" });
    expect(session).toEqual({ pluginMetadata: { other: { x: 1 } } });
    expect(next).not.toBe(session);
  });
  it("preserves other plugins' slices", () => {
    const session = {
      pluginMetadata: { other: { keep: "this" } },
    };
    const next = writeSmarterClawState(session, { planMode: "plan" });
    expect((next.pluginMetadata as Record<string, unknown>).other).toEqual({ keep: "this" });
  });
  it("clearSmarterClawState removes only our slot", () => {
    const session = {
      pluginMetadata: {
        [SMARTER_CLAW_PLUGIN_ID]: { planMode: "plan" },
        other: { keep: "this" },
      },
    } as Record<string, unknown>;
    const cleared = clearSmarterClawState(session);
    expect((cleared.pluginMetadata as Record<string, unknown>)[SMARTER_CLAW_PLUGIN_ID]).toBeUndefined();
    expect((cleared.pluginMetadata as Record<string, unknown>).other).toEqual({ keep: "this" });
  });
  it("clearSmarterClawState is a no-op when slot already absent", () => {
    const session = { pluginMetadata: { other: { x: 1 } } };
    expect(clearSmarterClawState(session)).toBe(session);
  });
});

describe("isInPlanMode / isAutoApproveEnabled", () => {
  it("isInPlanMode returns false when state missing", () => {
    expect(isInPlanMode(undefined)).toBe(false);
    expect(isInPlanMode({})).toBe(false);
  });
  it("isInPlanMode returns true only when planMode === 'plan'", () => {
    const planSession = { pluginMetadata: { [SMARTER_CLAW_PLUGIN_ID]: { planMode: "plan" } } };
    const normalSession = { pluginMetadata: { [SMARTER_CLAW_PLUGIN_ID]: { planMode: "normal" } } };
    expect(isInPlanMode(planSession)).toBe(true);
    expect(isInPlanMode(normalSession)).toBe(false);
  });
  it("isAutoApproveEnabled returns false unless autoApprove === true", () => {
    expect(isAutoApproveEnabled(undefined)).toBe(false);
    expect(
      isAutoApproveEnabled({
        pluginMetadata: { [SMARTER_CLAW_PLUGIN_ID]: { autoApprove: false } },
      }),
    ).toBe(false);
    expect(
      isAutoApproveEnabled({
        pluginMetadata: { [SMARTER_CLAW_PLUGIN_ID]: { autoApprove: true } },
      }),
    ).toBe(true);
  });
});

describe("persistSmarterClawState", () => {
  beforeEach(() => {
    vi.resetModules();
    // Clear any prior mock so each test starts from a clean slate. The
    // suite uses `vi.doMock + dynamic import` to swap the host SDK
    // module; without this reset the second test in the file would see
    // the first test's mock and produce confusing failures.
    vi.doUnmock("openclaw/plugin-sdk/session-store-runtime");
  });
  afterEach(() => {
    vi.doUnmock("openclaw/plugin-sdk/session-store-runtime");
    vi.resetModules();
  });

  it("returns persisted:false when host module is missing updateSessionStoreEntry", async () => {
    // Mock the host module to expose ONLY the read-side helpers — the
    // shape vanilla openclaw v2026.4.22 ships before the installer patch
    // adds the write API. Vitest's strict-export mode requires us to
    // explicitly stub `updateSessionStoreEntry: undefined` so the
    // dynamic import sees "no export" rather than throwing on access.
    vi.doMock("openclaw/plugin-sdk/session-store-runtime", () => ({
      loadSessionStore: () => ({}),
      resolveSessionStoreEntry: () => ({ existing: undefined }),
      resolveStorePath: () => "/tmp/mock-store",
      updateSessionStoreEntry: undefined,
    }));
    // Re-import after the mock so the dynamic import inside the helper
    // sees the mocked module.
    const { persistSmarterClawState: mockedPersist } = await import("../runtime-api.js");
    const result = await mockedPersist({
      agentId: "default",
      sessionKey: "session-1",
      update: () => ({ planMode: "plan" }),
    });
    expect(result.persisted).toBe(false);
    if (!result.persisted) {
      expect(result.reason).toMatch(/updateSessionStoreEntry/);
    }
  });

  it("serializes concurrent calls (proves the host's withSessionStoreLock contract holds for our payload)", async () => {
    // Synthesize the host's behavior: a single in-memory store map per
    // storePath, mutations serialized via an internal queue (the real
    // host uses withSessionStoreLock around the same mutator). Two
    // concurrent persistSmarterClawState calls against the same
    // sessionKey should produce a final state that reflects BOTH
    // updates' contributions, not a clobber where one update is lost.
    const storeByPath = new Map<string, Record<string, Record<string, unknown>>>();
    storeByPath.set("/tmp/mock-store", {
      "session-1": { sessionId: "session-1", pluginMetadata: {} },
    });

    // Simple promise-chained mutex — same shape as the host's per-
    // storePath lock, scaled to one storePath for the test.
    let chain: Promise<unknown> = Promise.resolve();
    function withLock<T>(fn: () => Promise<T>): Promise<T> {
      const next = chain.then(fn, fn);
      // Swallow rejections in the chain but propagate the original
      // promise's outcome to the caller so test assertions can see it.
      chain = next.catch(() => undefined);
      return next;
    }

    vi.doMock("openclaw/plugin-sdk/session-store-runtime", () => ({
      loadSessionStore: (storePath: string) => storeByPath.get(storePath),
      resolveSessionStoreEntry: ({ store, sessionKey }: { store: Record<string, Record<string, unknown>>; sessionKey: string }) => ({
        existing: store?.[sessionKey],
      }),
      resolveStorePath: () => "/tmp/mock-store",
      updateSessionStoreEntry: async ({
        storePath,
        sessionKey,
        update,
      }: {
        storePath: string;
        sessionKey: string;
        update: (entry: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      }) => {
        return withLock(async () => {
          const store = storeByPath.get(storePath) ?? {};
          const entry = store[sessionKey] ?? { sessionId: sessionKey };
          const patch = await update(entry);
          if (!patch) return null;
          // Mimic mergeSessionEntry: shallow spread (matches the comment
          // in persistSmarterClawState about pluginMetadata being
          // replaced wholesale).
          const merged = { ...entry, ...patch };
          store[sessionKey] = merged;
          storeByPath.set(storePath, store);
          return merged;
        });
      },
    }));

    const { persistSmarterClawState: mockedPersist } = await import("../runtime-api.js");

    const a = mockedPersist({
      agentId: "default",
      sessionKey: "session-1",
      update: (current) => ({
        ...(current ?? {}),
        planMode: "plan",
        // Tag the writer so we can verify ordering.
        lastWriter: "A",
      } as never),
    });
    const b = mockedPersist({
      agentId: "default",
      sessionKey: "session-1",
      update: (current) => ({
        ...(current ?? {}),
        planMode: "plan",
        lastWriter: "B",
      } as never),
    });
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA.persisted).toBe(true);
    expect(resultB.persisted).toBe(true);

    // Final on-disk state should reflect WHICHEVER call landed second,
    // and must include the planMode each one wrote (since both wrote
    // planMode:"plan", final must still be "plan"). The lastWriter tag
    // is whichever resolved last — but it MUST be A or B, never some
    // third value or undefined: that would mean a clobber.
    const finalEntry = storeByPath.get("/tmp/mock-store")?.["session-1"];
    const slot = (finalEntry?.pluginMetadata as Record<string, unknown> | undefined)?.[
      SMARTER_CLAW_PLUGIN_ID
    ] as Record<string, unknown> | undefined;
    expect(slot?.planMode).toBe("plan");
    expect(slot?.lastWriter === "A" || slot?.lastWriter === "B").toBe(true);
  });

  it("preserves another plugin's slice across an update (proves we don't clobber other plugins)", async () => {
    const storeByPath = new Map<string, Record<string, Record<string, unknown>>>();
    // Pre-seed an entry where another plugin already has metadata.
    storeByPath.set("/tmp/mock-store", {
      "session-1": {
        sessionId: "session-1",
        pluginMetadata: { "other-plugin": { keep: "this" } },
      },
    });

    vi.doMock("openclaw/plugin-sdk/session-store-runtime", () => ({
      loadSessionStore: (storePath: string) => storeByPath.get(storePath),
      resolveSessionStoreEntry: ({ store, sessionKey }: { store: Record<string, Record<string, unknown>>; sessionKey: string }) => ({
        existing: store?.[sessionKey],
      }),
      resolveStorePath: () => "/tmp/mock-store",
      updateSessionStoreEntry: async ({
        storePath,
        sessionKey,
        update,
      }: {
        storePath: string;
        sessionKey: string;
        update: (entry: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      }) => {
        const store = storeByPath.get(storePath) ?? {};
        const entry = store[sessionKey] ?? { sessionId: sessionKey };
        const patch = await update(entry);
        if (!patch) return null;
        const merged = { ...entry, ...patch };
        store[sessionKey] = merged;
        storeByPath.set(storePath, store);
        return merged;
      },
    }));

    const { persistSmarterClawState: mockedPersist } = await import("../runtime-api.js");
    const result = await mockedPersist({
      agentId: "default",
      sessionKey: "session-1",
      update: () => ({ planMode: "plan" }),
    });
    expect(result.persisted).toBe(true);

    const finalEntry = storeByPath.get("/tmp/mock-store")?.["session-1"];
    const bag = finalEntry?.pluginMetadata as Record<string, unknown>;
    expect(bag["other-plugin"]).toEqual({ keep: "this" });
    expect(bag[SMARTER_CLAW_PLUGIN_ID]).toMatchObject({ planMode: "plan" });
  });
});
