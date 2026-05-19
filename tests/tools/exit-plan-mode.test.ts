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

/**
 * W1-F4 (P1) fix (2026-05-20): the `autoApprove` flag had a real
 * mutator + a real `/plan auto on|off` command, but no caller —
 * RELEASE_NOTES known-limitation #3 said "the runtime side that
 * actually FIRES auto-approve on `exit_plan_mode` … lands at
 * P-final." `benchmark-codex-claude-code.md` audit row F4 escalated
 * this to a "non-functional safety-relevant control" P1.
 *
 * These tests pin the trigger contract at the tool layer:
 *   - When `autoApprove` is OFF (or unset), the trigger never fires.
 *   - When `autoApprove` is ON and the persist succeeds, the trigger
 *     fires with the persisted approvalId + the plan steps.
 *   - Fires on BOTH the "persisted" and "reused" paths (matching the
 *     in-host's unconditional void-fire after the approval emit).
 *   - Re-reads the flag immediately before firing (operator toggle
 *     off mid-cycle is honored — no auto-approve on a flipped state).
 *   - The trigger callback's failures DO NOT propagate out of execute.
 *
 * The end-to-end "auto-approve produces an approved injection +
 * advances the state machine" coverage lives in the eva-live-smokes
 * (see `tests/eva-live-smokes/smoke-5-auto-approve.test.ts`); these
 * unit tests are scoped to the tool layer's trigger-firing rules.
 *
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:387-477
 *   (`autoApproveIfEnabled`)
 * host_ref: src/agents/pi-embedded-subscribe.handlers.tools.ts:1949-1962
 *   (the in-host callsite, void-fired after the approval emit)
 */
