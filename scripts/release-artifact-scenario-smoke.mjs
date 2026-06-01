#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SOURCE_PACKAGE = JSON.parse(
  await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result;
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed ${response.status} ${response.statusText}: ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(dest, bytes);
  return bytes;
}

async function sha256(file) {
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
}

async function createOpenClawRuntimeStub(packageDir) {
  const sdkDir = path.join(packageDir, "node_modules", "openclaw", "plugin-sdk");
  await mkdir(sdkDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "node_modules", "openclaw", "package.json"),
    JSON.stringify(
      {
        name: "openclaw",
        version: "2026.6.1-beta.1",
        type: "module",
        exports: {
          "./plugin-sdk/plugin-entry": "./plugin-sdk/plugin-entry.js",
          "./plugin-sdk/session-store-runtime": "./plugin-sdk/session-store-runtime.js",
          "./plugin-sdk/config-runtime": "./plugin-sdk/config-runtime.js",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(sdkDir, "plugin-entry.js"),
    [
      "export function definePluginEntry(entry) { return entry; }",
      "export const __releaseSmokeStub = true;",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(sdkDir, "session-store-runtime.js"),
    "export function createSessionStoreRuntime() { throw new Error('session-store runtime should not load in release smoke'); }\n",
  );
  await writeFile(
    path.join(sdkDir, "config-runtime.js"),
    "export function createConfigRuntime() { throw new Error('config runtime should not load in release smoke'); }\n",
  );
}

function createTaskFlowRuntime() {
  const flows = [];
  const events = [];
  const createManaged = (input) => {
    const flow = {
      ...input,
      flowId: `flow-${flows.length + 1}`,
      revision: 1,
      syncMode: "managed",
    };
    flows.push(flow);
    events.push({ type: "createManaged", flowId: flow.flowId, input });
    return flow;
  };
  const setWaiting = (input) => {
    const flow = flows.find((candidate) => candidate.flowId === input.flowId);
    if (!flow) return { applied: false, code: "not_found" };
    Object.assign(flow, input, {
      status: "waiting",
      revision: Number(flow.revision) + 1,
    });
    events.push({ type: "setWaiting", flowId: input.flowId, input });
    return { applied: true, flow };
  };
  const finish = (input) => {
    const flow = flows.find((candidate) => candidate.flowId === input.flowId);
    if (!flow) return { applied: false, code: "not_found" };
    Object.assign(flow, input, {
      status: "finished",
      revision: Number(flow.revision) + 1,
    });
    events.push({ type: "finish", flowId: input.flowId, input });
    return { applied: true, flow };
  };
  return {
    flows,
    events,
    managedFlows: {
      bindSession: () => ({
        createManaged,
        list: () => flows,
        setWaiting,
        finish,
      }),
    },
  };
}

function createHarness(entry) {
  const taskFlow = createTaskFlowRuntime();
  const captures = {
    hooks: new Map(),
    tools: new Map(),
    sessionActions: new Map(),
    sessionExtensions: [],
    controlUis: [],
    enqueuedInjections: [],
    sessionAttachments: [],
    interactiveHandlers: new Map(),
    commands: new Map(),
    logs: [],
  };
  const api = {
    id: "smarter-claw",
    name: "Smarter-Claw",
    pluginConfig: {},
    logger: {
      info: (message) => captures.logs.push(["info", message]),
      warn: (message) => captures.logs.push(["warn", message]),
      error: (message) => captures.logs.push(["error", message]),
      debug: (message) => captures.logs.push(["debug", message]),
    },
    runtime: {
      tasks: {
        managedFlows: taskFlow.managedFlows,
      },
    },
    on: (name, handler) => {
      const list = captures.hooks.get(name) ?? [];
      list.push(handler);
      captures.hooks.set(name, list);
    },
    registerTool: (tool, opts = {}) => {
      captures.tools.set(opts.name ?? "<unknown>", tool);
    },
    registerCli: () => {},
    registerCommand: (command) => {
      captures.commands.set(command?.name ?? "<unknown>", command);
    },
    registerInteractiveHandler: (registration) => {
      captures.interactiveHandlers.set(
        `${registration.channel}:${registration.namespace}`,
        registration.handler,
      );
    },
    session: {
      state: {
        registerSessionExtension: (extension) => {
          captures.sessionExtensions.push(extension);
        },
      },
      workflow: {
        enqueueNextTurnInjection: async (injection) => {
          captures.enqueuedInjections.push(injection);
          return {
            enqueued: true,
            id: `inj-${captures.enqueuedInjections.length}`,
            sessionKey: injection.sessionKey,
          };
        },
        sendSessionAttachment: async (attachment) => {
          captures.sessionAttachments.push(attachment);
          return { ok: true };
        },
      },
      controls: {
        registerSessionAction: (action) => {
          captures.sessionActions.set(action.id, action.handler);
        },
        registerControlUiDescriptor: (descriptor) => {
          captures.controlUis.push(descriptor);
        },
      },
    },
  };

  entry.register(api);

  return {
    captures,
    taskFlow,
    invokeAction: async (id, ctx) => {
      const handler = captures.sessionActions.get(id);
      assert(handler, `Session action not registered: ${id}`);
      return handler({
        pluginId: "smarter-claw",
        actionId: id,
        ...ctx,
      });
    },
    tool: (name, ctx) => {
      const factory = captures.tools.get(name);
      assert(factory, `Tool not registered: ${name}`);
      return factory(ctx);
    },
  };
}

async function runPlanApproveScenario(entry) {
  const sessionKey = "artifact:approve";
  const harness = createHarness(entry);
  const enter = harness.tool("enter_plan_mode", { sessionKey });
  const enterResult = await enter.execute("artifact-enter", {});
  assert(enterResult.details?.status === "entered", "enter_plan_mode did not enter plan mode");

  const exit = harness.tool("exit_plan_mode", { sessionKey });
  const exitResult = await exit.execute("artifact-exit", {
    title: "Validate release artifact",
    plan: [
      { step: "Download the release tarball", status: "completed" },
      { step: "Exercise the shipped plugin entrypoint", status: "pending" },
    ],
    summary: "Artifact-driven approval smoke.",
  });
  const approvalId = exitResult.details?.approvalId;
  assert(exitResult.details?.status === "approval-requested", "exit_plan_mode did not request approval");
  assert(typeof approvalId === "string" && approvalId.startsWith("plan-"), "missing approval id");
  assert(harness.taskFlow.flows.length === 1, "pending plan did not create a managed TaskFlow");
  assert(harness.taskFlow.flows[0].status === "waiting", "TaskFlow is not waiting on approval");

  const accepted = await harness.invokeAction("plan.accept", {
    sessionKey,
    payload: { approvalId },
  });
  assert(accepted.ok === true, "plan.accept did not succeed");
  assert(accepted.continueAgent === true, "plan.accept did not continue the agent");
  assert(harness.captures.enqueuedInjections.length === 1, "approval did not enqueue a next-turn injection");
  const injection = harness.captures.enqueuedInjections[0];
  assert(
    /^\[PLAN_DECISION\]: approved\n/.test(injection.text),
    "approval injection does not use the approved decision envelope",
  );
  assert(
    injection.text.includes("Execute it now without re-planning."),
    "approval injection does not include execution guidance",
  );
  assert(harness.taskFlow.flows[0].status === "finished", "approval did not finish the managed TaskFlow");
  return "plan approve + TaskFlow finish";
}

async function runRejectReviseScenario(entry) {
  const sessionKey = "artifact:reject-revise";
  const harness = createHarness(entry);
  await harness.tool("enter_plan_mode", { sessionKey }).execute("enter", {});
  const firstExit = await harness.tool("exit_plan_mode", { sessionKey }).execute("exit-1", {
    title: "First draft",
    plan: [{ step: "Do it", status: "pending" }],
  });
  const firstApprovalId = firstExit.details?.approvalId;
  assert(typeof firstApprovalId === "string", "first plan missing approval id");
  assert(harness.taskFlow.flows.length === 1, "first plan did not create one managed flow");

  const rejected = await harness.invokeAction("plan.reject", {
    sessionKey,
    payload: {
      approvalId: firstApprovalId,
      feedback: "too broad @channel <@U123>",
    },
  });
  assert(rejected.ok === true, "plan.reject did not succeed");
  assert(rejected.result?.rejectionCount === 1, "rejection count did not increment");
  const rejectionInjection = harness.captures.enqueuedInjections.at(-1);
  assert(
    rejectionInjection.text ===
      "[PLAN_DECISION]: rejected\nfeedback: too broad @\u{FE6B}channel <\u{200B}@U123>",
    "rejection injection does not match in-host runtime sanitizer",
  );
  assert(harness.taskFlow.flows[0].currentStep === "Plan rejected; waiting for revised plan", "rejection did not update TaskFlow currentStep");

  const revisedExit = await harness.tool("exit_plan_mode", { sessionKey }).execute("exit-2", {
    title: "Revised draft",
    plan: [{ step: "Narrow the change", status: "pending" }],
  });
  const revisedApprovalId = revisedExit.details?.approvalId;
  assert(typeof revisedApprovalId === "string", "revised plan missing approval id");
  assert(revisedApprovalId !== firstApprovalId, "revised plan reused stale approval id");
  assert(harness.taskFlow.flows.length === 1, "revised plan created a duplicate managed flow");
  assert(
    harness.taskFlow.flows[0].stateJson?.approvalId === revisedApprovalId,
    "managed flow did not move to the revised approval id",
  );
  return "reject + revised approval reuses TaskFlow";
}

async function runCancelScenario(entry) {
  const sessionKey = "artifact:cancel";
  const harness = createHarness(entry);
  await harness.tool("enter_plan_mode", { sessionKey }).execute("enter", {});
  const exitResult = await harness.tool("exit_plan_mode", { sessionKey }).execute("exit", {
    title: "Cancelable plan",
    plan: [{ step: "Wait for operator", status: "pending" }],
  });
  const approvalId = exitResult.details?.approvalId;
  assert(typeof approvalId === "string", "cancel scenario missing approval id");
  const cancelled = await harness.invokeAction("plan.cancel", {
    sessionKey,
    payload: { approvalId },
  });
  assert(cancelled.ok === true, "plan.cancel did not succeed");
  assert(cancelled.continueAgent === false, "plan.cancel should not continue the agent");
  assert(harness.taskFlow.flows[0].status === "finished", "cancel did not finish the managed TaskFlow");
  return "cancel finishes TaskFlow";
}

function validateRegistrationSurface(entry) {
  const harness = createHarness(entry);
  for (const tool of ["enter_plan_mode", "exit_plan_mode", "ask_user_question"]) {
    assert(harness.captures.tools.has(tool), `missing registered tool ${tool}`);
  }
  for (const action of [
    "plan.accept",
    "plan.edit",
    "plan.reject",
    "plan.cancel",
    "plan.answer",
    "plan.auto.toggle",
  ]) {
    assert(harness.captures.sessionActions.has(action), `missing session action ${action}`);
  }
  assert(harness.captures.commands.has("plan"), "missing /plan command");
  assert(harness.captures.commands.has("plan-mode"), "missing /plan-mode alias");
  assert(
    harness.captures.sessionExtensions.some((extension) => extension.namespace === "plan-mode"),
    "missing plan-mode session extension",
  );
  assert(
    harness.captures.interactiveHandlers.has("telegram:smarter-claw-plan"),
    "missing Telegram plan interactive handler",
  );
  assert(harness.captures.controlUis.length > 0, "missing control UI descriptor");
  return "registration surface";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expectedVersion = args["expected-version"] ?? SOURCE_PACKAGE.version;
  const expectedHost = args["expected-host"] ?? SOURCE_PACKAGE.openclaw?.target?.version;
  const expectedTag = args["openclaw-ref"] ?? SOURCE_PACKAGE.openclaw?.target?.tag;
  const expectedSha = args["expected-sha256"] ?? "";
  const tarballUrl = args["tarball-url"] ?? "";
  const tarballPath = args["tarball-path"] ?? "";
  const expectedInstallSpec = tarballUrl || SOURCE_PACKAGE.openclaw?.install?.npmSpec;

  assert(tarballUrl || tarballPath, "Pass --tarball-url or --tarball-path");

  const workDir = await mkdtemp(path.join(tmpdir(), "smarter-claw-release-smoke-"));
  try {
    const tarballFile = path.join(workDir, `smarter-claw-${expectedVersion}.tgz`);
    if (tarballUrl) {
      await download(tarballUrl, tarballFile);
    } else {
      await cp(path.resolve(tarballPath), tarballFile);
    }
    const actualSha = await sha256(tarballFile);
    if (expectedSha) {
      assert(
        actualSha === expectedSha.toLowerCase(),
        `SHA256 mismatch: expected ${expectedSha}, got ${actualSha}`,
      );
    }

    const extractDir = path.join(workDir, "extract");
    await mkdir(extractDir, { recursive: true });
    run("tar", ["-xzf", tarballFile, "-C", extractDir]);
    const packageDir = path.join(extractDir, "package");
    const pkg = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
    const manifest = JSON.parse(
      await readFile(path.join(packageDir, "dist", "openclaw.plugin.json"), "utf8"),
    );

    assert(pkg.version === expectedVersion, `package version mismatch: ${pkg.version}`);
    assert(manifest.minHostVersion === expectedHost, `manifest minHostVersion mismatch: ${manifest.minHostVersion}`);
    assert(pkg.openclaw?.target?.version === expectedHost, "package target version does not match expected host");
    assert(pkg.openclaw?.target?.tag === expectedTag, "package target tag does not match expected OpenClaw ref");
    assert(pkg.openclaw?.target?.npmPackageAvailable === false, "package should record npmPackageAvailable=false for this host target");
    assert(pkg.openclaw?.install?.minHostVersion === `>=${expectedHost}`, "package install floor does not match expected host");
    assert(pkg.openclaw?.install?.npmSpec === expectedInstallSpec, "package install spec does not match expected artifact URL");
    for (const tool of ["enter_plan_mode", "exit_plan_mode", "ask_user_question"]) {
      assert(manifest.contracts?.tools?.includes(tool), `manifest missing tool contract ${tool}`);
    }
    assert(
      manifest.contracts?.sessionAttachments?.includes("active-session"),
      "manifest missing active-session contract",
    );

    // Validate through a fresh consumer install so runtime dependencies come
    // only from the packed package's production dependency graph. We disable
    // peer auto-install because OpenClaw v2026.6.1-beta.1 is a GitHub release
    // target, not an npm-published SDK package.
    const consumerDir = path.join(workDir, "consumer");
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      path.join(consumerDir, "package.json"),
      JSON.stringify({ name: "smarter-claw-release-smoke-consumer", type: "module" }, null, 2),
    );
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
        tarballFile,
      ],
      { cwd: consumerDir },
    );
    const runtimePackageDir = path.join(
      consumerDir,
      "node_modules",
      "@electricsheephq",
      "smarter-claw",
    );
    const installedPackage = JSON.parse(
      await readFile(path.join(runtimePackageDir, "package.json"), "utf8"),
    );
    assert(installedPackage.version === expectedVersion, "consumer install picked up the wrong package version");

    await createOpenClawRuntimeStub(runtimePackageDir);
    process.env.SMARTER_CLAW_USE_INMEMORY = "1";
    const entryUrl = pathToFileURL(path.join(runtimePackageDir, "dist", "src", "index.js")).href;
    const entry = (await import(`${entryUrl}?release-smoke=${Date.now()}`)).default;
    assert(entry?.id === "smarter-claw", "plugin entry id mismatch");

    const seam = await import(
      `${pathToFileURL(path.join(runtimePackageDir, "dist", "src", "runtime", "host-seam-gates.js")).href}?release-smoke=${Date.now()}`
    );
    const classified = seam.classifyPlanNotificationDeliveryFailure(
      "session attachments are restricted to bundled plugins",
    );
    assert(classified.releaseGate === true, "active-session host seam is not release-gated");
    assert(
      classified.code === "active-session-attachments-bundled-only",
      `unexpected host seam code: ${classified.code}`,
    );

    const scenarios = [
      validateRegistrationSurface(entry),
      await runPlanApproveScenario(entry),
      await runRejectReviseScenario(entry),
      await runCancelScenario(entry),
      "active-session host seam release gate",
    ];

    console.log(
      JSON.stringify(
        {
          ok: true,
          artifact: tarballUrl || path.resolve(tarballPath),
          version: expectedVersion,
          host: expectedHost,
          openclawRef: expectedTag,
          sha256: actualSha,
          scenarios,
        },
        null,
        2,
      ),
    );
  } finally {
    delete process.env.SMTER_CLAW_USE_INMEMORY;
    delete process.env.SMARTER_CLAW_USE_INMEMORY;
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[release-artifact-scenario-smoke] ${error.stack ?? error.message}`);
  process.exit(1);
});
