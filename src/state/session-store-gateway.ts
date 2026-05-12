/**
 * SessionStoreGateway — the production PlanModeStateGateway.
 *
 * Replaces InMemoryGateway at P-6. State now lives in the host's
 * session.json under
 * `pluginExtensions["smarter-claw"]["plan-mode"]`. Visible to UI
 * (once P-12 wires the sidebar), slash commands, channel handlers,
 * and any other client of the session row.
 *
 * # How it works
 *
 * Uses `updateSessionStoreEntry` from `openclaw/plugin-sdk/session-store-runtime`
 * — the SAME function the in-host `persistPlanApprovalRequest` uses
 * (commit ea04ea52c7, pi-embedded-subscribe.handlers.tools.ts:156).
 * This gives us:
 *
 * - **Invariant 5 (atomic lock)**: `updateSessionStoreEntry` acquires
 *   a per-session lock before calling the `update` callback.
 * - **Invariant 6 (fresh read)**: the callback receives the latest
 *   on-disk entry, not a cached projection.
 * - **Lazy imports**: SDK functions are lazy-loaded at first call so
 *   plugin load is cheap.
 *
 * # The state slot
 *
 * Plan-mode state is stored under
 * `entry.pluginExtensions["smarter-claw"]["plan-mode"]`.
 *
 * The host's projection mechanism (P-1's `registerSessionExtension`)
 * exposes this same slot to plugins reading via
 * `ctx.getSessionExtension("plan-mode")` (see the mutation-gate hook
 * in src/index.ts). So writes here are visible to the gate without
 * the InMemoryGateway fallback.
 *
 * # Migration from P-4's InMemoryGateway
 *
 * Interface is identical. Plugin entry swaps `new InMemoryGateway()`
 * for `new SessionStoreGateway({ pluginId, configLoader })`.
 */

import type { PlanModeSessionState } from "../types.js";
import type { PlanModeStateGateway } from "./store.js";

/**
 * Lazy-imported SDK surface. Resolved on first `withLock` so the
 * plugin loader doesn't pay the import cost at registration time.
 *
 * The imports are wrapped in narrow type aliases so the rest of the
 * file types check without circular SDK type imports.
 */
type SessionStoreRuntime = {
  resolveStorePath: (
    store?: string,
    opts?: { agentId?: string },
  ) => string;
  updateSessionStoreEntry: (params: {
    storePath: string;
    sessionKey: string;
    update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
  }) => Promise<SessionEntry | null>;
};

type ConfigRuntime = {
  loadConfig: () => OpenClawConfig;
};

type RoutingRuntime = {
  parseAgentSessionKey: (
    sessionKey: string,
  ) => { agentId?: string; suffix?: string } | null;
};

