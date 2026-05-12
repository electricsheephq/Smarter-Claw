/**
 * P-1 skeleton tests.
 *
 * Covers:
 * - Plugin module loads without crashing
 * - Default export shape matches definePluginEntry contract
 * - resolveConfig honors defaults + accepts user overrides
 * - resolveConfig is safe against malformed input
 * - Advisory message contains the required-config string operators will grep for
 *
 * Does NOT cover (deferred to later PRs):
 * - Plugin registration end-to-end against a real OpenClaw host — that's
 *   the Eva live-smoke #1 gate at P-5.
 * - Behavior when `allowConversationAccess` is missing/present — those
 *   hooks land at P-7+P-10; testing them requires the host runtime.
 */

import { describe, expect, it } from "vitest";
import pluginEntry, {
  SMARTER_CLAW_PLUGIN_ID,
  PLAN_MODE_SESSION_EXTENSION_NAMESPACE,
  __testing,
} from "../src/index.js";

describe("P-1 plugin entry — module shape", () => {
  it("exports a default plugin definition", () => {
    expect(pluginEntry).toBeDefined();
    expect(typeof pluginEntry).toBe("object");
  });

  it("plugin id matches manifest", () => {
    expect(pluginEntry.id).toBe("smarter-claw");
    expect(SMARTER_CLAW_PLUGIN_ID).toBe("smarter-claw");
  });

  it("plugin name + description present", () => {
    expect(pluginEntry.name).toBe("Smarter-Claw");
    expect(pluginEntry.description).toMatch(/Plan-Mode/);
  });

  it("omits `kind` (general workflow plugin, not memory/context-engine)", () => {
    // Per installed SDK (openclaw 2026.5.7): PluginKind = "memory" |
    // "context-engine" only. General workflow plugins like Smarter-Claw
    // leave `kind` undefined. The installer-patch-era assumption that
    // "workspace" was a valid kind was wrong (the kind field in the OLD
    // openclaw.plugin.json was schema-accepted but semantically a no-op,
    // which is the exact failure mode that 04-LESSONS_LEARNED.md flags).
    expect(pluginEntry.kind).toBeUndefined();
  });

  it("exposes a register function", () => {
    expect(typeof pluginEntry.register).toBe("function");
  });

  it("session-extension namespace is the locked 'plan-mode'", () => {
    // Per Option C: single namespace owned by PlanModeStore. Splitting
    // the namespace would break the architecture invariant.
    expect(PLAN_MODE_SESSION_EXTENSION_NAMESPACE).toBe("plan-mode");
  });
});

describe("P-1 plugin entry — config resolution", () => {
  it("returns default config for undefined input", () => {
    const result = __testing.resolveConfig(undefined);
    expect(result).toEqual(__testing.DEFAULT_CONFIG);
    expect(result.enabled).toBe(true);
  });

  it("returns default config for null input", () => {
    const result = __testing.resolveConfig(null);
    expect(result.enabled).toBe(true);
  });

  it("returns default config for non-object input (defense vs malformed config)", () => {
    expect(__testing.resolveConfig("garbage").enabled).toBe(true);
    expect(__testing.resolveConfig(42).enabled).toBe(true);
    expect(__testing.resolveConfig([1, 2, 3]).enabled).toBe(true);
  });

  it("honors enabled=false override", () => {
    const result = __testing.resolveConfig({ enabled: false });
    expect(result.enabled).toBe(false);
  });

  it("falls back to default when enabled is non-boolean (type-safety)", () => {
    const result = __testing.resolveConfig({ enabled: "false" } as unknown);
    // "false" is not a boolean; default true wins
    expect(result.enabled).toBe(true);
  });

  it("ignores unknown config keys gracefully", () => {
    const result = __testing.resolveConfig({
      enabled: true,
      // future field that doesn't exist yet
      bogusField: 123,
    } as unknown);
    expect(result.enabled).toBe(true);
  });
});

describe("P-1 plugin entry — advisory message", () => {
  it("advisory contains the operator-config path", () => {
    const msg = __testing.buildAdvisorySessionMessage();
    expect(msg).toContain("plugins.entries.smarter-claw.hooks.allowConversationAccess");
  });

  it("advisory mentions both works-without and requires-with surfaces", () => {
    const msg = __testing.buildAdvisorySessionMessage();
    expect(msg).toMatch(/mutation gate/i);
    expect(msg).toMatch(/archetype|auto-continue|escalating[- ]retry/i);
  });

  it("advisory points users at documentation", () => {
    const msg = __testing.buildAdvisorySessionMessage();
    expect(msg).toMatch(/github\.com.*Smarter-Claw/);
  });
});
