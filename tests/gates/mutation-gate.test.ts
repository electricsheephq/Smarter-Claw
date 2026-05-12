/**
 * P-5 mutation gate tests.
 *
 * Ported from in-host
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/plan-mode/mutation-gate.test.ts`
 * (commit `ea04ea52c7`). Per the plan's parity contract, every test
 * case here mirrors an in-host assertion. Divergence in test
 * shape is acceptable; divergence in assertion semantics is not.
 *
 * Coverage:
 *  - Normal mode (everything passes)
 *  - Plan mode — blocked tools (exact blocklist)
 *  - Plan mode — allowed tools (explicit allowlist)
 *  - Plan mode — suffix patterns (.write/.edit/.delete blocked;
 *    .read/.search/.list/.get/.view allowed)
 *  - Plan mode — exec read-only whitelist (ls/cat/git diff/etc.)
 *  - Plan mode — bash tool blocked without command
 *  - Plan mode — shell compound operators blocked
 *  - Plan mode — newlines in commands blocked
 *  - Plan mode — dangerous flags blocked
 *  - Plan mode — dangerous flag substring false positives (e.g. `-executable`)
 */

import { describe, expect, it } from "vitest";
import { checkMutationGate, _testing } from "../../src/gates/mutation-gate.js";

describe("checkMutationGate — normal mode", () => {
  it("allows every tool when mode is normal", () => {
    const tools = [
      "edit",
      "write",
      "bash",
      "apply_patch",
      "anything_else",
      "read",
      "web_search",
    ];
    for (const tool of tools) {
      expect(checkMutationGate(tool, "normal").blocked).toBe(false);
    }
  });

  it("allows even when execCommand is non-readonly (gate doesn't fire in normal mode)", () => {
    expect(checkMutationGate("bash", "normal", "rm -rf /").blocked).toBe(false);
  });
});

describe("checkMutationGate — plan mode blocked tools (exact blocklist)", () => {
  // host_ref: in-host blocks every tool in MUTATION_TOOL_BLOCKLIST in plan mode.
  for (const tool of _testing.MUTATION_TOOL_BLOCKLIST) {
    it(`blocks "${tool}" in plan mode`, () => {
      // For exec/bash, we need to pass NO execCommand or a non-allowlisted
      // command. Pass undefined — falls through to the blocklist check.
      const r = checkMutationGate(tool, "plan");
      expect(r.blocked).toBe(true);
      expect(r.reason).toMatch(/blocked in plan mode/);
    });
  }
});

describe("checkMutationGate — plan mode allowed tools (explicit allowlist)", () => {
  for (const tool of _testing.PLAN_MODE_ALLOWED_TOOLS) {
    it(`allows "${tool}" in plan mode`, () => {
      const r = checkMutationGate(tool, "plan");
      expect(r.blocked).toBe(false);
    });
  }

  it("allow check is case-insensitive (uppercase input still allowed)", () => {
    expect(checkMutationGate("READ", "plan").blocked).toBe(false);
    expect(checkMutationGate("Update_Plan", "plan").blocked).toBe(false);
  });
});

describe("checkMutationGate — plan mode suffix patterns", () => {
  it("blocks mutation suffix .write", () => {
    expect(checkMutationGate("repo.write", "plan").blocked).toBe(true);
    expect(checkMutationGate("vault.write", "plan").blocked).toBe(true);
  });

  it("blocks mutation suffix .edit", () => {
    expect(checkMutationGate("docs.edit", "plan").blocked).toBe(true);
  });

  it("blocks mutation suffix .delete", () => {
    expect(checkMutationGate("collection.delete", "plan").blocked).toBe(true);
  });

  it("allows read-only suffix .read", () => {
    expect(checkMutationGate("repo.read", "plan").blocked).toBe(false);
    expect(checkMutationGate("vault.read", "plan").blocked).toBe(false);
  });

  it("allows read-only suffix .search", () => {
    expect(checkMutationGate("data.search", "plan").blocked).toBe(false);
  });

  it("allows read-only suffix .list / .get / .view", () => {
    expect(checkMutationGate("things.list", "plan").blocked).toBe(false);
    expect(checkMutationGate("entry.get", "plan").blocked).toBe(false);
    expect(checkMutationGate("page.view", "plan").blocked).toBe(false);
  });

  it("suffix check is case-insensitive", () => {
    expect(checkMutationGate("REPO.WRITE", "plan").blocked).toBe(true);
    expect(checkMutationGate("REPO.READ", "plan").blocked).toBe(false);
  });
});

describe("checkMutationGate — plan mode exec read-only whitelist", () => {
  for (const prefix of _testing.READ_ONLY_EXEC_PREFIXES) {
    it(`allows exec "${prefix}" (exact match)`, () => {
      const r = checkMutationGate("exec", "plan", prefix);
      expect(r.blocked).toBe(false);
    });

    it(`allows exec "${prefix} ..." (prefix match)`, () => {
      const r = checkMutationGate("exec", "plan", `${prefix} something here`);
      expect(r.blocked).toBe(false);
    });
  }

  it("allows bash with read-only prefix", () => {
    expect(checkMutationGate("bash", "plan", "ls -la").blocked).toBe(false);
    expect(checkMutationGate("bash", "plan", "git status").blocked).toBe(false);
  });

  it("blocks non-allowlisted exec command", () => {
    expect(checkMutationGate("exec", "plan", "rm file").blocked).toBe(true);
    expect(checkMutationGate("exec", "plan", "mkdir foo").blocked).toBe(true);
  });
});

