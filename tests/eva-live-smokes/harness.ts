/**
 * Eva live-smoke harness — end-to-end test driver for the plugin.
 *
 * # Why a custom harness
 *
 * The SDK's `contracts-testkit` only ships type defs — no runtime.
 * We build a minimal stub of `OpenClawPluginApi` that:
 *   - Captures hook registrations (`api.on(name, fn)`)
 *   - Captures tool registrations (`api.registerTool(...)`)
 *   - Captures session-action registrations
 *   - Captures CLI registrations
 *   - Exposes `triggerHook(name, event, ctx)` to invoke captured hooks
 *   - Exposes `findTool(name)` / `findAction(id)` for direct invocation
 *
 * This lets us exercise the plugin's full hook chain without spinning
 * up a real gateway — which is what we need for CI-friendly end-to-end
 * tests. The unit tests already cover each module in isolation; the
 * live-smokes cover the cross-cutting plumbing.
 *
 * # What's NOT covered
 *
 * Real LLM calls. The smokes inject synthetic agent turns (via the
 * before_tool_call / before_prompt_build event shapes) and observe
 * the plugin's reactions. A real-LLM end-to-end suite is the in-host
 * gateway's job; we're testing the PLUGIN side of the contract.
 */

import { vi } from "vitest";
import smarterClawEntry from "../../src/index.js";
import { InMemoryGateway } from "../../src/state/in-memory-gateway.js";

/**
 * Capture buckets for everything the plugin's `register()` registers.
 */
export interface HarnessCaptures {
  hooks: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  tools: Map<string, unknown>;
  sessionActions: Map<string, (ctx: unknown) => unknown>;
  sessionExtensions: Array<{ namespace: string; description?: string }>;
  controlUis: unknown[];
  enqueuedInjections: unknown[];
  sessionAttachments: unknown[];
  interactiveHandlers: Map<string, (ctx: unknown) => unknown>;
  loggerInfo: string[];
  loggerWarn: string[];
  loggerError: string[];
  cliRegistrars: Array<(ctx: unknown) => void>;
  cliOptions: unknown[];
  /** Slash commands registered via `api.registerCommand` (keyed by name). */
  commands: Map<string, unknown>;
}

/**
 * Build a fresh harness. Each call returns:
 *   - `api`: the stub OpenClawPluginApi (pass to plugin register)
 *   - `captures`: the buckets you'll assert against
 *   - `triggerHook(name, event, ctx)`: synchronously invoke any
 *     registered hook of `name` with the supplied event/ctx.
 *   - `findTool(name)`: look up a registered tool by name.
 *   - `findAction(id)`: look up a registered session action by id.
 */
