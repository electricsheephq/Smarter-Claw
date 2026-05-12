import { Type } from "@sinclair/typebox";

type StringEnumOptions<T extends readonly string[]> = {
  description?: string;
  title?: string;
  default?: T[number];
};

/**
 * Flat string-enum schema. Avoid `Type.Union([Type.Literal(...)])`
 * which compiles to `anyOf` — some providers reject `anyOf` in tool
 * schemas. A flat `{ type: "string", enum: [...] }` is safer.
 */
export function stringEnum<T extends readonly string[]>(
  values: T,
  options: StringEnumOptions<T> = {},
) {
  const enumValues = Array.isArray(values)
    ? values
    : values && typeof values === "object"
      ? Object.values(values).filter((value): value is T[number] => typeof value === "string")
      : [];
  return Type.Unsafe<T[number]>({
    type: "string",
    ...(enumValues.length > 0 ? { enum: [...enumValues] } : {}),
    ...options,
  });
}

/** Canonical step-status enum used by `update_plan` and `exit_plan_mode`. */
export const PLAN_STEP_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];
