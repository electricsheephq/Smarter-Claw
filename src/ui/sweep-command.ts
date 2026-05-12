/**
 * Plan-Mode CLI sweep command — `openclaw plan-clear --session <sessionKey>`.
 *
 * # Why
 *
 * Operator rollback drain. If a session is stuck in plan mode (e.g.
 * after a plugin disable + re-enable, or a bug that left state
 * inconsistent), the operator can clear plan-mode state without
 * touching the rest of the session. The session continues in normal
 * mode after the sweep.
 *
 * # Single-session for now
 *
 * The SDK doesn't currently expose a "list all sessions" seam for
 * plugin-owned CLI commands. Mass sweep (`--all-sessions`) requires an
 * upstream SDK seam — tracked as a future S-N PR. For P-12 we ship
 * the targeted single-session sweep, which is the common rollback case
 * (operator sees a stuck session in the sidebar and clears it).
 *
 * # In-host parity
 *
 * The in-host equivalent is `openclaw session sweep --plan-mode-clear`
 * (referenced in P-12's spec in glistening-swimming-rivest.md). The
 * plugin port renames to `openclaw plan-clear` since we register under
 * the root CLI namespace (not nested under `session`), avoiding name
 * collision with host-owned subcommands.
 *
 * # Type discipline
 *
 * The SDK's `OpenClawPluginCliRegistrar` type is not re-exported from
 * `openclaw/plugin-sdk/plugin-entry`. To stay decoupled from the SDK's
 * internal module layout we describe the registrar shape locally
 * (matches the SDK's exported type structurally). If a future SDK
 * version re-exports the type at the public path we can collapse to
 * a single import.
 *
 * host_ref: in-host operator command in `src/cli/session.ts` (the
 *   `--plan-mode-clear` flag). Plugin port consolidates into a
 *   focused `plan-clear` command.
 */

import type { PlanModeStore } from "../state/store.js";

/**
 * Minimal structural shape of `OpenClawPluginCliContext`. We use just
 * what the sweep command needs (`program` + `logger`). The actual SDK
 * type carries more fields; this typing is intentionally narrow so
 * future SDK additions don't churn this file.
 */
interface MinimalCliContext {
  program: {
    command: (name: string) => {
      description: (text: string) => unknown;
    };
  };
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/**
 * Minimal commander shape used by chain calls below. We declare it
 * locally so we don't have to import commander as a dev-dep.
 */
interface MinimalCommand {
  description: (text: string) => MinimalCommand;
  requiredOption: (
    flags: string,
    description?: string,
    defaultValue?: unknown,
  ) => MinimalCommand;
  option: (
    flags: string,
    description?: string,
    defaultValue?: unknown,
  ) => MinimalCommand;
  action: (
    fn: (opts: Record<string, unknown>) => void | Promise<void>,
  ) => MinimalCommand;
}

export interface SweepCommandDeps {
  store: PlanModeStore;
}

/**
 * Build the CLI registrar function. Returns a function compatible with
 * `api.registerCli(...)`. Called from plugin index.ts at register-time:
 *
 * ```
 *   api.registerCli(createPlanClearCli({ store }));
 * ```
 *
 * @param deps.store — PlanModeStore for the actual exit transition.
 */
export function createPlanClearCli(
  deps: SweepCommandDeps,
): (ctx: MinimalCliContext) => void {
  return (ctx) => {
    const cmd = ctx.program.command("plan-clear") as unknown as MinimalCommand;
    cmd
      .description(
        "Clear plan-mode state for a session (operator rollback drain). " +
          "Use when a session is stuck in plan mode after a plugin disable, " +
          "config change, or rollback. The session continues in normal mode " +
          "after the sweep.",
      )
      .requiredOption(
        "-s, --session <sessionKey>",
        "Session key to clear (e.g. `agent:main:main`)",
      )
      .option(
        "--dry-run",
        "Report what would change without writing",
        false,
      )
      .action(async (opts) => {
        const sessionKey = String((opts as { session?: unknown }).session ?? "").trim();
        if (!sessionKey) {
          ctx.logger.error("--session is required and must be non-empty");
          return;
        }
        const snap = await deps.store.readSnapshot(sessionKey);
        if (!snap) {
          ctx.logger.info(
            `[smarter-claw plan-clear] no plan-mode payload for sessionKey=${sessionKey}; nothing to do`,
          );
          return;
        }
        if (snap.mode === "normal") {
          ctx.logger.info(
            `[smarter-claw plan-clear] sessionKey=${sessionKey} already in normal mode (approval=${snap.approval}); nothing to do`,
          );
          return;
        }
        ctx.logger.info(
          `[smarter-claw plan-clear] sessionKey=${sessionKey} currentMode=${snap.mode} currentApproval=${snap.approval}` +
            (snap.title ? ` title="${snap.title}"` : "") +
            (snap.rejectionCount > 0
              ? ` rejectionCount=${snap.rejectionCount}`
              : ""),
        );
        const dryRun = Boolean((opts as { dryRun?: unknown }).dryRun);
        if (dryRun) {
          ctx.logger.info(
            "[smarter-claw plan-clear] --dry-run: would call exitPlanMode (no write performed)",
          );
          return;
        }
        const result = await deps.store.exitPlanMode({ sessionKey });
        if (result.kind === "failed") {
          ctx.logger.error(
            `[smarter-claw plan-clear] exitPlanMode failed: ${result.error.message}`,
          );
          return;
        }
        ctx.logger.info(
          `[smarter-claw plan-clear] sessionKey=${sessionKey} exitPlanMode kind=${result.kind}`,
        );
      });
  };
}