export function createHarness(options: {
  /**
   * Override the env-driven gateway choice. The plugin defaults to
   * SessionStoreGateway unless `SMARTER_CLAW_USE_INMEMORY=1` is set;
   * for tests we ALWAYS want in-memory.
   */
  forceInMemory?: boolean;
  /**
   * Plugin config to expose via `api.pluginConfig`.
   */
  pluginConfig?: Record<string, unknown>;
} = {}) {
  const captures: HarnessCaptures = {
    hooks: new Map(),
    tools: new Map(),
    sessionActions: new Map(),
    sessionExtensions: [],
    controlUis: [],
    enqueuedInjections: [],
    sessionAttachments: [],
    interactiveHandlers: new Map(),
    loggerInfo: [],
    loggerWarn: [],
    loggerError: [],
    cliRegistrars: [],
    cliOptions: [],
    commands: new Map(),
  };

  // Force the plugin to use the in-memory gateway via env var (the
  // plugin entry reads `process.env.SMARTER_CLAW_USE_INMEMORY === "1"`).
  if (options.forceInMemory !== false) {
    process.env.SMARTER_CLAW_USE_INMEMORY = "1";
  }

  const api = {
    id: "smarter-claw",
    name: "Smarter-Claw",
    pluginConfig: options.pluginConfig,
    logger: {
      info: (msg: string) => captures.loggerInfo.push(msg),
      warn: (msg: string) => captures.loggerWarn.push(msg),
      error: (msg: string) => captures.loggerError.push(msg),
      debug: (_msg: string) => {},
    },
    on: vi.fn((name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      const existing = captures.hooks.get(name) ?? [];
      existing.push(fn);
      captures.hooks.set(name, existing);
    }),
    registerTool: vi.fn((tool: unknown, opts?: { name?: string }) => {
      // The plugin uses factory shape: tool is OpenClawPluginToolFactory.
      // We capture by the registration name + the factory itself.
      const name = opts?.name ?? "<unknown>";
      captures.tools.set(name, tool);
    }),
    registerCli: vi.fn((registrar: (ctx: unknown) => void, opts?: unknown) => {
      captures.cliRegistrars.push(registrar);
      captures.cliOptions.push(opts);
    }),
    registerCommand: vi.fn((command: { name?: string }) => {
      // `/plan` + `/plan-mode` slash commands (hotfix #93). Keyed by
      // command name so smokes can look them up + invoke the handler.
      captures.commands.set(command?.name ?? "<unknown>", command);
    }),
    registerInteractiveHandler: vi.fn(
      (registration: { channel: string; namespace: string; handler: (ctx: unknown) => unknown }) => {
        captures.interactiveHandlers.set(
          `${registration.channel}:${registration.namespace}`,
          registration.handler,
        );
      },
    ),
    session: {
      state: {
        registerSessionExtension: vi.fn(
          (ext: { namespace: string; description?: string }) => {
            captures.sessionExtensions.push(ext);
          },
        ),
      },
      workflow: {
        enqueueNextTurnInjection: vi.fn(async (injection: unknown) => {
          captures.enqueuedInjections.push(injection);
          return {
            enqueued: true,
            id: `inj-${captures.enqueuedInjections.length}`,
            sessionKey: (injection as { sessionKey: string }).sessionKey,
          };
        }),
        sendSessionAttachment: vi.fn(async (attachment: unknown) => {
          captures.sessionAttachments.push(attachment);
          return {
            ok: true,
            channel: "telegram",
            deliveredTo: "12345",
            count: Array.isArray((attachment as { files?: unknown }).files)
              ? ((attachment as { files: unknown[] }).files.length)
              : 0,
          };
        }),
      },
      controls: {
        registerSessionAction: vi.fn(
          (action: { id: string; handler: (ctx: unknown) => unknown }) => {
            captures.sessionActions.set(action.id, action.handler);
          },
        ),
        registerControlUiDescriptor: vi.fn((d: unknown) => {
          captures.controlUis.push(d);
        }),
      },
    },
  };

  // Run plugin register(api). Plugin uses default export from definePluginEntry
  // which has shape `{ id, name, description, register }`. Invoke register.
  const entry = smarterClawEntry as unknown as {
    register: (api: unknown) => void;
  };
  entry.register(api);

  /**
   * Trigger a captured hook. Returns the array of results from each
   * handler (most hooks have a single handler; we tolerate multiples).
   */
  async function triggerHook(
    name: string,
    event: unknown,
    ctx: unknown,
  ): Promise<unknown[]> {
    const handlers = captures.hooks.get(name) ?? [];
    const results: unknown[] = [];
    for (const fn of handlers) {
      const result = await fn(event, ctx);
      results.push(result);
    }
    return results;
  }

  /**
   * Find a tool factory by registered name.
   */
  function findTool(name: string): unknown {
    return captures.tools.get(name);
  }

  /**
   * Invoke a session action by id with the given ctx.
   */
  async function invokeAction(
    id: string,
    ctx: { sessionKey?: string; payload?: unknown },
  ): Promise<unknown> {
    const handler = captures.sessionActions.get(id);
    if (!handler) {
      throw new Error(`Session action not registered: ${id}`);
    }
    return handler({
      pluginId: "smarter-claw",
      actionId: id,
      ...ctx,
    });
  }

  return {
    api,
    captures,
    triggerHook,
    findTool,
    invokeAction,
  };
}

/**
 * Build a fresh InMemoryGateway with a single seeded session.
 * Convenience for tests that want to set up state without going
 * through the plugin's enter_plan_mode tool.
 *
 * Note: this gateway is a SEPARATE instance from the one the plugin
 * created during register(). Seeding here doesn't reach the plugin's
 * own gateway. For end-to-end smokes that need state mutations to
 * route through the plugin, drive them via the tools/actions instead
 * of seeding directly.
 */
export function freshGateway(): InMemoryGateway {
  return new InMemoryGateway();
}
