/**
 * Tests for plan-archetype markdown persister (W1-F2 fix).
 *
 * Pins parity with the in-host
 * `src/agents/plan-mode/plan-archetype-persist.test.ts` at commit
 * `ea04ea52c7`. Where the in-host test relies on host-only modules,
 * we adapt; the persister algorithm itself is byte-faithful so the
 * assertions remain meaningful.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistPlanArchetypeMarkdown,
  PlanPersistStorageError,
} from "../../src/plan-mode/plan-archetype-persist.js";

describe("persistPlanArchetypeMarkdown (W1-F2 port)", () => {
  let tmpBase: string;
  const FIXED_DATE = new Date("2026-04-18T15:30:00Z");

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(
      path.join(os.tmpdir(), "smarter-claw-plan-persist-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it("writes the file under <baseDir>/<agentId>/plans/<filename>", async () => {
    const result = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Fix the websocket reconnect race",
      markdown: "# Fix the websocket reconnect race\n\n## Plan\n- [ ] step 1\n",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(result.filename).toBe(
      "plan-2026-04-18-fix-the-websocket-reconnect-race.md",
    );
    expect(result.absPath).toBe(
      path.join(tmpBase, "main", "plans", result.filename),
    );
    const content = await fs.readFile(result.absPath, "utf8");
    expect(content).toContain("# Fix the websocket reconnect race");
  });

  it("creates <baseDir>/<agentId>/plans/ recursively when missing", async () => {
    const result = await persistPlanArchetypeMarkdown({
      agentId: "fresh-agent",
      title: "First plan",
      markdown: "# First plan\n",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    const dir = path.dirname(result.absPath);
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("collision: second write same date+slug returns -2 suffix", async () => {
    const first = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Same title",
      markdown: "first",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    const second = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Same title",
      markdown: "second",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(first.filename).toBe("plan-2026-04-18-same-title.md");
    expect(second.filename).toBe("plan-2026-04-18-same-title-2.md");
    expect(await fs.readFile(first.absPath, "utf8")).toBe("first");
    expect(await fs.readFile(second.absPath, "utf8")).toBe("second");
  });

  it("collision: third write same date+slug returns -3 suffix", async () => {
    await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Repeat",
      markdown: "1",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Repeat",
      markdown: "2",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    const third = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "Repeat",
      markdown: "3",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(third.filename).toBe("plan-2026-04-18-repeat-3.md");
  });

  it("UTF-8 round-trip preserves multi-byte characters", async () => {
    const md = "# Café résumé piñata 🚀\n\n* Plan with émoji\n";
    const result = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: "UTF-8 test",
      markdown: md,
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(await fs.readFile(result.absPath, "utf8")).toBe(md);
  });

  it("rejects an empty agentId", async () => {
    await expect(
      persistPlanArchetypeMarkdown({
        agentId: "",
        title: "x",
        markdown: "",
        now: FIXED_DATE,
        baseDir: tmpBase,
      }),
    ).rejects.toThrow(/agentId required/);
  });

  it("rejects path-traversal characters in agentId", async () => {
    await expect(
      persistPlanArchetypeMarkdown({
        agentId: "../escape",
        title: "x",
        markdown: "",
        now: FIXED_DATE,
        baseDir: tmpBase,
      }),
    ).rejects.toThrow(/invalid agentId/);
  });

  it("rejects '.' agentId", async () => {
    await expect(
      persistPlanArchetypeMarkdown({
        agentId: ".",
        title: "x",
        markdown: "",
        now: FIXED_DATE,
        baseDir: tmpBase,
      }),
    ).rejects.toThrow(/invalid agentId \(path-traversal\)/);
  });

  it("rejects '..' agentId", async () => {
    await expect(
      persistPlanArchetypeMarkdown({
        agentId: "..",
        title: "x",
        markdown: "",
        now: FIXED_DATE,
        baseDir: tmpBase,
      }),
    ).rejects.toThrow(/invalid agentId \(path-traversal\)/);
  });

  it("undefined title falls back to plan-YYYY-MM-DD-untitled.md", async () => {
    const result = await persistPlanArchetypeMarkdown({
      agentId: "main",
      title: undefined,
      markdown: "# Untitled\n",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(result.filename).toBe("plan-2026-04-18-untitled.md");
  });

  it("accepts agentIds with safe special chars (dots, hyphens, underscores)", async () => {
    const result = await persistPlanArchetypeMarkdown({
      agentId: "kimi-coder.v2_test",
      title: "Plan",
      markdown: "x",
      now: FIXED_DATE,
      baseDir: tmpBase,
    });
    expect(result.absPath).toContain(
      path.join("kimi-coder.v2_test", "plans"),
    );
  });

  it("classifies EACCES as PlanPersistStorageError via _writeFileForTest hook", async () => {
    const eaccesErr: NodeJS.ErrnoException = Object.assign(
      new Error("EACCES: permission denied, open"),
      { code: "EACCES" } as const,
    );
    await expect(
      persistPlanArchetypeMarkdown({
        agentId: "main",
        title: "denied",
        markdown: "x",
        now: FIXED_DATE,
        baseDir: tmpBase,
        _writeFileForTest: async () => {
          throw eaccesErr;
        },
      }),
    ).rejects.toMatchObject({
      name: "PlanPersistStorageError",
      code: "EACCES",
    });
  });

  it("classifies ENOSPC as PlanPersistStorageError", async () => {
    const enospcErr: NodeJS.ErrnoException = Object.assign(
      new Error("ENOSPC: no space left on device, write"),
      { code: "ENOSPC" } as const,
    );
    try {
      await persistPlanArchetypeMarkdown({
        agentId: "main",
        title: "diskfull",
        markdown: "x",
        now: FIXED_DATE,
        baseDir: tmpBase,
        _writeFileForTest: async () => {
          throw enospcErr;
        },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanPersistStorageError);
      expect((err as PlanPersistStorageError).code).toBe("ENOSPC");
    }
  });

  it("non-storage error codes propagate as plain errors (not wrapped)", async () => {
    const otherErr: NodeJS.ErrnoException = Object.assign(
      new Error("EPERM: operation not permitted"),
      { code: "EPERM" } as const,
    );
    await expect(
      persistPlanArchetypeMarkdown({
        agentId: "main",
        title: "perm",
        markdown: "x",
        now: FIXED_DATE,
        baseDir: tmpBase,
        _writeFileForTest: async () => {
          throw otherErr;
        },
      }),
    ).rejects.toThrow(/EPERM/);
    // The propagated error is NOT wrapped as PlanPersistStorageError.
    await expect(
      persistPlanArchetypeMarkdown({
        agentId: "main",
        title: "perm",
        markdown: "x",
        now: FIXED_DATE,
        baseDir: tmpBase,
        _writeFileForTest: async () => {
          throw otherErr;
        },
      }),
    ).rejects.not.toBeInstanceOf(PlanPersistStorageError);
  });
});
