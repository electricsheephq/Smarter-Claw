/**
 * Tests for plan-mode filename helpers (W1-F2 port).
 *
 * Pins parity with the in-host
 * `src/agents/plan-mode/plan-archetype-prompt.ts` helpers
 * `buildPlanFilenameSlug` + `buildPlanFilename` at commit `ea04ea52c7`.
 */

import { describe, expect, it } from "vitest";
import {
  buildPlanFilename,
  buildPlanFilenameSlug,
} from "../../src/plan-mode/plan-filename.js";

describe("buildPlanFilenameSlug — host parity", () => {
  it("kebab-cases a normal title", () => {
    expect(buildPlanFilenameSlug("Fix the websocket reconnect race")).toBe(
      "fix-the-websocket-reconnect-race",
    );
  });

  it("returns 'untitled' for undefined", () => {
    expect(buildPlanFilenameSlug(undefined)).toBe("untitled");
  });

  it("returns 'untitled' for empty string", () => {
    expect(buildPlanFilenameSlug("")).toBe("untitled");
  });

  it("returns 'untitled' for whitespace-only", () => {
    expect(buildPlanFilenameSlug("   \t\n  ")).toBe("untitled");
  });

  it("returns 'untitled' when sanitization strips everything", () => {
    // All punctuation / control bytes collapse to ""
    expect(buildPlanFilenameSlug("!!!")).toBe("untitled");
  });

  it("strips diacritics", () => {
    expect(buildPlanFilenameSlug("Café résumé piñata")).toBe(
      "cafe-resume-pinata",
    );
  });

  it("collapses runs of non-alphanumerics into single hyphens", () => {
    expect(buildPlanFilenameSlug("Foo!!!Bar   ___baz")).toBe("foo-bar-baz");
  });

  it("trims leading and trailing hyphens", () => {
    expect(buildPlanFilenameSlug("---hello---")).toBe("hello");
  });

  it("respects the maxLen parameter", () => {
    const long = "a".repeat(200);
    expect(buildPlanFilenameSlug(long, 10)).toBe("aaaaaaaaaa");
  });

  it("trims trailing hyphen produced by slice (in-host fix)", () => {
    // The slice could leave a trailing hyphen if the cut lands on one.
    // The helper applies a final `replace(/-+$/g, "")` to clean that up.
    expect(buildPlanFilenameSlug("a-b-c-d-e-f-g-h-i-j", 5)).not.toMatch(/-$/);
  });
});

describe("buildPlanFilename — host parity", () => {
  it("formats as plan-YYYY-MM-DD-<slug>.md", () => {
    expect(
      buildPlanFilename(
        "Fix websocket reconnect race",
        new Date("2026-04-18T15:30:00Z"),
      ),
    ).toBe("plan-2026-04-18-fix-websocket-reconnect-race.md");
  });

  it("falls back to untitled when title is undefined", () => {
    expect(buildPlanFilename(undefined, new Date("2026-04-18T15:30:00Z"))).toBe(
      "plan-2026-04-18-untitled.md",
    );
  });

  it("includes the ISO date prefix for chronological sort", () => {
    const a = buildPlanFilename("z", new Date("2026-01-01T00:00:00Z"));
    const b = buildPlanFilename("a", new Date("2026-12-31T23:59:59Z"));
    // Alphabetic sort matches chronological sort because of the ISO prefix.
    expect([b, a].sort()[0]).toBe(a);
  });
});
