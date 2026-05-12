/**
 * Small shared utilities for plan-mode tools.
 *
 * host_ref: src/agents/tools/common.ts in the in-host tree.
 */

/**
 * Thrown when a tool input violates the schema in a recoverable way
 * (the agent will see the error message and can re-call). Distinct
 * from runtime errors which should propagate as throws.
 *
 * host_ref: src/agents/tools/common.ts:18-22 (in-host class)
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * Read a string parameter from an unknown-typed params object with
 * trimming + optional/required handling.
 *
 * host_ref: src/agents/tools/common.ts:42-67 (in-host readStringParam)
 */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; label?: string } = {},
): string | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) {
    if (opts.required) {
      throw new ToolInputError(
        `${opts.label ?? key} is required`,
      );
    }
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new ToolInputError(
      `${opts.label ?? key} must be a string (got ${typeof raw})`,
    );
  }
  const trimmed = raw.trim();
  if (opts.required && trimmed.length === 0) {
    throw new ToolInputError(
      `${opts.label ?? key} cannot be empty`,
    );
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Canonical PlanStep statuses. Mirrors in-host
 * src/agents/tools/update-plan-tool.ts:PLAN_STEP_STATUSES.
 *
 * Source of truth for which strings are valid in PlanStep.status.
 */
export const PLAN_STEP_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];
