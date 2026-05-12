/**
 * Plan-mode mutation gate.
 *
 * **Parity contract**: byte-identical algorithm port of the in-host
 * `checkMutationGate` at
 * `/Users/lume/repos/openclaw-pr70071-rebase/src/agents/plan-mode/mutation-gate.ts`
 * (commit `ea04ea52c7`). The allowlist + blocklist + suffix patterns +
 * exec-prefix list + dangerous-flag list are ALL part of the security
 * contract — diverging from in-host risks either over-blocking (UX
 * regression) or under-blocking (security regression).
 *
 * # When plan mode is active
 *
 * Blocks mutating tools (Edit / Write / Bash / exec / etc.) so the
 * agent can only read, search, and plan. The agent must call
 * `exit_plan_mode` to get user approval before mutations re-open.
 *
 * # Allowed during plan mode
 *
 * - Explicit allowlist: read, web_search, web_fetch, memory_search,
 *   memory_get, update_plan, exit_plan_mode, session_status,
 *   ask_user_question, enter_plan_mode, sessions_spawn,
 *   plan_mode_status, sessions_list, sessions_history,
 *   sessions_yield, lcm_grep, lcm_expand_query
 * - Read-only suffix patterns: .read, .search, .list, .get, .view
 *   (lets MCP read tools through without per-tool allowlist entries)
 * - exec/bash with a read-only command prefix (ls, cat, pwd,
 *   git status, etc.) AS LONG AS the command doesn't contain shell
 *   operators or dangerous flags
 *
 * # Default deny
 *
 * Unknown tools are blocked in plan mode. This prevents newly-added
 * tools or third-party plugins from bypassing the gate without an
 * explicit allowlist entry.
 *
 * # Security notes
 *
 * - `find -fprint`/`-fls`/etc. flags write files even though `find`
 *   is in the read-only prefix list. Caught by DANGEROUS_FLAGS.
 * - Shell compound operators (`;`, `|`, `&`, backtick, `$(...)`,
 *   `>(...)`, `<(...)`, redirects, newlines) block exec/bash.
 * - DANGEROUS_FLAGS uses word-boundary regex so `-exec` doesn't
 *   false-match on `-executable`.
 */

import type { PlanMode } from "../types.js";

/**
 * Tools blocked during plan mode unless handled by a special case.
 * Includes plugin-flavored "exec" + standard mutators.
 *
 * host_ref: src/agents/plan-mode/mutation-gate.ts:27-43
 */
const MUTATION_TOOL_BLOCKLIST = new Set([
  "apply_patch",
  "bash",
  "edit",
  "exec",
  "gateway",
  "message",
  "nodes",
  "process",
  "sessions_send",
  // `sessions_spawn` deliberately NOT here — per PR-10 review #3105169112,
  // subagent spawn is a research operation. See ALLOWED below.
  "subagents",
  "write",
]);

/**
 * Suffix patterns that ALSO indicate mutation tools (catches MCP tools
 * named e.g. `repo.write`, `vault.edit`).
 *
 * host_ref: src/agents/plan-mode/mutation-gate.ts:45-46
 */
const MUTATION_SUFFIX_PATTERNS = [".write", ".edit", ".delete"];

/**
 * Suffix patterns that indicate read-only tools (bypass fail-closed
 * default).
 *
 * host_ref: src/agents/plan-mode/mutation-gate.ts:48-49
 */
const READONLY_SUFFIX_PATTERNS = [".read", ".search", ".list", ".get", ".view"];

/**
 * Tools explicitly allowed during plan mode. Order matters for grep'ability
 * but not semantics.
 *
 * host_ref: src/agents/plan-mode/mutation-gate.ts:51-101
 */
const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "read",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_get",
  "update_plan",
  "exit_plan_mode",
  "session_status",
  "ask_user_question",
  "enter_plan_mode",
  "sessions_spawn",
  "plan_mode_status",
  "sessions_list",
  "sessions_history",
  "sessions_yield",
  "lcm_grep",
  "lcm_expand_query",
]);

/**
 * Read-only exec/bash command prefixes allowed during plan mode.
 *
 * host_ref: src/agents/plan-mode/mutation-gate.ts:103-128
 */
const READ_ONLY_EXEC_PREFIXES = [
  "ls",
  "cat",
  "pwd",
  "git status",
  "git log",
  "git diff",
  "git show",
  "which",
  "find",
  "grep",
  "rg",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "echo",
  "printenv",
  "whoami",
  "hostname",
  "uname",
];

