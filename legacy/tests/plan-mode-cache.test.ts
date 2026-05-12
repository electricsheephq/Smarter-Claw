/**
 * Tests for src/plan-mode-cache.ts (#10).
 *
 * The cache lives behind before_tool_call + before_prompt_build to skip
 * per-tool-call disk reads. These tests assert the cache contract:
 *
 *   - Empty cache → miss → falls back to caller's fresh-read path.
 *   - Populated cache, within max-age → hit returns the cached entry.
 *   - Populated cache, past max-age → miss + auto-evict.
 *   - bustPlanModeCache invalidates a single key.
 *   - bustAllPlanModeCache wipes the whole map.
 *   - undefined entry is a legitimate cache value (don't keep retrying
 *     on every tool call when the session genuinely doesn't exist yet).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bustAllPlanModeCache,
  bustPlanModeCache,
  DEFAULT_PLAN_MODE_CACHE_MAX_AGE_MS,
  getPlanModeCache,
  getPlanModeCacheSizeForTest,
  setPlanModeCache,
} from "../src/plan-mode-cache.js";

describe("plan-mode-cache", () => {
  beforeEach(() => {
    bustAllPlanModeCache();
  });
  afterEach(() => {
    bustAllPlanModeCache();
  });

  it("returns undefined on empty cache", () => {
    expect(getPlanModeCache("session-1")).toBeUndefined();
  });

  it("hit returns the cached entry within max-age", () => {
    const entry = { sessionId: "session-1", pluginMetadata: {} };
    setPlanModeCache("session-1", entry);
    const got = getPlanModeCache("session-1");
    expect(got?.entry).toBe(entry);
  });

  it("undefined entry is a legitimate cache value (no-entry-found)", () => {
    setPlanModeCache("session-1", undefined);
    const got = getPlanModeCache("session-1");
    expect(got).toBeDefined(); // cache HAS an entry...
    expect(got?.entry).toBeUndefined(); // ...whose value is undefined
  });

  it("expires after max-age and auto-evicts on miss", () => {
    let now = 1_000_000;
    const nowFn = () => now;
    setPlanModeCache("session-1", { x: 1 }, { now: nowFn });
    expect(getPlanModeCacheSizeForTest()).toBe(1);

    // Within window — hit.
    now += DEFAULT_PLAN_MODE_CACHE_MAX_AGE_MS - 1;
    expect(getPlanModeCache("session-1", { now: nowFn })).toBeDefined();

    // Past window — miss, auto-evict.
    now += 2;
    expect(getPlanModeCache("session-1", { now: nowFn })).toBeUndefined();
    expect(getPlanModeCacheSizeForTest()).toBe(0);
  });

  it("custom maxAgeMs overrides the default", () => {
    let now = 1_000_000;
    const nowFn = () => now;
    setPlanModeCache("session-1", { x: 1 }, { now: nowFn });

    now += 100;
    expect(getPlanModeCache("session-1", { maxAgeMs: 50, now: nowFn })).toBeUndefined();
  });

  it("bustPlanModeCache invalidates a single key", () => {
    setPlanModeCache("session-1", { a: 1 });
    setPlanModeCache("session-2", { b: 2 });
    expect(getPlanModeCacheSizeForTest()).toBe(2);

    bustPlanModeCache("session-1");
    expect(getPlanModeCache("session-1")).toBeUndefined();
    expect(getPlanModeCache("session-2")).toBeDefined();
    expect(getPlanModeCacheSizeForTest()).toBe(1);
  });

  it("bustAllPlanModeCache wipes everything", () => {
    setPlanModeCache("session-1", { a: 1 });
    setPlanModeCache("session-2", { b: 2 });
    setPlanModeCache("session-3", { c: 3 });
    expect(getPlanModeCacheSizeForTest()).toBe(3);

    bustAllPlanModeCache();
    expect(getPlanModeCacheSizeForTest()).toBe(0);
  });

  it("set overwrites an existing entry", () => {
    setPlanModeCache("session-1", { v: 1 });
    setPlanModeCache("session-1", { v: 2 });
    const got = getPlanModeCache("session-1");
    expect((got?.entry as { v: number }).v).toBe(2);
  });

  it("hit/miss sequence: many calls within window only one disk read needed", () => {
    // Simulate the real before_tool_call hot path: caller checks cache
    // first; on miss does a disk read + populates cache; on hit skips.
    let diskReads = 0;
    const fakeRead = () => {
      diskReads++;
      return { sessionId: "session-1", pluginMetadata: {} };
    };
    function gateLookup() {
      const cached = getPlanModeCache("session-1");
      if (cached) return cached.entry;
      const entry = fakeRead();
      setPlanModeCache("session-1", entry);
      return entry;
    }

    // 50 tool calls in one turn — only the FIRST should hit disk.
    for (let i = 0; i < 50; i++) {
      gateLookup();
    }
    expect(diskReads).toBe(1);
  });

  it("bust forces the next lookup to re-read disk", () => {
    let diskReads = 0;
    const fakeRead = () => {
      diskReads++;
      return { sessionId: "session-1", planMode: "plan" };
    };
    function gateLookup() {
      const cached = getPlanModeCache("session-1");
      if (cached) return cached.entry;
      const entry = fakeRead();
      setPlanModeCache("session-1", entry);
      return entry;
    }

    gateLookup();
    gateLookup();
    expect(diskReads).toBe(1); // hit on second call

    bustPlanModeCache("session-1");
    gateLookup();
    expect(diskReads).toBe(2); // forced re-read after bust
  });
});