describe("checkMutationGate — plan mode bash without command", () => {
  it("blocks bash with no execCommand (falls through to blocklist)", () => {
    expect(checkMutationGate("bash", "plan").blocked).toBe(true);
  });
});

describe("checkMutationGate — plan mode shell compound operators blocked", () => {
  it("blocks semicolons", () => {
    const r = checkMutationGate("exec", "plan", "ls; rm file");
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/shell operators|newlines/i);
  });

  it("blocks pipes", () => {
    expect(checkMutationGate("exec", "plan", "ls | grep foo").blocked).toBe(true);
  });

  it("blocks backgrounding (&)", () => {
    expect(checkMutationGate("exec", "plan", "ls & echo done").blocked).toBe(true);
  });

  it("blocks command substitution backticks", () => {
    expect(checkMutationGate("exec", "plan", "ls `echo foo`").blocked).toBe(true);
  });

  it("blocks command substitution $()", () => {
    expect(checkMutationGate("exec", "plan", "ls $(echo foo)").blocked).toBe(true);
  });

  it("blocks redirects > and >>", () => {
    expect(checkMutationGate("exec", "plan", "ls > out.txt").blocked).toBe(true);
    expect(checkMutationGate("exec", "plan", "ls >> out.txt").blocked).toBe(true);
  });

  it("blocks process substitution <(...) and >(...)", () => {
    expect(checkMutationGate("exec", "plan", "ls <(echo foo)").blocked).toBe(true);
    expect(checkMutationGate("exec", "plan", "ls >(echo foo)").blocked).toBe(true);
  });
});

describe("checkMutationGate — plan mode newlines in commands blocked", () => {
  it("blocks LF in commands", () => {
    expect(checkMutationGate("exec", "plan", "ls\nrm file").blocked).toBe(true);
  });

  it("blocks CR in commands", () => {
    expect(checkMutationGate("exec", "plan", "ls\rrm file").blocked).toBe(true);
  });
});

describe("checkMutationGate — plan mode dangerous flags blocked", () => {
  for (const flag of _testing.DANGEROUS_FLAGS) {
    it(`blocks find with "${flag}" flag`, () => {
      const r = checkMutationGate("exec", "plan", `find . ${flag} bogus`);
      expect(r.blocked).toBe(true);
      expect(r.reason).toMatch(/dangerous flag/i);
    });
  }

  it("blocks find with -delete (canonical case)", () => {
    expect(
      checkMutationGate("exec", "plan", "find . -name '*.tmp' -delete").blocked,
    ).toBe(true);
  });

  it("blocks find with -fprint write side-effect", () => {
    expect(
      checkMutationGate("exec", "plan", "find . -fprint /tmp/out.txt").blocked,
    ).toBe(true);
  });

  it("blocks rm-style -rf flag on otherwise-allowed prefix", () => {
    expect(checkMutationGate("exec", "plan", "ls -rf /tmp").blocked).toBe(true);
  });
});

describe("checkMutationGate — dangerous flag substring false positives", () => {
  it("does NOT match `-exec` inside `-executable`", () => {
    // -executable is a benign find flag for "files with execute permission"
    expect(
      checkMutationGate("exec", "plan", "find . -executable").blocked,
    ).toBe(false);
  });

  it("does NOT match `-delete` inside `-deleteflag-not-real`", () => {
    // Made-up flag; the word-boundary regex shouldn't false-match.
    expect(
      checkMutationGate("exec", "plan", "find . -deletefoo").blocked,
    ).toBe(false);
  });

  it("does NOT match the bare word 'exec' inside the command body", () => {
    // The dangerous-flag check is for FLAGS only; command text is fine.
    // The non-dangerous-flag path: `find . -name exec` should NOT be
    // blocked by the dangerous-flag list.
    // BUT — `find . -name exec` IS allowed by read-only prefix (`find`),
    // doesn't trigger compound operators or dangerous flags.
    expect(
      checkMutationGate("exec", "plan", "find . -name exec").blocked,
    ).toBe(false);
  });
});

describe("checkMutationGate — default deny", () => {
  it("blocks unknown tools by default", () => {
    const r = checkMutationGate("brand_new_mutator", "plan");
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/not in the plan-mode allowlist/i);
  });

  it("blocks plugin tools that aren't in allowlist or suffix patterns", () => {
    expect(checkMutationGate("some_plugin_tool", "plan").blocked).toBe(true);
  });
});

describe("checkMutationGate — reason text contents", () => {
  it("blocklist reason mentions exit_plan_mode", () => {
    const r = checkMutationGate("write", "plan");
    expect(r.reason).toMatch(/exit_plan_mode/);
  });

  it("default-deny reason mentions exit_plan_mode", () => {
    const r = checkMutationGate("unknown_tool", "plan");
    expect(r.reason).toMatch(/exit_plan_mode/);
  });
});
