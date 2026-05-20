#!/usr/bin/env node
/**
 * Smarter-Claw runtime registration gate.
 *
 * Loads the built plugin entry exactly the way OpenClaw's plugin loader does
 * and verifies the release-blocking registration surface:
 *   - every registered agent tool is declared in openclaw.plugin.json contracts.tools
 *   - CLI registration includes explicit descriptors for plan-clear
 *   - slash commands, session actions, Control UI, interactive handlers, and
 *     session workflow calls are all registered with usable metadata
 *
 * This gate stays local/cheap for CI, while still failing on the class of
 * manifest-vs-runtime drift that broke stable 26.5.18 plugin loads.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
}

function fail(message) {
  console.error(`[runtime-registration-gate] FAIL: ${message}`);
  process.exit(1);
}

const manifest = readJson("openclaw.plugin.json");
const pkg = readJson("package.json");
const requiredTools = ["enter_plan_mode", "exit_plan_mode", "ask_user_question"];
const requiredActions = [
  "plan.accept",
  "plan.edit",
  "plan.reject",
  "plan.cancel",
  "plan.answer",
  "plan.auto.toggle",
];
const requiredCommands = ["plan", "plan-mode"];

const declaredTools = new Set(manifest.contracts?.tools ?? []);
for (const tool of requiredTools) {
  if (!declaredTools.has(tool)) {
    fail(`openclaw.plugin.json contracts.tools missing ${tool}`);
  }
}
if (!(manifest.contracts?.sessionAttachments ?? []).includes("active-session")) {
  fail('openclaw.plugin.json contracts.sessionAttachments missing "active-session"');
}
if (pkg.openclaw?.build?.command !== "pnpm build") {
  fail("package.json openclaw.build.command must be pnpm build");
}
if (pkg.openclaw?.install?.minHostVersion !== `>=${manifest.minHostVersion}`) {
  fail(
    "package.json openclaw.install.minHostVersion must be the canonical semver floor " +
      `>=${manifest.minHostVersion}`,
  );
}

const captures = {
  tools: new Map(),
  cli: [],
  commands: new Map(),
  actions: new Map(),
  interactiveHandlers: new Map(),
  controlUis: [],
  sessionExtensions: [],
  hooks: new Map(),
};

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const api = {
  id: "smarter-claw",
  name: "Smarter-Claw",
  pluginConfig: {},
  logger,
  registerTool(tool, opts = {}) {
    const name = opts.name ?? tool?.name;
    if (!name) fail("registerTool called without name metadata");
    captures.tools.set(name, tool);
  },
  registerCli(registrar, opts = {}) {
    captures.cli.push({ registrar, opts });
  },
  registerCommand(command) {
    if (!command?.name) fail("registerCommand called without command.name");
    captures.commands.set(command.name, command);
  },
  registerInteractiveHandler(registration) {
    if (!registration?.channel || !registration?.namespace || typeof registration.handler !== "function") {
      fail("registerInteractiveHandler called without channel/namespace/handler");
    }
    captures.interactiveHandlers.set(`${registration.channel}:${registration.namespace}`, registration);
  },
  on(name, handler) {
    const existing = captures.hooks.get(name) ?? [];
    existing.push(handler);
    captures.hooks.set(name, existing);
  },
  session: {
    state: {
      registerSessionExtension(extension) {
        captures.sessionExtensions.push(extension);
      },
    },
    workflow: {
      enqueueNextTurnInjection: async (injection) => ({
        enqueued: true,
        id: "runtime-gate-injection",
        sessionKey: injection.sessionKey,
      }),
      sendSessionAttachment: async () => ({
        ok: false,
        error: "runtime gate does not deliver messages",
      }),
    },
    controls: {
      registerSessionAction(action) {
        if (!action?.id || typeof action.handler !== "function") {
          fail("registerSessionAction called without id/handler");
        }
        captures.actions.set(action.id, action);
      },
      registerControlUiDescriptor(descriptor) {
        captures.controlUis.push(descriptor);
      },
    },
  },
};

const entryUrl = pathToFileURL(resolve(repoRoot, pkg.openclaw?.build?.entry ?? "dist/src/index.js"));
const module = await import(entryUrl.href);
const entry = module.default ?? module;
if (typeof entry?.register !== "function") {
  fail("built plugin entry has no register(api) function");
}

await entry.register(api);

for (const tool of requiredTools) {
  if (!captures.tools.has(tool)) {
    fail(`runtime did not register tool ${tool}`);
  }
}
for (const registeredTool of captures.tools.keys()) {
  if (!declaredTools.has(registeredTool)) {
    fail(`runtime registered undeclared tool ${registeredTool}`);
  }
}
for (const action of requiredActions) {
  if (!captures.actions.has(action)) {
    fail(`runtime did not register session action ${action}`);
  }
}
for (const command of requiredCommands) {
  if (!captures.commands.has(command)) {
    fail(`runtime did not register slash command ${command}`);
  }
}
if (!captures.sessionExtensions.some((entry) => entry.namespace === "plan-mode")) {
  fail("runtime did not register plan-mode session extension");
}
if (!captures.controlUis.some((entry) => entry?.id === "smarter-claw.plan-mode.sidebar")) {
  fail("runtime did not register plan-mode Control UI descriptor");
}
if (!captures.interactiveHandlers.has("telegram:smarter-claw-plan")) {
  fail("runtime did not register Telegram interactive handler smarter-claw-plan");
}
const planClear = captures.cli.find((entry) =>
  (entry.opts?.descriptors ?? []).some(
    (descriptor) =>
      descriptor?.name === "plan-clear" &&
      descriptor.description &&
      descriptor.hasSubcommands === false,
  ),
);
if (!planClear) {
  fail("runtime did not register plan-clear CLI with explicit descriptor metadata");
}

console.log(
  `[runtime-registration-gate] OK — tools=${captures.tools.size}, actions=${captures.actions.size}, commands=${captures.commands.size}, interactiveHandlers=${captures.interactiveHandlers.size}`,
);
