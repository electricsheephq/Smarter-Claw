/**
 * Tests for `computePlanPayloadHash`.
 *
 * Parity contract: byte-identical hash output vs in-host
 * `src/agents/tools/exit-plan-mode-tool.ts:353-362`. The hash MUST be:
 *   - SHA-1 (not SHA-256)
 *   - 12-char lowercase hex prefix
 *   - Input shape: `{t, s, steps}` with `steps` = `${status}:${step}`
 *   - Order: t, s, steps (JSON.stringify preserves insertion order)
 *   - title and summary fall back to "" when absent
 *   - `activeForm` IGNORED (changes between calls for same logical plan)
 *
 * These tests pin every aspect. Any drift breaks the duplicate-detection
 * idempotency check inside `persistApprovalRequest` (P-3).
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computePlanPayloadHash } from "../../src/helpers/payload-hash.js";

/**
 * Reference implementation that mirrors the in-host hash computation
 * exactly. Used by these tests to assert byte-identical output. P-3.5
 * (parity-harness Layer 1) will replace this with a real diff against
 * the in-host source.
 */
function referenceHash(input: {
  title?: string;
  summary?: string;
  steps: Array<{ step: string; status: string }>;
}): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        t: input.title ?? "",
        s: input.summary ?? "",
        steps: input.steps.map((p) => `${p.status}:${p.step}`),
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

describe("P-2 helpers — computePlanPayloadHash shape", () => {
  it("returns a 12-character string", () => {
    const hash = computePlanPayloadHash({
      title: "x",
      summary: "y",
      steps: [{ step: "a", status: "pending" }],
    });
    expect(hash).toHaveLength(12);
  });

  it("returns lowercase hex only", () => {
    const hash = computePlanPayloadHash({
      title: "Bump deps",
      summary: "Update tooling",
      steps: [
        { step: "Update eslint", status: "pending" },
        { step: "Update prettier", status: "pending" },
      ],
    });
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("P-2 helpers — computePlanPayloadHash byte-identical vs reference", () => {
  it("matches reference for typical plan", () => {
    const input = {
      title: "Bump dependencies",
      summary: "Update eslint + prettier",
      steps: [
        { step: "Bump eslint to 9.x", status: "pending" },
        { step: "Bump prettier to 4.x", status: "pending" },
      ],
    };
    expect(computePlanPayloadHash(input)).toBe(referenceHash(input));
  });

  it("matches reference when title is missing (defaults to '')", () => {
    const input = {
      summary: "no title here",
      steps: [{ step: "do thing", status: "pending" }],
    };
    expect(computePlanPayloadHash(input)).toBe(referenceHash(input));
  });

  it("matches reference when summary is missing", () => {
    const input = {
      title: "only title",
      steps: [{ step: "do thing", status: "pending" }],
    };
    expect(computePlanPayloadHash(input)).toBe(referenceHash(input));
  });

  it("matches reference when both title and summary missing", () => {
    const input = { steps: [{ step: "do thing", status: "pending" }] };
    expect(computePlanPayloadHash(input)).toBe(referenceHash(input));
  });

  it("matches reference for empty steps array", () => {
    const input = { title: "t", summary: "s", steps: [] };
    expect(computePlanPayloadHash(input)).toBe(referenceHash(input));
  });
});

describe("P-2 helpers — computePlanPayloadHash sensitivity", () => {
  it("DIFFERENT title produces DIFFERENT hash", () => {
    const base = { steps: [{ step: "a", status: "pending" }] };
    const h1 = computePlanPayloadHash({ title: "foo", ...base });
    const h2 = computePlanPayloadHash({ title: "bar", ...base });
    expect(h1).not.toBe(h2);
  });

  it("DIFFERENT summary produces DIFFERENT hash", () => {
    const base = { title: "x", steps: [{ step: "a", status: "pending" }] };
    const h1 = computePlanPayloadHash({ summary: "v1", ...base });
    const h2 = computePlanPayloadHash({ summary: "v2", ...base });
    expect(h1).not.toBe(h2);
  });

  it("DIFFERENT step text produces DIFFERENT hash", () => {
    const base = { title: "x", summary: "y" };
    const h1 = computePlanPayloadHash({
      steps: [{ step: "a", status: "pending" }],
      ...base,
    });
    const h2 = computePlanPayloadHash({
      steps: [{ step: "b", status: "pending" }],
      ...base,
    });
    expect(h1).not.toBe(h2);
  });

  it("DIFFERENT step STATUS produces DIFFERENT hash (status is part of the input)", () => {
    const base = { title: "x", summary: "y" };
    const h1 = computePlanPayloadHash({
      steps: [{ step: "a", status: "pending" }],
      ...base,
    });
    const h2 = computePlanPayloadHash({
      steps: [{ step: "a", status: "in_progress" }],
      ...base,
    });
    expect(h1).not.toBe(h2);
  });

  it("DIFFERENT step ORDER produces DIFFERENT hash", () => {
    const base = { title: "x", summary: "y" };
    const h1 = computePlanPayloadHash({
      steps: [
        { step: "a", status: "pending" },
        { step: "b", status: "pending" },
      ],
      ...base,
    });
    const h2 = computePlanPayloadHash({
      steps: [
        { step: "b", status: "pending" },
        { step: "a", status: "pending" },
      ],
      ...base,
    });
    expect(h1).not.toBe(h2);
  });

  it("activeForm is IGNORED (parity contract: not part of the input)", () => {
    // The in-host source destructures step+status only; activeForm is
    // derived UI presentation and changes between calls for the same
    // logical plan. Including it in the hash would defeat dedup.
    const base = { title: "x", summary: "y" };
    const h1 = computePlanPayloadHash({
      steps: [{ step: "a", status: "pending" }],
      ...base,
    });
    const h2 = computePlanPayloadHash({
      steps: [{ step: "a", status: "pending", activeForm: "doing a" }],
      ...base,
    });
    expect(h1).toBe(h2);
  });

  it("identical input produces identical hash (determinism)", () => {
    const input = {
      title: "x",
      summary: "y",
      steps: [{ step: "a", status: "pending" }],
    };
    const h1 = computePlanPayloadHash(input);
    const h2 = computePlanPayloadHash(input);
    expect(h1).toBe(h2);
  });
});
