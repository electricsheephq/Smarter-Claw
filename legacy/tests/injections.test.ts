/**
 * Ported from openclaw-1: src/agents/plan-mode/injections.test.ts
 *
 * Adapted for Smarter-Claw API:
 *   - The Smarter-Claw injections module is host-object-based (sync,
 *     in-memory) — there's no `enqueuePendingAgentInjection(sessionKey, ...)`
 *     async helper that talks to a session store, no
 *     `migrateLegacyPendingInjection`, and `consumePendingAgentInjections`
 *     takes a host object instead of a sessionKey. The installer-side
 *     patch is responsible for the store I/O.
 *   - The pure helpers (sortAndCapQueue, upsertIntoQueue,
 *     composePromptWithPendingInjections, DEFAULT_INJECTION_PRIORITY,
 *     MAX_QUEUE_SIZE) port verbatim — they're the same algorithm.
 *   - The e2e store-based tests + the legacy-scalar migration test are
 *     skipped here; they live with the installer patch where the host
 *     I/O is handled. Tracked in tests/SKIPPED.md.
 */
import { describe, expect, it, vi } from "vitest";
import {
  appendToInjectionQueue,
  composePromptWithPendingInjections,
  consumePendingAgentInjections,
  DEFAULT_INJECTION_PRIORITY,
  MAX_QUEUE_SIZE,
  type InjectionQueueHost,
  type PendingAgentInjectionEntry,
  sortAndCapQueue,
  upsertIntoQueue,
} from "../src/injections.js";

function mkEntry(
  kind: PendingAgentInjectionEntry["kind"],
  id: string,
  createdAt: number,
  overrides: Partial<PendingAgentInjectionEntry> = {},
): PendingAgentInjectionEntry {
  return {
    id,
    kind,
    text: `text:${kind}:${id}`,
    createdAt,
    ...overrides,
  };
}

