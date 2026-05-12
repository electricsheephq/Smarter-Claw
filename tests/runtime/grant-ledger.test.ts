/**
 * P-14 grant-ledger tests.
 *
 * Validates the in-memory (approvalId, approvalRunId, sessionKey)
 * correlation map: record, get, prune, TTL expiry, sweep.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrantLedger } from "../../src/runtime/grant-ledger.js";

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("P-14 GrantLedger — record + get", () => {
  it("records and retrieves an entry by approvalId", () => {
    const ledger = new GrantLedger();
    ledger.record({
      approvalId: "plan-a",
      approvalRunId: "run-1",
      sessionKey: "agent:main:main",
    });
    const got = ledger.get("plan-a");
    expect(got).toBeDefined();
    expect(got?.approvalRunId).toBe("run-1");
    expect(got?.sessionKey).toBe("agent:main:main");
    expect(typeof got?.recordedAt).toBe("number");
  });

  it("returns undefined for unknown approvalId", () => {
    const ledger = new GrantLedger();
    expect(ledger.get("plan-missing")).toBeUndefined();
  });

  it("overwrites prior entry for the same approvalId (latest wins)", () => {
    const ledger = new GrantLedger();
    ledger.record({
      approvalId: "plan-a",
      approvalRunId: "run-1",
      sessionKey: "session-1",
    });
    ledger.record({
      approvalId: "plan-a",
      approvalRunId: "run-2",
      sessionKey: "session-2",
    });
    expect(ledger.get("plan-a")?.approvalRunId).toBe("run-2");
    expect(ledger.size()).toBe(1);
  });

  it("approvalRunId is optional on record", () => {
    const ledger = new GrantLedger();
    ledger.record({
      approvalId: "plan-a",
      sessionKey: "session-1",
    });
    expect(ledger.get("plan-a")?.approvalRunId).toBeUndefined();
  });
});

describe("P-14 GrantLedger — prune", () => {
  it("removes an entry by approvalId", () => {
    const ledger = new GrantLedger();
    ledger.record({ approvalId: "plan-a", sessionKey: "s1" });
    expect(ledger.prune("plan-a")).toBe(true);
    expect(ledger.get("plan-a")).toBeUndefined();
  });

  it("returns false when pruning an unknown id", () => {
    const ledger = new GrantLedger();
    expect(ledger.prune("plan-x")).toBe(false);
  });
});

describe("P-14 GrantLedger — TTL expiry", () => {
  it("returns undefined for an entry older than the TTL (lazy delete on get)", () => {
    vi.useFakeTimers();
    const ledger = new GrantLedger({ ttlMs: 1000 });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    ledger.record({ approvalId: "plan-a", sessionKey: "s1" });
    expect(ledger.size()).toBe(1);
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z")); // 2s later, past 1s TTL
    expect(ledger.get("plan-a")).toBeUndefined();
    expect(ledger.size()).toBe(0); // lazy delete fired
  });

  it("preserves entries within the TTL window", () => {
    vi.useFakeTimers();
    const ledger = new GrantLedger({ ttlMs: 60_000 });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    ledger.record({ approvalId: "plan-a", sessionKey: "s1" });
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z")); // 30s later, within 60s TTL
    expect(ledger.get("plan-a")).toBeDefined();
  });

  it("defaults to 1-hour TTL when no option provided", () => {
    vi.useFakeTimers();
    const ledger = new GrantLedger();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    ledger.record({ approvalId: "plan-a", sessionKey: "s1" });
    vi.setSystemTime(new Date("2026-01-01T00:59:00Z")); // 59 minutes later
    expect(ledger.get("plan-a")).toBeDefined();
    vi.setSystemTime(new Date("2026-01-01T01:01:00Z")); // 61 minutes later
    expect(ledger.get("plan-a")).toBeUndefined();
  });

  it("ignores negative/zero ttlMs and uses the default", () => {
    vi.useFakeTimers();
    const ledger = new GrantLedger({ ttlMs: 0 });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    ledger.record({ approvalId: "plan-a", sessionKey: "s1" });
    vi.setSystemTime(new Date("2026-01-01T00:30:00Z"));
    expect(ledger.get("plan-a")).toBeDefined(); // default TTL kicks in
  });
});

describe("P-14 GrantLedger — sweepExpired", () => {
  it("removes all entries older than TTL", () => {
    vi.useFakeTimers();
    const ledger = new GrantLedger({ ttlMs: 1000 });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    ledger.record({ approvalId: "plan-a", sessionKey: "s1" });
    ledger.record({ approvalId: "plan-b", sessionKey: "s2" });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.5Z")); // past TTL
    ledger.record({ approvalId: "plan-c", sessionKey: "s3" }); // fresh
    const pruned = ledger.sweepExpired();
    expect(pruned).toBe(2);
    expect(ledger.size()).toBe(1);
    expect(ledger.get("plan-c")).toBeDefined();
    expect(ledger.get("plan-a")).toBeUndefined();
    expect(ledger.get("plan-b")).toBeUndefined();
  });

  it("returns 0 when nothing is expired", () => {
    const ledger = new GrantLedger();
    ledger.record({ approvalId: "plan-a", sessionKey: "s1" });
    expect(ledger.sweepExpired()).toBe(0);
  });
});

describe("P-14 GrantLedger — diagnostics", () => {
  it("size() reports the current count", () => {
    const ledger = new GrantLedger();
    expect(ledger.size()).toBe(0);
    ledger.record({ approvalId: "plan-a", sessionKey: "s1" });
    ledger.record({ approvalId: "plan-b", sessionKey: "s2" });
    expect(ledger.size()).toBe(2);
    ledger.prune("plan-a");
    expect(ledger.size()).toBe(1);
  });

  it("approvalIds() returns the list of recorded ids", () => {
    const ledger = new GrantLedger();
    ledger.record({ approvalId: "plan-a", sessionKey: "s1" });
    ledger.record({ approvalId: "plan-b", sessionKey: "s2" });
    expect(new Set(ledger.approvalIds())).toEqual(
      new Set(["plan-a", "plan-b"]),
    );
  });
});
