/**
 * Plan-mode mutation gate.
 *
 * When plan mode is active ("plan"), this module determines whether a
 * given mutation tool call should be blocked so the agent can only
 * read, search, and plan — not execute changes. The agent must call
 * `exit_plan_mode` to request user approval before mutation tools
 * become available.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ INSTALLER SEAM:                                                 │
 * │                                                                 │
 * │ This module is the LOGIC layer only. The gate fires at the      │
 * │ host's `before_tool_call` hook (which the plugin SDK does not   │
 * │ yet expose), so the installer wires up the activation point:    │
 * │                                                                 │
 * │   1. Patch core to call `shouldBlockMutation({ toolName,        │
 * │      session, execCommand })` immediately before dispatching    │
 * │      any agent tool call.                                       │
 * │   2. When `result.blocked === true`, the installer-side glue    │
 * │      synthesizes a tool-result with `result.reason` as the      │
 * │      visible body and returns that to the agent without ever    │
 * │      executing the underlying tool.                             │
 * │                                                                 │
 * │ Until that hook lands in the public Plugin SDK, the predicate   │
 * │ is exported here for the installer-side patch to consume.       │
 * └─────────────────────────────────────────────────────────────────┘
 */

import { isInPlanMode } from "../runtime-api.js";
import type { PlanMode } from "./types.js";

/**
 * Tools blocked during plan mode unless handled by a special case below
 * (e.g. exec has a read-only prefix allowlist).
 *
 * `sessions_spawn` is intentionally NOT on this list — subagent
 * spawning is a research operation during plan-mode investigation, not
 * a workspace mutation. The subagent's own runtime applies its own
 * plan-mode gate if/when needed.
 */
const MUTATION_TOOL_BLOCKLIST = new Set([
  // Core mutation tools (host runtime)
  "apply_patch",
  "apply_patch_via_tool",
  "bash",
  "edit",
  "exec",
  "gateway",
  "message",
  "nodes",
  "process",
  "sessions_send",
  "subagents",
  "write",
  // v2026.4.22 catalog: side-effecting tools that schedule work, write
  // media, spend API credits, or otherwise mutate state. Cross-checked
  // against openclaw-2/src/agents/tools/* tool registrations to avoid
  // drift; see issue #4 for the audit trail.
  "canvas",
  "cron",
  "image",
  "image_generate",
  "music_generate",
  "notify",
  "pdf",
  "tts",
  "video_generate",
  // Common shell aliases — not registered tools today, but defensively
  // blocked in case an MCP plugin registers one. Without these entries
  // the suffix/default-deny path could allow them through depending on
  // exact name shape (see issue #5).
  "csh",
  "fish",
  "nu",
  "nushell",
  "powershell",
  "pwsh",
  "sh",
  "tcsh",
  "zsh",
  "cmd",
]);

/** Suffix patterns that also indicate mutation tools. */
const MUTATION_SUFFIX_PATTERNS = [".write", ".edit", ".delete"];

/** Suffix patterns that indicate read-only tools (bypass fail-closed default). */
const READONLY_SUFFIX_PATTERNS = [".read", ".search", ".list", ".get", ".view"];

/** Tools explicitly allowed during plan mode (bypass blocklist check). */
const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "read",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_get",
  "update_plan",
  "exit_plan_mode",
  "session_status",
  // ask_user_question is a planning-time clarification tool that does
  // NOT exit plan mode and does NOT mutate workspace state. It must be
  // in the allowlist or the entire feature is broken under the default-
  // deny gate.
  "ask_user_question",
  // enter_plan_mode is also non-mutating (state transition only) and
  // should be allowed even when called redundantly mid-plan.
  "enter_plan_mode",
  // sessions_spawn allowed for research-subagent flows (see comment on
  // MUTATION_TOOL_BLOCKLIST above). Belt-and-suspenders allowlist entry
  // in addition to the blocklist removal.
  "sessions_spawn",
  // Read-only plan-mode introspection — must be allowed in plan mode
  // (the most important place to call it). The tool is purely read; no
  // state mutation. Without this entry, the default-deny gate blocks
  // the agent from self-diagnosing while in plan mode, defeating the
  // entire point of the introspection surface.
  "plan_mode_status",
  // Read-only sessions tools — useful during plan-mode investigation
  // and the agent shouldn't have to learn they're allowed.
  "sessions_list",
  "sessions_history",
]);

