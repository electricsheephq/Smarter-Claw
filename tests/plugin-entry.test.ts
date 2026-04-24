import { describe, expect, it } from "vitest";

import plugin from "../index.js";

type FakeApi = {
  pluginConfig?: unknown;
  tools: unknown[];
  commands: Array<{ name?: string }>;
  hooks: string[];
  registerTool: (tool: unknown) => void;
  registerCommand: (command: { name?: string }) => void;
  on: (hook: string, handler: unknown) => void;
};

function registerWithConfig(pluginConfig?: unknown): FakeApi {
  const api: FakeApi = {
    pluginConfig,
    tools: [],
    commands: [],
    hooks: [],
    registerTool(tool) {
      this.tools.push(tool);
    },
    registerCommand(command) {
      this.commands.push(command);
    },
    on(hook) {
      this.hooks.push(hook);
    },
  };
  plugin.register(api as never);
  return api;
}

describe("plugin entry registration", () => {
  it("registers the default tool, command, and lifecycle surfaces", () => {
    const api = registerWithConfig({});

    expect(api.tools).toHaveLength(4);
    expect(api.commands.map((command) => command.name)).toEqual(["plan"]);
    expect(api.hooks).toEqual(
      expect.arrayContaining([
        "before_prompt_build",
        "before_tool_call",
        "tool_result_persist",
        "gateway_start",
        "session_start",
        "subagent_spawning",
        "subagent_ended",
        "agent_end",
        "before_message_write",
      ]),
    );
  });

  it("registers nothing when the plugin is explicitly disabled", () => {
    const api = registerWithConfig({ enabled: false });

    expect(api.tools).toHaveLength(0);
    expect(api.commands).toHaveLength(0);
    expect(api.hooks).toHaveLength(0);
  });

  it("disables only the mutation gate when mutationGate.enabled is false", () => {
    const api = registerWithConfig({ mutationGate: { enabled: false } });

    expect(api.tools).toHaveLength(4);
    expect(api.commands.map((command) => command.name)).toEqual(["plan"]);
    expect(api.hooks).not.toContain("before_tool_call");
    expect(api.hooks).toEqual(
      expect.arrayContaining([
        "before_prompt_build",
        "tool_result_persist",
        "gateway_start",
        "session_start",
        "subagent_spawning",
        "subagent_ended",
        "agent_end",
        "before_message_write",
      ]),
    );
  });
});
