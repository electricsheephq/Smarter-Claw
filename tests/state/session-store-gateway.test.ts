/**
 * P-6 SessionStoreGateway smoke + shape tests.
 *
 * Full integration coverage (real session.json, real
 * updateSessionStoreEntry round-trip) lands at Eva live-smoke #2
 * (P-8) when the end-to-end approval flow gets exercised. This test
 * file pins:
 *
 *   - Module shape: SessionStoreGateway exports as expected
 *   - Constant: PLUGIN_ID matches the plugin manifest id
 *   - Construction: no-throw with default + custom options
 *   - Interface: implements PlanModeStateGateway (withLock present)
 *
 * Deliberately NOT tested here:
 *   - Real disk writes (requires session-store fixture + SDK loaded;
 *     adds integration-test infra better suited to a separate
 *     `tests/integration/` tier).
 *   - The SDK lazy-import resolution (vitest-mockable but adds
 *     brittleness for marginal value; covered by Eva-live).
 */

import { describe, expect, it } from "vitest";
import { SessionStoreGateway, _testing } from "../../src/state/session-store-gateway.js";

describe("P-6 SessionStoreGateway — shape", () => {
  it("exports a SessionStoreGateway class", () => {
    expect(SessionStoreGateway).toBeDefined();
    expect(typeof SessionStoreGateway).toBe("function");
  });

  it("PLUGIN_ID matches the manifest id (smarter-claw)", () => {
    // Defends against accidental drift between the manifest id +
    // pluginExtensions slot key. If these diverge, state writes go
    // to the wrong slot and the host's session-extension projection
    // can't find them.
    expect(_testing.PLUGIN_ID).toBe("smarter-claw");
  });

  it("constructs with no args (defaults applied)", () => {
    const gw = new SessionStoreGateway();
    expect(gw).toBeInstanceOf(SessionStoreGateway);
  });

  it("constructs with custom namespace", () => {
    const gw = new SessionStoreGateway({ namespace: "plan-mode" });
    expect(gw).toBeInstanceOf(SessionStoreGateway);
  });

  it("constructs with logger", () => {
    const gw = new SessionStoreGateway({
      logger: { debug: () => {}, warn: () => {} },
    });
    expect(gw).toBeInstanceOf(SessionStoreGateway);
  });

  it("has a withLock method on the instance (PlanModeStateGateway contract)", () => {
    const gw = new SessionStoreGateway();
    expect(typeof gw.withLock).toBe("function");
  });

  it("uses the SDK session-key parser when the runtime exposes one", () => {
    const routing = _testing.resolveRoutingRuntime({
      parseAgentSessionKey: (sessionKey: string) => ({
        agentId: "sdk",
        suffix: sessionKey,
      }),
    });

    expect(routing.parseAgentSessionKey("agent:main:subagent:abc")).toEqual({
      agentId: "sdk",
      suffix: "agent:main:subagent:abc",
    });
  });

  it("falls back when the SDK runtime lacks parseAgentSessionKey", () => {
    const warnings: string[] = [];
    const routing = _testing.resolveRoutingRuntime(
      { runtimeLoaded: true },
      { warn: (message) => warnings.push(message) },
    );

    expect(routing.parseAgentSessionKey("agent:main:subagent:abc")).toEqual({
      agentId: "main",
      suffix: "subagent:abc",
    });
    expect(routing.parseAgentSessionKey("main")).toBeNull();
    expect(warnings[0]).toContain("missing parseAgentSessionKey");
  });
});
