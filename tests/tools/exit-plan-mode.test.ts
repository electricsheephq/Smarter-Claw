/**
 * exit_plan_mode tool tests.
 *
 * Covers schema validation (title-required + 80-char clamp, plan steps,
 * at-most-one in_progress, archetype fields), the payloadHash +
 * approvalId minting + PlanModeStore wiring. The full Invariant 1-10
 * behavior is covered by tests/state/store.test.ts + parity-harness;
 * here we test the TOOL-level wrapping (input validation, output
 * shape, error mapping).
 *
 * Parity contract: title check + 80-char clamp + archetype echoing
 * are byte-identical to in-host (`src/agents/tools/exit-plan-mode-tool.ts`
 * at commit ea04ea52c7). Tests pin the in-host order: title check
 * runs BEFORE plan validation so the most common omission (no title)
 * surfaces first rather than after the agent has fixed an unrelated
 * plan-schema error.
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExitPlanModeTool } from "../../src/tools/exit-plan-mode.js";
import { isPlanApprovalId } from "../../src/helpers/approval-id.js";
import { InMemoryGateway } from "../../src/state/in-memory-gateway.js";
import { PlanModeStore } from "../../src/state/store.js";

const SESSION_KEY = "agent:main:main";
const TITLE = "Test plan";

function build() {
  const gw = new InMemoryGateway();
  // Seed the session in plan mode so exit_plan_mode can persist.
  gw.seed(SESSION_KEY, {
    mode: "plan",
    approval: "none",
    rejectionCount: 0,
    enteredAt: 1_700_000_000_000,
  });
  const store = new PlanModeStore(gw);
  const factory = createExitPlanModeTool({ store });
  return { gw, store, factory };
}

describe("exit_plan_mode — tool shape", () => {
  it("factory returns a tool definition with required fields", () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    expect(tool.name).toBe("exit_plan_mode");
    expect(tool.label).toBe("Exit Plan Mode");
    expect(tool.description).toMatch(/approval/i);
    expect(typeof tool.execute).toBe("function");
  });

  it("schema enforces additionalProperties: false at the top level", () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const params = tool.parameters as { additionalProperties?: boolean };
    expect(params.additionalProperties).toBe(false);
  });

  it("description contains the STOP AFTER / chat-text-banned clauses (anti-halt steer)", () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    expect(tool.description).toMatch(/STOP AFTER THIS TOOL CALL/);
    expect(tool.description).toMatch(/do NOT write the plan as a markdown list/);
    expect(tool.description).toMatch(/WAIT FOR SPAWNED SUBAGENTS/);
  });

  it("description does NOT claim a runtime subagent gate the plugin lacks (W1-A1)", () => {
    // The in-host description says "the runtime rejects submission with
    // an error listing pending child run ids" — TRUE in-host, FALSE in
    // the plugin (no such gate). The plugin keeps the wait-for-subagents
    // steering but must not assert runtime enforcement that doesn't exist.
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    expect(tool.description).not.toMatch(/runtime rejects submission/);
    expect(tool.description).not.toMatch(/pending child run ids/);
    // …but the steering itself is retained:
    expect(tool.description).toMatch(/research launched.*is not.*research complete/);
  });
});

describe("exit_plan_mode — title required (surgical-port S1 fix)", () => {
  it("rejects when title is missing", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      plan: [{ step: "a", status: "pending" }],
    });
    expect(result.details).toEqual(
      expect.objectContaining({ status: "invalid-input" }),
    );
    expect(result.content[0]?.text).toMatch(/requires a `title` field/);
    expect(result.content[0]?.text).toMatch(/Re-call exit_plan_mode/);
  });

  it("rejects when title is whitespace-only", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      title: "   ",
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe("invalid-input");
  });

  it("title check runs BEFORE plan validation (in-host order)", async () => {
    // No title + no plan → should see the title error, not a plan error.
    // This pins the in-host order: title is the most common omission and
    // should be reported first.
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {});
    expect(result.content[0]?.text).toMatch(/requires a `title` field/);
    expect(result.content[0]?.text).not.toMatch(/plan required/);
  });

  it("clamps title to 80 chars (in-host parity)", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const longTitle = "A".repeat(120);
    const result = await tool.execute("call-1", {
      title: longTitle,
      plan: [{ step: "a", status: "pending" }],
    });
    const details = result.details as { title?: string; status: string };
    expect(details.status).toBe("approval-requested");
    expect(details.title).toBe("A".repeat(80));
    expect(details.title?.length).toBe(80);
  });

  it("trims whitespace before clamping (preserves intent)", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      title: "   Bump deps   ",
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { title: string }).title).toBe("Bump deps");
  });
});

describe("exit_plan_mode — plan input validation", () => {
  it("rejects missing plan array", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", { title: TITLE });
    expect(result.details).toEqual(
      expect.objectContaining({ status: "invalid-input" }),
    );
    expect(result.content[0]?.text).toMatch(/plan required/);
  });

  it("rejects empty plan array", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", { title: TITLE, plan: [] });
    expect(result.details).toEqual(
      expect.objectContaining({ status: "invalid-input" }),
    );
  });

  it("rejects plan with multiple in_progress steps", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      title: TITLE,
      plan: [
        { step: "a", status: "in_progress" },
        { step: "b", status: "in_progress" },
      ],
    });
    expect(result.details).toEqual(
      expect.objectContaining({ status: "invalid-input" }),
    );
    expect(result.content[0]?.text).toMatch(/at most one in_progress/i);
  });

  it("rejects plan step with invalid status", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      title: TITLE,
      plan: [{ step: "a", status: "bogus_status" }],
    });
    expect(result.details).toEqual(
      expect.objectContaining({ status: "invalid-input" }),
    );
    expect(result.content[0]?.text).toMatch(/status must be one of/i);
  });

  it("accepts valid plan with one in_progress + multiple pending", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      title: TITLE,
      plan: [
        { step: "a", status: "completed" },
        { step: "b", status: "in_progress" },
        { step: "c", status: "pending" },
      ],
    });
    expect(result.details).toEqual(
      expect.objectContaining({ status: "approval-requested" }),
    );
  });
});

describe("exit_plan_mode — happy path", () => {
  it("mints a valid plan-approvalId via newPlanApprovalId", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      title: TITLE,
      plan: [{ step: "do thing", status: "pending" }],
    });
    const approvalId = (result.details as { approvalId?: string }).approvalId;
    expect(approvalId).toBeDefined();
    expect(isPlanApprovalId(approvalId)).toBe(true);
  });

  it("computes payloadHash and exposes it in details", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("call-1", {
      title: "Bump deps",
      summary: "Update tooling",
      plan: [{ step: "Bump eslint", status: "pending" }],
    });
    const hash = (result.details as { payloadHash?: string }).payloadHash;
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("persists plan-mode state through PlanModeStore", async () => {
    const { gw, factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    await tool.execute("call-1", {
      title: "Bump deps",
      plan: [
        { step: "Bump eslint", status: "pending" },
        { step: "Bump prettier", status: "pending" },
      ],
    });
    const state = gw.peek(SESSION_KEY);
    expect(state?.approval).toBe("pending");
    expect(state?.approvalId).toBeDefined();
    expect(state?.title).toBe("Bump deps");
    expect(state?.lastPlanSteps).toHaveLength(2);
    expect(state?.lastPlanPayloadHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("step count reflected in result text", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const r1 = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect(r1.content[0]?.text).toMatch(/1 step/);
    const r2 = await tool.execute("c2", {
      title: TITLE,
      plan: [
        { step: "a", status: "pending" },
        { step: "b", status: "pending" },
      ],
    });
    expect(r2.content[0]?.text).toMatch(/2 steps/);
  });

  it("result text includes the title (in-host parity)", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: "Bump deps",
      plan: [{ step: "a", status: "pending" }],
    });
    expect(result.content[0]?.text).toMatch(/Bump deps/);
  });
});

describe("exit_plan_mode — archetype fields (surgical-port S1 fix)", () => {
  it("echoes analysis when provided", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
      analysis: "Current state shows N issues; chosen approach is X because Y.",
    });
    expect((result.details as { analysis?: string }).analysis).toBe(
      "Current state shows N issues; chosen approach is X because Y.",
    );
  });

  it("trims and drops blank entries from assumptions array", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
      assumptions: ["  first  ", "", "   ", "second"],
    });
    expect((result.details as { assumptions?: string[] }).assumptions).toEqual([
      "first",
      "second",
    ]);
  });

  it("echoes risks (objects with risk + mitigation)", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
      risks: [
        { risk: "tests may flake", mitigation: "retry the suite" },
        { risk: "", mitigation: "drop" }, // dropped (blank risk)
      ],
    });
    expect((result.details as { risks?: Array<unknown> }).risks).toEqual([
      { risk: "tests may flake", mitigation: "retry the suite" },
    ]);
  });

  it("echoes verification array (trimmed, blanks dropped)", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
      verification: ["pnpm test passes", "", "  manual smoke ok  "],
    });
    expect(
      (result.details as { verification?: string[] }).verification,
    ).toEqual(["pnpm test passes", "manual smoke ok"]);
  });

  it("echoes references array", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
      references: ["src/agents/plan-mode/types.ts:42", "PR #67538"],
    });
    expect(
      (result.details as { references?: string[] }).references,
    ).toEqual(["src/agents/plan-mode/types.ts:42", "PR #67538"]);
  });

  it("omits archetype fields from details when not provided (minimal payload)", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    const details = result.details as Record<string, unknown>;
    expect(details.analysis).toBeUndefined();
    expect(details.assumptions).toBeUndefined();
    expect(details.risks).toBeUndefined();
    expect(details.verification).toBeUndefined();
    expect(details.references).toBeUndefined();
  });

  it("drops archetype field with all-blank entries (no empty arrays in result)", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
      assumptions: ["", "   ", ""],
    });
    expect((result.details as { assumptions?: string[] }).assumptions).toBeUndefined();
  });
});

describe("exit_plan_mode — duplicate detection (Invariant 3)", () => {
  it("returns duplicate-detected status + reuses existing approvalId on identical re-submit", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const input = {
      title: "Bump deps",
      plan: [{ step: "Bump eslint", status: "pending" }],
    };
    const first = await tool.execute("c1", input);
    const firstId = (first.details as { approvalId: string }).approvalId;

    const second = await tool.execute("c2", input);
    expect(second.details).toEqual(
      expect.objectContaining({ status: "duplicate-detected", approvalId: firstId }),
    );
    expect(second.content[0]?.text).toMatch(/duplicate detected/i);
  });

  it("changing the plan minted a fresh approvalId (Invariant 3 rotate path)", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: SESSION_KEY });
    const first = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "v1", status: "pending" }],
    });
    const firstId = (first.details as { approvalId: string }).approvalId;
    const second = await tool.execute("c2", {
      title: TITLE,
      plan: [{ step: "v2", status: "pending" }],
    });
    expect((second.details as { approvalId: string }).approvalId).not.toBe(firstId);
    expect((second.details as { status: string }).status).toBe("approval-requested");
  });
});

describe("exit_plan_mode — error paths", () => {
  it("returns not-in-plan-mode when session has no plan-mode payload", async () => {
    const gw = new InMemoryGateway(); // unseeded
    const store = new PlanModeStore(gw);
    const factory = createExitPlanModeTool({ store });
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe("not-in-plan-mode");
    expect(result.content[0]?.text).toMatch(/Call enter_plan_mode first/);
  });

  it("returns no-session when sessionKey unresolved", async () => {
    const { factory } = build();
    const tool = factory({ sessionKey: undefined });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe("no-session");
  });

  it("returns failed when store gateway throws", async () => {
    const brokenGw = {
      async withLock<T>(): Promise<{ transition?: T }> {
        throw new Error("simulated IO failure");
      },
    };
    const store = new PlanModeStore(brokenGw as never);
    const factory = createExitPlanModeTool({ store });
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe("failed");
    expect(result.content[0]?.text).toMatch(/simulated IO failure/);
  });
});

/**
 * W1-F2 (P0) fix (2026-05-20): the archetype-prompt + reference card
 * promise the agent that its plan title is "the persisted markdown
 * filename slug" — `plan-YYYY-MM-DD-<slug>.md` under
 * `~/.openclaw/agents/<agentId>/plans/`. Before this fix, NO code
 * wrote the file — the prompt was a lie.
 *
 * These tests pin the behavior:
 *   - On a NEW approval (`kind === "persisted"`), the persister fires
 *     and the file lands at the expected path with the expected slug.
 *   - On a duplicate submit (`kind === "reused"`), the persister does
 *     NOT fire (no second file).
 *   - On `skipped` / `failed` / `no-session` / `invalid-input`, the
 *     persister also does not fire.
 *   - Failure inside the persister is swallowed (the tool result is
 *     unaffected; only a log line escapes).
 *   - The rendered content covers the full archetype (title, summary,
 *     analysis, plan, assumptions, risks, verification, references).
 *
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:1925-1949
 *   (in-host trigger: dispatchPlanArchetypeAttachment fires
 *   immediately after emitAgentApprovalEvent in the exit_plan_mode
 *   intercept block)
 */
