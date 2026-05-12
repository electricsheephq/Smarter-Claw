/**
 * Tests for `newPlanApprovalId` + `isPlanApprovalId`.
 *
 * Covers:
 * - Happy path: returns `plan-<uuid>` shape
 * - Format pinned (security-critical — downstream parsers expect it)
 * - Uniqueness across many invocations (no RNG repeat)
 * - Cryptographic prefix preserved (the `plan-` prefix is part of the
 *   wire contract — slash commands grep for it)
 * - `isPlanApprovalId` rejects malformed IDs
 *
 * NOT covered here (deferred):
 * - Throw-on-missing-RNG fallback path. Requires environment mocking
 *   that's awkward in unit tests; P-3 parity harness will exercise it
 *   against the in-host reference via Layer 1.
 */

import { describe, expect, it } from "vitest";
import { isPlanApprovalId, newPlanApprovalId } from "../../src/helpers/approval-id.js";

describe("P-2 helpers — newPlanApprovalId", () => {
  it("returns a string with the `plan-` prefix", () => {
    const id = newPlanApprovalId();
    expect(id).toMatch(/^plan-/);
  });

  it("uses canonical v4 UUID format after the prefix", () => {
    const id = newPlanApprovalId();
    // plan-<8>-<4>-<4>-<4>-<12> hex
    expect(id).toMatch(
      /^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("produces distinct values across many invocations", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(newPlanApprovalId());
    }
    expect(ids.size).toBe(1000);
  });

  it("entropy floor: returns at least 30 unique IDs in 30 calls", () => {
    // Wave-12-style sanity bound. Catches a regression where the RNG
    // accidentally returns a constant (the `Math.random().slice` bug
    // the in-host fix replaced — see helpers/approval-id.ts security
    // comment).
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) ids.add(newPlanApprovalId());
    expect(ids.size).toBe(30);
  });
});

describe("P-2 helpers — isPlanApprovalId", () => {
  it("accepts the canonical shape", () => {
    const fresh = newPlanApprovalId();
    expect(isPlanApprovalId(fresh)).toBe(true);
  });

  it("rejects non-string input", () => {
    expect(isPlanApprovalId(undefined)).toBe(false);
    expect(isPlanApprovalId(null)).toBe(false);
    expect(isPlanApprovalId(42)).toBe(false);
    expect(isPlanApprovalId({})).toBe(false);
    expect(isPlanApprovalId([])).toBe(false);
  });

  it("rejects strings without the `plan-` prefix", () => {
    expect(isPlanApprovalId("abcdef12-3456-7890-abcd-ef1234567890")).toBe(false);
    expect(isPlanApprovalId("approval-abcdef12-3456-7890-abcd-ef1234567890")).toBe(false);
  });

  it("rejects strings with the prefix but wrong UUID shape", () => {
    expect(isPlanApprovalId("plan-not-a-uuid")).toBe(false);
    expect(isPlanApprovalId("plan-abcdef12-3456")).toBe(false);
    // Uppercase hex: rejected (we mint lowercase only)
    expect(isPlanApprovalId("plan-ABCDEF12-3456-7890-ABCD-EF1234567890")).toBe(false);
    // Wrong segment lengths
    expect(isPlanApprovalId("plan-abcdef1-3456-7890-abcd-ef1234567890")).toBe(false);
    expect(isPlanApprovalId("plan-abcdef123-3456-7890-abcd-ef1234567890")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isPlanApprovalId("")).toBe(false);
  });
});