/**
 * Dangerous flags that block exec/bash even when the command prefix
 * is in READ_ONLY_EXEC_PREFIXES.
 *
 * host_ref: src/agents/plan-mode/mutation-gate.ts:213-225
 */
const DANGEROUS_FLAGS = [
  "-delete",
  "-exec",
  "-execdir",
  "--delete",
  "-rf",
  "--output",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
];

export interface MutationGateResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Check whether a tool call should be blocked during plan mode.
 *
 * @param toolName — tool name being called (case-insensitive).
 * @param currentMode — current plan-mode state.
 * @param execCommand — for `exec`/`bash`, the command string to check
 *   against the read-only prefix allowlist + dangerous-flag list.
 *
 * host_ref: src/agents/plan-mode/mutation-gate.ts:140-262
 */
export function checkMutationGate(
  toolName: string,
  currentMode: PlanMode,
  execCommand?: string,
): MutationGateResult {
  // Normal mode: nothing blocked.
  if (currentMode !== "plan") {
    return { blocked: false };
  }

  const normalized = toolName.trim().toLowerCase();

  // Explicit allowlist always passes.
  if (PLAN_MODE_ALLOWED_TOOLS.has(normalized)) {
    return { blocked: false };
  }

  // Special case: exec/bash with a read-only command prefix is allowed,
  // BUT shell operators + dangerous flags reject first.
  if ((normalized === "exec" || normalized === "bash") && execCommand) {
    const cmd = execCommand.trim().toLowerCase();
    // Block shell compound operators, newlines, process substitution.
    if (/[;|&`\n\r]|\$\(|>>?|<\(|>\(/.test(cmd)) {
      return {
        blocked: true,
        reason:
          `Tool "${toolName}" command contains shell operators or newlines and is blocked in plan mode. ` +
          "Only simple read-only commands are allowed.",
      };
    }
    // Block dangerous flags (word-boundary regex; tabs count as
    // whitespace).
    const hasFlag = DANGEROUS_FLAGS.some((f) => {
      const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[\\s])${escaped}(?:[\\s=]|$)`, "i").test(cmd);
    });
    if (hasFlag) {
      return {
        blocked: true,
        reason: `Tool "${toolName}" command contains a dangerous flag and is blocked in plan mode.`,
      };
    }
    const isReadOnly = READ_ONLY_EXEC_PREFIXES.some(
      (prefix) => cmd === prefix || cmd.startsWith(prefix + " "),
    );
    if (isReadOnly) {
      return { blocked: false };
    }
  }

  // Check exact blocklist.
  if (MUTATION_TOOL_BLOCKLIST.has(normalized)) {
    return {
      blocked: true,
      reason:
        `Tool "${toolName}" is blocked in plan mode. ` +
        "Mutation tools stay blocked until the current plan is confirmed. " +
        "Call exit_plan_mode after user confirmation, or revise the plan with update_plan.",
    };
  }

  // Mutation suffix patterns.
  for (const suffix of MUTATION_SUFFIX_PATTERNS) {
    if (normalized.endsWith(suffix)) {
      return {
        blocked: true,
        reason:
          `Tool "${toolName}" matches mutation suffix pattern "${suffix}" and is blocked in plan mode. ` +
          "Call exit_plan_mode to proceed.",
      };
    }
  }

  // Read-only suffix patterns — allow MCP read tools like custom.read,
  // data.search.
  for (const suffix of READONLY_SUFFIX_PATTERNS) {
    if (normalized.endsWith(suffix)) {
      return { blocked: false };
    }
  }

  // Default deny: unknown tools are blocked in plan mode to prevent
  // newly-added tools from bypassing the gate.
  return {
    blocked: true,
    reason:
      `Tool "${toolName}" is not in the plan-mode allowlist and is blocked by default. ` +
      "Call exit_plan_mode to proceed.",
  };
}

/**
 * For tests + parity-harness: expose the allowlists/blocklists as
 * read-only views so test assertions can introspect what's permitted
 * without re-implementing the gate logic.
 */
export const _testing = {
  MUTATION_TOOL_BLOCKLIST: Array.from(MUTATION_TOOL_BLOCKLIST),
  MUTATION_SUFFIX_PATTERNS,
  READONLY_SUFFIX_PATTERNS,
  PLAN_MODE_ALLOWED_TOOLS: Array.from(PLAN_MODE_ALLOWED_TOOLS),
  READ_ONLY_EXEC_PREFIXES,
  DANGEROUS_FLAGS,
};