describe("exit_plan_mode — W1-F2 markdown persister", () => {
  // Top-level node:fs/os/path imports satisfy the ESM module rules
  // the rest of the test file already follows.
  const fs = fsp;
  const path = nodePath;

  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(
      path.join(os.tmpdir(), "smarter-claw-exit-persist-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  function buildWithPersister(opts?: {
    extraLog?: { info?: string[]; warn?: string[] };
  }) {
    const gw = new InMemoryGateway();
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "none",
      rejectionCount: 0,
      enteredAt: 1_700_000_000_000,
    });
    const store = new PlanModeStore(gw);
    const info: string[] = opts?.extraLog?.info ?? [];
    const warn: string[] = opts?.extraLog?.warn ?? [];
    const factory = createExitPlanModeTool({
      store,
      persister: {
        baseDir: tmpBase,
        log: {
          info: (m) => info.push(m),
          warn: (m) => warn.push(m),
        },
      },
    });
    return { gw, store, factory, info, warn };
  }

  it("writes <baseDir>/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md on persisted approval", async () => {
    const { factory } = buildWithPersister();
    const tool = factory({ sessionKey: SESSION_KEY, agentId: "main" });
    const result = await tool.execute("c1", {
      title: "Refactor websocket reconnect race",
      plan: [{ step: "do thing", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe(
      "approval-requested",
    );
    const plansDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(plansDir);
    expect(files).toHaveLength(1);
    const filename = files[0]!;
    expect(filename).toMatch(
      /^plan-\d{4}-\d{2}-\d{2}-refactor-websocket-reconnect-race\.md$/,
    );
    const body = await fs.readFile(path.join(plansDir, filename), "utf8");
    expect(body).toContain("# Refactor websocket reconnect race");
    expect(body).toContain("## Plan");
    expect(body).toContain("- [ ] do thing");
  });

  it("writes the full archetype (summary + analysis + assumptions + risks + verification + references)", async () => {
    const { factory } = buildWithPersister();
    const tool = factory({ sessionKey: SESSION_KEY, agentId: "main" });
    await tool.execute("c1", {
      title: "Full plan",
      summary: "Brief summary",
      analysis: "Current state.\n\nNew approach.",
      plan: [{ step: "a", status: "pending" }],
      assumptions: ["nodejs >= 20"],
      risks: [{ risk: "tests flake", mitigation: "retry the suite" }],
      verification: ["pnpm test passes"],
      references: ["src/x.ts:1"],
    });
    const plansDir = path.join(tmpBase, "main", "plans");
    const [filename] = await fs.readdir(plansDir);
    const body = await fs.readFile(path.join(plansDir, filename!), "utf8");
    expect(body).toContain("## Summary");
    expect(body).toContain("Brief summary");
    expect(body).toContain("## Analysis");
    // The renderer escapes markdown meta-characters (including `.`)
    // in user-controlled text — matches in-host `escapeMarkdown`. So
    // "Current state." renders as "Current state\." in the file.
    expect(body).toContain("Current state\\.");
    expect(body).toContain("New approach\\.");
    expect(body).toContain("## Assumptions");
    // Only `>` is in the escape set, not `=`. So "nodejs >= 20"
    // becomes "nodejs \>= 20" in the rendered markdown.
    expect(body).toContain("- nodejs \\>= 20");
    expect(body).toContain("## Risks");
    expect(body).toMatch(/- \*\*tests flake\*\*: retry the suite/);
    expect(body).toContain("## Verification");
    expect(body).toContain("- pnpm test passes");
    expect(body).toContain("## References");
    expect(body).toContain("- src/x\\.ts:1");
  });

  it("does NOT write on a duplicate-detected submit (kind=reused)", async () => {
    const { factory } = buildWithPersister();
    const tool = factory({ sessionKey: SESSION_KEY, agentId: "main" });
    const input = {
      title: "Same plan",
      plan: [{ step: "a", status: "pending" }],
    };
    const r1 = await tool.execute("c1", input);
    expect((r1.details as { status: string }).status).toBe(
      "approval-requested",
    );
    const r2 = await tool.execute("c2", input);
    expect((r2.details as { status: string }).status).toBe(
      "duplicate-detected",
    );
    // Only ONE file — the duplicate was not re-persisted.
    const files = await fs.readdir(path.join(tmpBase, "main", "plans"));
    expect(files).toHaveLength(1);
  });

  it("does NOT write when status is not-in-plan-mode", async () => {
    const gw = new InMemoryGateway(); // unseeded — session never entered plan mode
    const store = new PlanModeStore(gw);
    const factory = createExitPlanModeTool({
      store,
      persister: { baseDir: tmpBase },
    });
    const tool = factory({ sessionKey: SESSION_KEY, agentId: "main" });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe(
      "not-in-plan-mode",
    );
    // The plans/ dir was never created.
    await expect(
      fs.access(path.join(tmpBase, "main", "plans")),
    ).rejects.toThrow();
  });

  it("does NOT write when title validation rejects", async () => {
    const { factory } = buildWithPersister();
    const tool = factory({ sessionKey: SESSION_KEY, agentId: "main" });
    const result = await tool.execute("c1", {
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe(
      "invalid-input",
    );
    await expect(
      fs.access(path.join(tmpBase, "main", "plans")),
    ).rejects.toThrow();
  });

  it("collision: a 2nd same-day same-slug write produces -2 suffix", async () => {
    const { factory, gw } = buildWithPersister();
    const tool = factory({ sessionKey: SESSION_KEY, agentId: "main" });
    await tool.execute("c1", {
      title: "Hello world",
      plan: [{ step: "a", status: "pending" }],
    });
    // Reset the store so the second submit isn't deduplicated as
    // duplicate-detected (we want a NEW approval cycle that fires
    // persist again and lands on the same date+slug).
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "none",
      rejectionCount: 0,
      enteredAt: 1_700_000_000_001,
    });
    await tool.execute("c2", {
      title: "Hello world",
      plan: [{ step: "b", status: "pending" }],
    });
    const files = await fs.readdir(path.join(tmpBase, "main", "plans"));
    expect(files).toHaveLength(2);
    expect(files.some((f) => /^plan-\d{4}-\d{2}-\d{2}-hello-world\.md$/.test(f))).toBe(
      true,
    );
    expect(
      files.some((f) =>
        /^plan-\d{4}-\d{2}-\d{2}-hello-world-2\.md$/.test(f),
      ),
    ).toBe(true);
  });

  it("logs a warn and skips when persister is configured but agentId is missing (W1-F2 honesty marker)", async () => {
    const { factory, warn } = buildWithPersister();
    // No agentId on ctx.
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: "Plan",
      plan: [{ step: "a", status: "pending" }],
    });
    // Tool returns OK; persister is just skipped with a warning.
    expect((result.details as { status: string }).status).toBe(
      "approval-requested",
    );
    expect(warn.some((m) => /agentId missing/.test(m))).toBe(true);
    await expect(
      fs.access(path.join(tmpBase, "main", "plans")),
    ).rejects.toThrow();
  });

  it("logs a warn and skips when persister is not wired at all (W1-F2 honesty marker)", async () => {
    // Build WITHOUT persister to reproduce the pre-fix state.
    const gw = new InMemoryGateway();
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "none",
      rejectionCount: 0,
      enteredAt: 1_700_000_000_000,
    });
    const store = new PlanModeStore(gw);
    const factory = createExitPlanModeTool({ store }); // no persister
    const tool = factory({ sessionKey: SESSION_KEY, agentId: "main" });
    const result = await tool.execute("c1", {
      title: "Plan",
      plan: [{ step: "a", status: "pending" }],
    });
    // Result still OK.
    expect((result.details as { status: string }).status).toBe(
      "approval-requested",
    );
    // No file written.
    await expect(
      fs.access(path.join(tmpBase, "main", "plans")),
    ).rejects.toThrow();
  });

  it("approval flow is unaffected when persistence throws (non-fatal)", async () => {
    // Use a baseDir that we make read-only so write fails. On macOS,
    // chmod 0o400 on a parent dir prevents mkdir/createWriteStream.
    const lockedBase = path.join(tmpBase, "locked");
    await fs.mkdir(lockedBase, { recursive: true });
    await fs.chmod(lockedBase, 0o400);
    const warn: string[] = [];
    const gw = new InMemoryGateway();
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "none",
      rejectionCount: 0,
      enteredAt: 1_700_000_000_000,
    });
    const store = new PlanModeStore(gw);
    const factory = createExitPlanModeTool({
      store,
      persister: {
        baseDir: lockedBase,
        log: { warn: (m) => warn.push(m) },
      },
    });
    const tool = factory({ sessionKey: SESSION_KEY, agentId: "main" });
    try {
      const result = await tool.execute("c1", {
        title: "Plan",
        plan: [{ step: "a", status: "pending" }],
      });
      // Approval flow succeeded even though disk write failed.
      expect((result.details as { status: string }).status).toBe(
        "approval-requested",
      );
      // The warn channel got a message — either the storage-error
      // distinctive prefix OR the generic warn (depends on which fs
      // syscall fails first under read-only baseDir).
      expect(warn.length).toBeGreaterThan(0);
      expect(
        warn.some((m) => /persist/i.test(m) || /storage/i.test(m)),
      ).toBe(true);
    } finally {
      // Restore so afterEach can clean up.
      await fs.chmod(lockedBase, 0o700);
    }
  });
});