/**
 * Read-only exec commands allowed during plan mode.
 * If exec is called with a command starting with one of these prefixes,
 * the call is allowed. Otherwise exec is blocked.
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
 * Wrapper-prefix tokens we strip from a command before running the read-
 * only-prefix match. Without this, `sudo cat /etc/shadow`, `env cat ...`,
 * `nice cat ...` etc. would NOT match `cat` and would fall through to
 * the blocklist (which catches them today only because exec/bash is in
 * the blocklist) — but if the gate later allowlists more shells or the
 * caller passes the command via a different tool name, the wrapper
 * could smuggle through. Stripping wrappers up front is the
 * defense-in-depth fix recommended in issue #5.
 *
 * Each wrapper may take its own flags before the actual command. We
 * strip the wrapper token and any leading `-flag` / `--flag=value` /
 * `--flag value` tokens that follow, then recurse: `sudo -u root nice
 * -n 10 cat foo` → `cat foo`.
 *
 * `env` additionally accepts `KEY=VAL` tokens before the command — we
 * strip those too.
 */
const EXEC_WRAPPER_TOKENS = new Set([
  "sudo",
  "doas",
  "nohup",
  "time",
  "env",
  "nice",
  "ionice",
  "caffeinate",
  "stdbuf",
  "unbuffer",
  "chronic",
  "timeout",
]);

function stripExecWrappers(cmd: string): string {
  // Tokenize on whitespace. Cheap shell-lexer — sufficient because the
  // metacharacter regex above already rejected anything with quotes,
  // shell operators, command substitution, etc.
  let tokens = cmd.split(/\s+/).filter(Boolean);
  let changed = true;
  while (changed && tokens.length > 0) {
    changed = false;
    const head = tokens[0];
    if (!EXEC_WRAPPER_TOKENS.has(head)) break;
    tokens = tokens.slice(1);
    changed = true;
    // Strip wrapper-specific flag tokens before the command.
    while (tokens.length > 0) {
      const t = tokens[0];
      if (t.startsWith("-")) {
        // -n 10, --user=root, --, etc. Stop on `--` (POSIX end-of-options).
        if (t === "--") {
          tokens = tokens.slice(1);
          break;
        }
        tokens = tokens.slice(1);
        // Some flags take a value as the next token. Be conservative: if
        // the flag has no `=` and the next token doesn't start with `-`
        // and doesn't look like a known wrapper or command, consume it
        // as the flag's value. We keep this lenient — over-stripping a
        // value is safer than under-stripping and letting a wrapper
        // mask the actual command.
        if (!t.includes("=") && tokens.length > 0 && !tokens[0].startsWith("-")) {
          // But don't consume the token if it looks like the actual
          // command we're trying to find (a recognized read-only
          // prefix). Heuristic: stop consuming if the next token is a
          // bare command name with no slash and is in the read-only
          // prefix list.
          const next = tokens[0];
          const looksLikeCommand =
            !next.includes("=") &&
            (READ_ONLY_EXEC_PREFIXES.includes(next) ||
              READ_ONLY_EXEC_PREFIXES.some((p) => p.startsWith(next + " ")));
          if (!looksLikeCommand) {
            tokens = tokens.slice(1);
          }
        }
        continue;
      }
      // env-style KEY=VAL token (no leading dash, contains `=`).
      if (head === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        tokens = tokens.slice(1);
        continue;
      }
      break;
    }
  }
  return tokens.join(" ");
}