type SessionEntry = {
  pluginExtensions?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

type OpenClawConfig = {
  session?: { store?: string };
};

/**
 * Plugin id for the pluginExtensions slot. MUST match the plugin's
 * manifest id (smarter-claw). Importing from src/index.ts would
 * create a circular dependency; we hardcode here. The smoke test in
 * tests/state/session-store-gateway.test.ts verifies the constant.
 */
const PLUGIN_ID = "smarter-claw";

export interface SessionStoreGatewayOptions {
  /**
   * The session-extension namespace. Defaults to "plan-mode" — the
   * canonical namespace per Option C (single namespace owned by
   * PlanModeStore).
   */
  namespace?: string;
  /**
   * Optional logger for trace-level diagnostics. Production wires
   * `api.logger`; tests pass undefined.
   */
  logger?: {
    debug?: (message: string) => void;
    warn?: (message: string) => void;
  };
}

export class SessionStoreGateway implements PlanModeStateGateway {
  private readonly namespace: string;
  private readonly logger: SessionStoreGatewayOptions["logger"];
  private sdkPromise:
    | Promise<{
        runtime: SessionStoreRuntime;
        config: ConfigRuntime;
        routing: RoutingRuntime;
      }>
    | undefined;

  constructor(opts: SessionStoreGatewayOptions = {}) {
    this.namespace = opts.namespace ?? "plan-mode";
    this.logger = opts.logger;
  }

  private async loadSdk(): Promise<{
    runtime: SessionStoreRuntime;
    config: ConfigRuntime;
    routing: RoutingRuntime;
  }> {
    if (this.sdkPromise) return this.sdkPromise;
    this.sdkPromise = (async () => {
      const [storeMod, configMod, routingMod] = await Promise.all([
        import("openclaw/plugin-sdk/session-store-runtime") as Promise<
          SessionStoreRuntime
        >,
        // `loadConfig` lives in plugin-sdk/config-runtime per the
        // installed package's exports.
        import("openclaw/plugin-sdk/config-runtime" as string) as Promise<
          ConfigRuntime
        >,
        // `parseAgentSessionKey` — used to map sessionKey → agentId for
        // resolveStorePath. The in-host imports from
        // "../routing/session-key.js". In the SDK, it's exposed via
        // "openclaw/plugin-sdk/runtime" or similar; try a few common
        // locations.
        this.loadRoutingModule(),
      ]);
      return {
        runtime: storeMod,
        config: configMod,
        routing: routingMod,
      };
    })();
    return this.sdkPromise;
  }

  /**
   * Try to import the routing module from a few known SDK paths.
   * Falls back to a degraded parser if no SDK surface exposes
   * `parseAgentSessionKey` (rare; the in-host uses
   * `routing/session-key.js`).
   */
  private async loadRoutingModule(): Promise<RoutingRuntime> {
    try {
      return (await import(
        "openclaw/plugin-sdk/runtime" as string
      )) as RoutingRuntime;
    } catch {
      // Fallback: in-line minimal parser. Matches in-host
      // `parseAgentSessionKey` shape (agent:<id>:<suffix>).
      return {
        parseAgentSessionKey(sessionKey: string) {
          const m = /^agent:([^:]+):(.+)$/.exec(sessionKey);
          if (!m) return null;
          return { agentId: m[1], suffix: m[2] };
        },
      };
    }
  }

  async withLock<TTransition>(
    sessionKey: string,
    update: (
      current: PlanModeSessionState | undefined,
    ) => Promise<{
      next: PlanModeSessionState | null;
      transition?: TTransition;
    }>,
  ): Promise<{ transition?: TTransition }> {
    const { runtime, config, routing } = await this.loadSdk();
    const cfg = config.loadConfig();
    const parsed = routing.parseAgentSessionKey(sessionKey);
    const storePath = runtime.resolveStorePath(
      cfg.session?.store,
      parsed?.agentId ? { agentId: parsed.agentId } : {},
    );

    let capturedTransition: TTransition | undefined;
    await runtime.updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async (entry) => {
        // Read the plan-mode slot from pluginExtensions["smarter-claw"]["plan-mode"].
        const existing = entry.pluginExtensions?.[PLUGIN_ID]?.[
          this.namespace
        ] as PlanModeSessionState | undefined;

        const { next, transition } = await update(existing);
        if (next === null) {
          // No write requested. Skip the update entirely (matches
          // in-host updateSessionStoreEntry contract: returning null
          // from the `update` callback skips the write).
          capturedTransition = transition;
          return null;
        }
        // Capture for return path.
        capturedTransition = transition;
        // Build the partial update to the entry: replace
        // pluginExtensions[smarter-claw][plan-mode] with `next`,
        // preserving other namespaces + plugins.
        const otherPluginExtensions = entry.pluginExtensions
          ? { ...entry.pluginExtensions }
          : {};
        const otherSlots = otherPluginExtensions[PLUGIN_ID]
          ? { ...otherPluginExtensions[PLUGIN_ID] }
          : {};
        otherSlots[this.namespace] = next as unknown as Record<
          string,
          unknown
        >;
        otherPluginExtensions[PLUGIN_ID] = otherSlots;
        return {
          pluginExtensions: otherPluginExtensions,
        } as Partial<SessionEntry>;
      },
    });
    return { transition: capturedTransition };
  }
}

/**
 * For tests + parity-harness: expose the plugin-id constant so tests
 * can assert the slot key matches the manifest id without re-deriving.
 */
export const _testing = {
  PLUGIN_ID,
};