describe("exit_plan_mode — W1-F4 auto-approve trigger", () => {
  /**
   * Build a tool with both an in-mem store and an optional
   * pre-existing `autoApprove` flag on the seeded session. Capture
   * trigger calls + log lines for assertion.
   */
  function buildWithAutoApprove(
    seedAutoApprove: boolean,
  ): {
    gw: InMemoryGateway;
    store: PlanModeStore;
    factory: ReturnType<typeof createExitPlanModeTool>;
    triggerCalls: Array<{
      sessionKey: string;
      approvalId: string;
      planSteps: unknown[];
    }>;
    triggerErrors: Error[];
    info: string[];
    warn: string[];
    error: string[];
    /** Mutator that lets a test simulate the operator toggling
     *  autoApprove OFF mid-cycle, between persist and trigger. */
    setAutoApprove(enabled: boolean): Promise<void>;
  } {
    const gw = new InMemoryGateway();
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "none",
      rejectionCount: 0,
      enteredAt: 1_700_000_000_000,
      ...(seedAutoApprove ? { autoApprove: true } : {}),
    });
    const store = new PlanModeStore(gw);
    const triggerCalls: Array<{
      sessionKey: string;
      approvalId: string;
      planSteps: unknown[];
    }> = [];
    const triggerErrors: Error[] = [];
    const info: string[] = [];
    const warn: string[] = [];
    const error: string[] = [];
    const factory = createExitPlanModeTool({
      store,
      autoApprove: {
        trigger: async (params) => {
          triggerCalls.push({
            sessionKey: params.sessionKey,
            approvalId: params.approvalId,
            // Materialize a shallow copy so tests assert on a snapshot.
            planSteps: [...params.planSteps],
          });
          if (triggerErrors.length > 0) {
            throw triggerErrors.shift();
          }
        },
        log: {
          info: (m) => info.push(m),
          warn: (m) => warn.push(m),
          error: (m) => error.push(m),
        },
      },
    });
    return {
      gw,
      store,
      factory,
      triggerCalls,
      triggerErrors,
      info,
      warn,
      error,
      async setAutoApprove(enabled: boolean) {
        await store.setAutoApprove({ sessionKey: SESSION_KEY, enabled });
      },
    };
  }

  it("does NOT fire when autoApprove option is unwired (pre-W1-F4 baseline preserved)", async () => {
    // Build a tool WITHOUT autoApprove wired AND with the flag
    // pre-set on the seed. The flag exists in state but the tool
    // option is absent — no trigger should run.
    const gw = new InMemoryGateway();
    gw.seed(SESSION_KEY, {
      mode: "plan",
      approval: "none",
      rejectionCount: 0,
      enteredAt: 1_700_000_000_000,
      autoApprove: true,
    });
    const store = new PlanModeStore(gw);
    const triggerCalls: unknown[] = [];
    const factory = createExitPlanModeTool({ store }); // no autoApprove opt
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe(
      "approval-requested",
    );
    // The trigger captures bucket is local to the test (no trigger
    // was wired) — confirm via the persisted state, which should
    // STILL be pending (no auto-resolve happened).
    expect(triggerCalls).toEqual([]);
    expect(gw.peek(SESSION_KEY)?.approval).toBe("pending");
  });

  it("does NOT fire when autoApprove is unset on the session state", async () => {
    const t = buildWithAutoApprove(false);
    const tool = t.factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe(
      "approval-requested",
    );
    // Give the void-fired trigger a tick to potentially run.
    await new Promise((r) => setTimeout(r, 10));
    expect(t.triggerCalls).toEqual([]);
    // The skip should be logged at info (not warn/error) — toggling
    // off is the expected operator-driven path, not a failure.
    expect(
      t.info.some((m) => /auto-approve skipped/i.test(m)),
    ).toBe(true);
  });

  it("fires with the persisted approvalId + plan steps when autoApprove is on (persisted path)", async () => {
    const t = buildWithAutoApprove(true);
    const tool = t.factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [
        { step: "Bump eslint", status: "pending" },
        { step: "Bump prettier", status: "pending" },
      ],
    });
    expect((result.details as { status: string }).status).toBe(
      "approval-requested",
    );
    const approvalId = (result.details as { approvalId: string }).approvalId;
    // Void-fired trigger: drain a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(t.triggerCalls).toHaveLength(1);
    expect(t.triggerCalls[0]?.sessionKey).toBe(SESSION_KEY);
    expect(t.triggerCalls[0]?.approvalId).toBe(approvalId);
    expect(t.triggerCalls[0]?.planSteps).toEqual([
      { step: "Bump eslint", status: "pending" },
      { step: "Bump prettier", status: "pending" },
    ]);
    expect(
      t.info.some((m) => /auto-approve fired/i.test(m)),
    ).toBe(true);
  });

  it("fires on the reused path (duplicate detection) when autoApprove is on", async () => {
    const t = buildWithAutoApprove(true);
    const tool = t.factory({ sessionKey: SESSION_KEY });
    const input = {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    };
    const first = await tool.execute("c1", input);
    const firstId = (first.details as { approvalId: string }).approvalId;
    await new Promise((r) => setTimeout(r, 10));
    // First call fired the trigger. But to test the reused branch we
    // need to roll the state back to "pending" (the test trigger
    // doesn't change state, so it's still pending — perfect for
    // simulating an unresolved duplicate submit).
    expect(t.gw.peek(SESSION_KEY)?.approval).toBe("pending");
    expect(t.gw.peek(SESSION_KEY)?.approvalId).toBe(firstId);

    const second = await tool.execute("c2", input);
    expect((second.details as { status: string }).status).toBe(
      "duplicate-detected",
    );
    expect((second.details as { approvalId: string }).approvalId).toBe(firstId);
    await new Promise((r) => setTimeout(r, 10));
    // BOTH calls fired the trigger (matching in-host's unconditional
    // void-fire after the approval emit).
    expect(t.triggerCalls).toHaveLength(2);
    expect(t.triggerCalls[1]?.approvalId).toBe(firstId);
  });

  it("does NOT fire when autoApprove is flipped OFF between persist and trigger", async () => {
    // Simulate the operator hitting `/plan auto off` in the brief
    // window between exit_plan_mode's persist and the auto-approve
    // trigger. The helper's re-read guard must honor the toggle.
    const t = buildWithAutoApprove(true);
    const tool = t.factory({ sessionKey: SESSION_KEY });
    // Wrap the original trigger so we can toggle off BEFORE it runs.
    // The cleanest seam: monkey-patch readSnapshot to return
    // autoApprove=false on the trigger's re-read. The trigger reads
    // the store AFTER persist; we intercept that read.
    const originalReadSnapshot = t.store.readSnapshot.bind(t.store);
    let readCount = 0;
    (t.store as { readSnapshot: typeof t.store.readSnapshot }).readSnapshot =
      async (sessionKey: string) => {
        readCount++;
        const snap = await originalReadSnapshot(sessionKey);
        if (!snap) return snap;
        // First read happens in the trigger helper — pretend
        // autoApprove flipped off in the meantime.
        return { ...snap, autoApprove: false };
      };
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe(
      "approval-requested",
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(t.triggerCalls).toEqual([]);
    expect(readCount).toBeGreaterThan(0);
    // The bail-out should be info-level (operator action, not error).
    expect(
      t.info.some((m) => /auto-approve skipped/i.test(m)),
    ).toBe(true);
  });

  it("does NOT fire when the approvalId has rotated between persist and trigger", async () => {
    // Simulate a fast-follow exit_plan_mode that rotated the
    // approvalId before the trigger re-reads. The mismatch guard
    // should bail.
    const t = buildWithAutoApprove(true);
    const tool = t.factory({ sessionKey: SESSION_KEY });
    const originalReadSnapshot = t.store.readSnapshot.bind(t.store);
    (t.store as { readSnapshot: typeof t.store.readSnapshot }).readSnapshot =
      async (sessionKey: string) => {
        const snap = await originalReadSnapshot(sessionKey);
        if (!snap) return snap;
        // Pretend a new exit_plan_mode landed with a different approvalId.
        return { ...snap, approvalId: "plan-other-rotated-id" };
      };
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe(
      "approval-requested",
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(t.triggerCalls).toEqual([]);
    // Mismatch is logged at warn (it's a race we didn't expect, not
    // a user-intended toggle).
    expect(
      t.warn.some((m) => /auto-approve aborted/i.test(m)),
    ).toBe(true);
  });

  it("trigger callback failures DO NOT propagate out of execute (fail-soft)", async () => {
    const t = buildWithAutoApprove(true);
    // Queue a synthetic trigger failure.
    t.triggerErrors.push(new Error("simulated recordApproval failure"));
    const tool = t.factory({ sessionKey: SESSION_KEY });
    // execute must still return a successful result; the trigger is
    // void-fired and errors caught.
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe(
      "approval-requested",
    );
    await new Promise((r) => setTimeout(r, 10));
    // The trigger captured the call before throwing.
    expect(t.triggerCalls).toHaveLength(1);
    // Error logged at error level (not just warn) so operators
    // notice the silent degradation to manual mode.
    expect(t.error.length).toBeGreaterThan(0);
    expect(
      t.error.some((m) => /auto-approve FAILED/i.test(m)),
    ).toBe(true);
    expect(
      t.error.some((m) => /simulated recordApproval failure/.test(m)),
    ).toBe(true);
  });

  it("does NOT fire when the persist itself failed (kind === 'failed')", async () => {
    // Build a broken gateway so persistApprovalRequest returns
    // kind:"failed". The trigger gate excludes failed (and skipped)
    // so no trigger should run.
    const triggerCalls: unknown[] = [];
    const brokenGw = {
      async withLock<T>(): Promise<{ transition?: T }> {
        throw new Error("simulated IO failure");
      },
    };
    const store = new PlanModeStore(brokenGw as never);
    const factory = createExitPlanModeTool({
      store,
      autoApprove: {
        trigger: async () => {
          triggerCalls.push("should-not-fire");
        },
      },
    });
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe("failed");
    await new Promise((r) => setTimeout(r, 10));
    expect(triggerCalls).toEqual([]);
  });

  it("does NOT fire when the persist was skipped (kind === 'skipped' / not in plan mode)", async () => {
    // Unseeded gateway: persistApprovalRequest returns kind:"skipped".
    const gw = new InMemoryGateway();
    const store = new PlanModeStore(gw);
    const triggerCalls: unknown[] = [];
    const factory = createExitPlanModeTool({
      store,
      autoApprove: {
        trigger: async () => {
          triggerCalls.push("should-not-fire");
        },
      },
    });
    const tool = factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    expect((result.details as { status: string }).status).toBe(
      "not-in-plan-mode",
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(triggerCalls).toEqual([]);
  });

  it("preserves the audit-trail approvalId — the trigger receives the SAME id emitted in the result", async () => {
    const t = buildWithAutoApprove(true);
    const tool = t.factory({ sessionKey: SESSION_KEY });
    const result = await tool.execute("c1", {
      title: TITLE,
      plan: [{ step: "a", status: "pending" }],
    });
    const emittedApprovalId = (result.details as { approvalId: string })
      .approvalId;
    await new Promise((r) => setTimeout(r, 10));
    expect(t.triggerCalls[0]?.approvalId).toBe(emittedApprovalId);
    // Also matches the persisted state's approvalId.
    expect(t.gw.peek(SESSION_KEY)?.approvalId).toBe(emittedApprovalId);
  });
});
