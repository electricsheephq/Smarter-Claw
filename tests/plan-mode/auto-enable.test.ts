/**
 * Tests for `evaluateAutoEnableForMatch` — surgical-port companion to
 * `src/plan-mode/auto-enable.ts`.
 *
 * **Parity contract**: verbatim port of the in-host
 * `evaluateAutoEnableForMatch` tests at
 * `/Volumes/LEXAR/repos/openclaw-pr70071-rebase/src/agents/plan-mode/auto-enable.test.ts`
 * (commit ea04ea52c7).
 *
 * Only adaptation: import path. The behavior + cases are byte-identical.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  evaluateAutoEnableForMatch,
  __resetCompiledPatternCacheForTests,
} from "../../src/plan-mode/auto-enable.js";

describe("evaluateAutoEnableForMatch", () => {
  beforeEach(() => {
    __resetCompiledPatternCacheForTests();
  });

  describe("empty / invalid inputs", () => {
    it("returns false when modelId is undefined", () => {
      expect(evaluateAutoEnableForMatch(undefined, ["openai/.*"])).toBe(false);
    });

    it("returns false when modelId is empty string", () => {
      expect(evaluateAutoEnableForMatch("", ["openai/.*"])).toBe(false);
    });

    it("returns false when patterns is undefined", () => {
      expect(evaluateAutoEnableForMatch("openai/gpt-5.4", undefined)).toBe(false);
    });

    it("returns false when patterns is empty array", () => {
      expect(evaluateAutoEnableForMatch("openai/gpt-5.4", [])).toBe(false);
    });

    it("skips non-string entries in patterns array", () => {
      const patterns: ReadonlyArray<string> = ["openai/.*"];
      // Defensive: any non-string slipping in (via untyped config) is
      // silently skipped. We can't construct that easily in TS — the
      // type guards out the obvious case. But verify the type guard
      // works when patterns contains an empty string (also skipped).
      expect(
        evaluateAutoEnableForMatch("openai/gpt-5.4", ["", ...patterns]),
      ).toBe(true);
    });
  });

  describe("happy-path matches", () => {
    it("returns true for exact regex match", () => {
      expect(
        evaluateAutoEnableForMatch("openai/gpt-5.4", ["openai/gpt-5\\.4"]),
      ).toBe(true);
    });

    it("returns true for wildcard regex match", () => {
      expect(
        evaluateAutoEnableForMatch("openai/gpt-5.4-preview", ["openai/.*"]),
      ).toBe(true);
    });

    it("returns true when ANY pattern matches (OR-semantics)", () => {
      expect(
        evaluateAutoEnableForMatch("openai/gpt-5.4", [
          "anthropic/.*",
          "openai/.*",
        ]),
      ).toBe(true);
    });

    it("returns false when no pattern matches", () => {
      expect(
        evaluateAutoEnableForMatch("openai/gpt-5.4", [
          "anthropic/.*",
          "groq/.*",
        ]),
      ).toBe(false);
    });
  });

  describe("malformed-pattern defense", () => {
    it("malformed regex pattern is silently skipped (no crash, no match)", () => {
      // `[invalid` is a syntactically broken regex — RegExp throws.
      // The helper catches + caches null, returning false.
      expect(
        evaluateAutoEnableForMatch("openai/gpt-5.4", ["[invalid"]),
      ).toBe(false);
    });

    it("malformed pattern doesn't poison the OR — other patterns still evaluated", () => {
      expect(
        evaluateAutoEnableForMatch("openai/gpt-5.4", [
          "[invalid",
          "openai/.*",
        ]),
      ).toBe(true);
    });
  });

  describe("compiled-pattern cache", () => {
    it("repeated calls with same pattern hit the cache (no re-compilation crash)", () => {
      // No direct way to observe the cache from the public API, but
      // repeating the call shouldn't change behavior — and a thrown
      // RegExp would surface as an unexpected error.
      for (let i = 0; i < 10; i++) {
        expect(
          evaluateAutoEnableForMatch("openai/gpt-5.4", ["openai/.*"]),
        ).toBe(true);
      }
    });

    it("__resetCompiledPatternCacheForTests clears the cache between tests", () => {
      // First call populates the cache.
      evaluateAutoEnableForMatch("openai/gpt-5.4", ["openai/.*"]);
      // Reset clears it. Sanity-check by verifying behavior is unchanged
      // post-reset (cache-hit-vs-recompile is opaque to the caller, but
      // a broken reset would surface as a wrong result).
      __resetCompiledPatternCacheForTests();
      expect(
        evaluateAutoEnableForMatch("openai/gpt-5.4", ["openai/.*"]),
      ).toBe(true);
    });
  });
});