describe("upsertIntoQueue", () => {
  it("appends when id is not present", () => {
    const q = [mkEntry("plan_decision", "a", 1)];
    const next = upsertIntoQueue(q, mkEntry("question_answer", "b", 2));
    expect(next).toHaveLength(2);
    expect(next.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("replaces in place when id already exists (no duplicate)", () => {
    const q = [mkEntry("plan_decision", "a", 1, { text: "old" })];
    const next = upsertIntoQueue(q, mkEntry("plan_decision", "a", 2, { text: "new" }));
    expect(next).toHaveLength(1);
    expect(next[0]?.text).toBe("new");
    expect(next[0]?.createdAt).toBe(2);
  });

  it("does not mutate the input queue", () => {
    const q = [mkEntry("plan_decision", "a", 1)];
    const snapshot = JSON.stringify(q);
    upsertIntoQueue(q, mkEntry("question_answer", "b", 2));
    expect(JSON.stringify(q)).toBe(snapshot);
  });
});

describe("sortAndCapQueue", () => {
  it("orders by priority DESC, then createdAt ASC", () => {
    const q: PendingAgentInjectionEntry[] = [
      mkEntry("plan_nudge", "n1", 100), // priority 1 by default
      mkEntry("plan_decision", "d1", 200), // priority 10 by default
      mkEntry("question_answer", "q1", 300), // priority 8 by default
      mkEntry("plan_decision", "d2", 150), // priority 10, older
    ];
    const sorted = sortAndCapQueue(q);
    expect(sorted.map((e) => e.id)).toEqual(["d2", "d1", "q1", "n1"]);
  });

  it("honors explicit priority overrides", () => {
    const q: PendingAgentInjectionEntry[] = [
      mkEntry("plan_nudge", "n1", 100, { priority: 100 }),
      mkEntry("plan_decision", "d1", 200),
    ];
    const sorted = sortAndCapQueue(q);
    expect(sorted.map((e) => e.id)).toEqual(["n1", "d1"]);
  });

  it("caps at MAX_QUEUE_SIZE and warns on eviction", () => {
    const warn = vi.fn();
    const q: PendingAgentInjectionEntry[] = [];
    for (let i = 0; i < MAX_QUEUE_SIZE + 3; i++) {
      q.push(mkEntry("plan_nudge", `n${i}`, i));
    }
    const sorted = sortAndCapQueue(q, { warn });
    expect(sorted).toHaveLength(MAX_QUEUE_SIZE);
    expect(warn).toHaveBeenCalledTimes(3);
    // Sort order is (priority DESC, createdAt ASC) → oldest createdAt
    // first within the priority band; the NEWEST overflow drops.
    expect(sorted.map((e) => e.id)).toEqual([
      "n0",
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
      "n6",
      "n7",
      "n8",
      "n9",
    ]);
  });

  it("plan_decision uses keep-newest policy on cap (BUG #4 fix)", () => {
    // Pre-fix: sorted ASC by createdAt + slice(0, MAX) → kept oldest,
    // dropped newest. For plan_decision (multi-revision rejection
    // cycles), this silently delivered 8-revision-stale feedback to
    // the agent and dropped the user's most recent feedback. Adversarial
    // QA's BUG #4. Now: plan_decision keeps the most recent MAX entries.
    const warn = vi.fn();
    const q: PendingAgentInjectionEntry[] = [];
    for (let i = 0; i < MAX_QUEUE_SIZE + 3; i++) {
      // Distinct ids + monotonic createdAt — id "d0" is OLDEST, "d12" NEWEST.
      q.push(mkEntry("plan_decision", `d${i}`, i));
    }
    const sorted = sortAndCapQueue(q, { warn });
    expect(sorted).toHaveLength(MAX_QUEUE_SIZE);
    expect(warn).toHaveBeenCalledTimes(3);
    // Kept the LAST 10 (newest createdAt). Dropped d0/d1/d2 (oldest).
    expect(sorted.map((e) => e.id)).toEqual([
      "d3",
      "d4",
      "d5",
      "d6",
      "d7",
      "d8",
      "d9",
      "d10",
      "d11",
      "d12",
    ]);
    // Warn text reflects the actual policy ("dropping older entry"
    // not the misleading old "dropping oldest" — also closes BUG #10).
    const warnCalls = warn.mock.calls.map((args) => args[0]);
    expect(warnCalls.every((m) => m.includes("dropping older"))).toBe(true);
    expect(warnCalls.every((m) => m.includes("kind=plan_decision"))).toBe(true);
  });

  it("preserves all entries when queue is under cap", () => {
    const q = [mkEntry("plan_decision", "d1", 1), mkEntry("question_answer", "q1", 2)];
    const sorted = sortAndCapQueue(q);
    expect(sorted).toHaveLength(2);
  });

  it("does not mutate the input queue", () => {
    const q = [mkEntry("plan_nudge", "n1", 100), mkEntry("plan_decision", "d1", 200)];
    const snapshot = JSON.stringify(q);
    sortAndCapQueue(q);
    expect(JSON.stringify(q)).toBe(snapshot);
  });

  it("is deterministic when priority AND createdAt tie", () => {
    const q: PendingAgentInjectionEntry[] = [
      mkEntry("plan_decision", "zebra", 1000),
      mkEntry("plan_decision", "apple", 1000),
      mkEntry("plan_decision", "middle", 1000),
    ];
    const sorted = sortAndCapQueue(q);
    expect(sorted.map((e) => e.id)).toEqual(["apple", "middle", "zebra"]);
    const reversed = q.toReversed();
    const sortedAgain = sortAndCapQueue(reversed);
    expect(sortedAgain.map((e) => e.id)).toEqual(["apple", "middle", "zebra"]);
  });
});

describe("composePromptWithPendingInjections", () => {
  it("returns the user prompt unchanged when queue is empty", () => {
    expect(composePromptWithPendingInjections([], "do the thing")).toBe("do the thing");
  });

  it("joins multiple entries with double newlines, then separates from user prompt", () => {
    const entries = [
      mkEntry("plan_decision", "d1", 1, { text: "[PLAN_DECISION]: approved" }),
      mkEntry("subagent_return", "s1", 2, { text: "[SUBAGENT_RETURN]: runId=abc" }),
    ];
    expect(composePromptWithPendingInjections(entries, "next")).toBe(
      "[PLAN_DECISION]: approved\n\n[SUBAGENT_RETURN]: runId=abc\n\nnext",
    );
  });

  it("emits injection only when user prompt is empty or whitespace-only", () => {
    const entries = [mkEntry("plan_decision", "d1", 1, { text: "[PLAN_DECISION]: approved" })];
    expect(composePromptWithPendingInjections(entries, "")).toBe("[PLAN_DECISION]: approved");
    expect(composePromptWithPendingInjections(entries, "   \n  ")).toBe(
      "[PLAN_DECISION]: approved",
    );
  });

  it("trims user prompt before composing", () => {
    const entries = [mkEntry("question_answer", "q1", 1, { text: "[QUESTION_ANSWER]: yes" })];
    expect(composePromptWithPendingInjections(entries, "  hi  \n")).toBe(
      "[QUESTION_ANSWER]: yes\n\nhi",
    );
  });
});

describe("DEFAULT_INJECTION_PRIORITY", () => {
  it("orders plan_decision above every other kind", () => {
    const pd = DEFAULT_INJECTION_PRIORITY.plan_decision ?? 0;
    for (const kind of [
      "plan_complete",
      "question_answer",
      "subagent_return",
      "plan_intro",
      "plan_nudge",
    ]) {
      expect(pd).toBeGreaterThan(DEFAULT_INJECTION_PRIORITY[kind] ?? 0);
    }
  });

  it("orders plan_complete above question_answer", () => {
    expect(DEFAULT_INJECTION_PRIORITY.plan_complete ?? 0).toBeGreaterThan(
      DEFAULT_INJECTION_PRIORITY.question_answer ?? 0,
    );
  });
});

// Smarter-Claw-specific: the host-based enqueue/consume cycle replaces
// the openclaw-1 sessionKey-based async store I/O. These tests verify
// the actual API surface the installer patch consumes.
describe("appendToInjectionQueue + consumePendingAgentInjections (host-based)", () => {
  it("returns empty result when host has no queue", () => {
    const host: InjectionQueueHost = {};
    const result = consumePendingAgentInjections(host);
    expect(result.injections).toHaveLength(0);
    expect(result.composedText).toBeUndefined();
  });

  it("returns empty result when queue is empty array", () => {
    const host: InjectionQueueHost = { pendingAgentInjections: [] };
    const result = consumePendingAgentInjections(host);
    expect(result.injections).toHaveLength(0);
    expect(result.composedText).toBeUndefined();
  });

  it("appends entry, then consume returns it (single-entry round trip)", () => {
    const host: InjectionQueueHost = {};
    appendToInjectionQueue(host, {
      id: "plan-decision-abc",
      kind: "plan_decision",
      text: "[PLAN_DECISION]: approved",
      createdAt: 1000,
    });
    const result = consumePendingAgentInjections(host);
    expect(result.injections).toHaveLength(1);
    expect(result.composedText).toBe("[PLAN_DECISION]: approved");
  });

  it("dedup upsert: same-id second append replaces the first", () => {
    const host: InjectionQueueHost = {};
    appendToInjectionQueue(host, {
      id: "plan-decision-abc",
      kind: "plan_decision",
      text: "first",
      createdAt: 1000,
    });
    appendToInjectionQueue(host, {
      id: "plan-decision-abc",
      kind: "plan_decision",
      text: "second",
      createdAt: 2000,
    });
    const result = consumePendingAgentInjections(host);
    expect(result.injections).toHaveLength(1);
    expect(result.injections[0]?.text).toBe("second");
  });

  it("two different-kind entries both land (no clobber)", () => {
    const host: InjectionQueueHost = {};
    appendToInjectionQueue(host, {
      id: "plan-decision-abc",
      kind: "plan_decision",
      text: "[PLAN_DECISION]: approved",
      createdAt: 1000,
    });
    appendToInjectionQueue(host, {
      id: "question-answer-def",
      kind: "question_answer",
      text: "[QUESTION_ANSWER]: yes",
      createdAt: 1001,
    });
    const result = consumePendingAgentInjections(host);
    // Sorted by priority DESC: plan_decision (10) > question_answer (8).
    expect(result.injections.map((e) => e.kind)).toEqual(["plan_decision", "question_answer"]);
    expect(result.composedText).toBe("[PLAN_DECISION]: approved\n\n[QUESTION_ANSWER]: yes");
  });

  it("filters out expired entries at consume time", () => {
    const host: InjectionQueueHost = {};
    // Use a very-low createdAt + expiresAt=1 so it's already expired
    // regardless of when the test runs.
    appendToInjectionQueue(host, {
      id: "nudge-1",
      kind: "plan_nudge",
      text: "[PLAN_NUDGE]: stale",
      createdAt: 1000,
      expiresAt: 1,
    });
    appendToInjectionQueue(host, {
      id: "nudge-2",
      kind: "plan_nudge",
      text: "[PLAN_NUDGE]: fresh",
      createdAt: 1000,
    });
    const result = consumePendingAgentInjections(host);
    expect(result.injections.map((e) => e.id)).toEqual(["nudge-2"]);
  });
});