export interface MutationGateResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Checks whether a tool call should be blocked during plan mode given
 * an explicit `currentMode`. Used by the installer-side hook that
 * already has the resolved mode from the session entry.
 *
 * @param toolName - The tool name being called (case-insensitive)
 * @param currentMode - The current plan mode state
 * @param execCommand - If the tool is `exec`, the command string to check
 *                      against the read-only prefix whitelist
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

  // Explicitly allowed tools always pass.
  if (PLAN_MODE_ALLOWED_TOOLS.has(normalized)) {
    return { blocked: false };
  }

  // Special case: exec/bash with a read-only command prefix is allowed,
  // but reject commands containing shell compound operators first.
  if ((normalized === "exec" || normalized === "bash") && execCommand) {
    const cmd = execCommand.trim().toLowerCase();
    // Block shell compound operators, newlines, process substitution, and
    // other metacharacters that could chain or redirect commands.
    if (/[;|&`\n\r]|\$\(|>>?|<\(|>\(/.test(cmd)) {
      return {
        blocked: true,
        reason:
          `Tool "${toolName}" command contains shell operators or newlines and is blocked in plan mode. ` +
          "Only simple read-only commands are allowed.",
      };
    }
    // Block dangerous flags on otherwise-allowed commands.
    // Uses word-boundary regex to avoid false matches on substrings
    // (e.g., -executable should not match -exec). Tabs are treated as
    // whitespace separators alongside spaces.
    // `find` is in the read-only prefix allowlist but several `find`
    // flags actually write files: `-fprint <file>`, `-fprint0 <file>`,
    // `-fprintf <file> <fmt>`, `-fls <file>`. They're in the dangerous-
    // flag set so a command like `find . -fprint /tmp/out.txt` is
    // blocked in plan mode rather than silently mutating the
    // filesystem.
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
    // Strip wrapper prefixes (sudo, env, nohup, time, nice, ionice,
    // caffeinate, ...) before matching the read-only prefix list.
    // `sudo cat /etc/passwd` becomes `cat /etc/passwd` and now matches
    // the `cat` allowlist entry. WITHOUT this strip the command falls
    // through to the blocklist check; today exec/bash is in the
    // blocklist so it's blocked, but defense-in-depth: if a future tool
    // takes a shell command under a different name and reaches this
    // branch, the wrapper must not mask the actual command.
    //
    // We re-run the metacharacter and dangerous-flag checks against the
    // stripped command too, in case the wrapper was hiding a value
    // token that contains operators (e.g. `env FOO='a;b' cat foo` —
    // already rejected above by the `;` check on the raw cmd, but
    // belt-and-suspenders).
    const stripped = stripExecWrappers(cmd);
    if (stripped !== cmd) {
      if (/[;|&`\n\r]|\$\(|>>?|<\(|>\(/.test(stripped)) {
        return {
          blocked: true,
          reason:
            `Tool "${toolName}" command (after wrapper strip) contains shell operators and is blocked in plan mode.`,
        };
      }
      const stripHasFlag = DANGEROUS_FLAGS.some((f) => {
        const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?:^|[\\s])${escaped}(?:[\\s=]|$)`, "i").test(stripped);
      });
      if (stripHasFlag) {
        return {
          blocked: true,
          reason: `Tool "${toolName}" command (after wrapper strip) contains a dangerous flag and is blocked in plan mode.`,
        };
      }
    }
    const isReadOnly = READ_ONLY_EXEC_PREFIXES.some(
      (prefix) => stripped === prefix || stripped.startsWith(prefix + " "),
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

  // Check suffix patterns.
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

  // Check read-only suffix patterns — allow MCP read tools like custom.read, data.search.
  for (const suffix of READONLY_SUFFIX_PATTERNS) {
    if (normalized.endsWith(suffix)) {
      return { blocked: false };
    }
  }

  // Default deny: unknown tools are blocked in plan mode to prevent
  // newly added or plugin tools from bypassing the mutation gate.
  return {
    blocked: true,
    reason:
      `Tool "${toolName}" is not in the plan-mode allowlist and is blocked by default. ` +
      "Call exit_plan_mode to proceed.",
  };
}

/**
 * Convenience for the installer-side `before_tool_call` patch: takes a
 * SessionEntry-shaped object plus the in-flight tool call, reads the
 * plan-mode state via the runtime-api, and runs the gate against the
 * resolved mode.
 *
 * Pure: does not mutate the session or the tool call. Returns the
 * gate's decision; the caller is responsible for short-circuiting the
 * tool dispatch and surfacing `result.reason` to the agent.
 */
export interface ShouldBlockMutationContext {
  /** Tool name as the agent issued it. */
  toolName: string;
  /**
   * SessionEntry-shaped object the installer-side patch already loaded
   * for the in-flight turn. We accept `unknown` so the plugin doesn't
   * constrain on the host's exact SessionEntry type — the runtime-api
   * helpers handle the missing-field case for older OpenClaw versions.
   */
  session: unknown;
  /** If the tool is `exec` or `bash`, the command string. */
  execCommand?: string;
}

export function shouldBlockMutation(ctx: ShouldBlockMutationContext): MutationGateResult {
  // 3-state PlanMode awareness (PR #70071 P2.5 — recovered via tracking
  // issue #51): `isInPlanMode` returns boolean true ONLY when the
  // session's plugin-namespaced state has `planMode === "plan"`. Both
  // `"executing"` and `"normal"` collapse to false here, which is the
  // correct mutation-gate behavior:
  //   - mode "plan"      → planMode "plan" → gate ENFORCED (writes blocked)
  //   - mode "executing" → planMode "normal" → gate NOT enforced
  //                        (writes allowed; agent is acting on the
  //                        approved plan)
  //   - mode "normal"    → planMode "normal" → gate NOT enforced
  //                        (no plan activity at all)
  //
  // Equivalent in openclaw-1's pi-tools.before-tool-call.ts
  // (commit 077b425966 / P2.5) which special-cases mode === "executing"
  // to skip the plan-mode block but still report it via the diagnostic
  // log line. Smarter-Claw's plugin abstraction (the boolean collapse
  // above) achieves the same functional outcome with no special-casing
  // needed at the gate level. The `[smarter-claw/before_tool_call]`
  // diagnostic in index.ts only fires on actual blocks, not on
  // pass-through, so executing-mode tool calls don't generate noise.
  const planMode: PlanMode = isInPlanMode(ctx.session) ? "plan" : "normal";
  return checkMutationGate(ctx.toolName, planMode, ctx.execCommand);
}
