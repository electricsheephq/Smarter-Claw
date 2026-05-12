/**
 * Smarter Claw — tool input parsing helpers.
 *
 * Minimal port of the input-validation helpers from openclaw-1's
 * `src/agents/tools/common.ts`. Plan-mode tools have simple flat
 * argument shapes (string question, string[] options, optional bool),
 * so we only need a small subset of the original helper surface.
 *
 * If we ever need the full helper set (snake_case / camelCase param
 * key resolution, number parsing, etc.) we can pull more from the
 * upstream module — for now keep it tight.
 */

/**
 * Thrown when a tool's input parameters are missing or malformed. The
 * agent's tool-execution wrapper catches this and surfaces the message
 * back to the model as a tool error so the agent can correct and retry.
 */
export class ToolInputError extends Error {
  readonly status: number = 400;

  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export interface StringParamOptions {
  required?: boolean;
  trim?: boolean;
  label?: string;
  allowEmpty?: boolean;
}

/**
 * Read and validate a string parameter from a tool's input args. Reads
 * the snake_case key directly (Smarter Claw tools all declare snake_case
 * schemas, so no camelCase fallback needed).
 *
 * Overloads ensure that callers passing `{required: true}` get a
 * non-undefined string back at the type level.
 */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions & { required: true },
): string;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: StringParamOptions,
): string | undefined;
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions = {},
): string | undefined {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;
  const raw = params[key];
  if (typeof raw !== "string") {
    if (required) {
      throw new ToolInputError(`${label} required`);
    }
    return undefined;
  }
  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) {
      throw new ToolInputError(`${label} required`);
    }
    return undefined;
  }
  return value;
}
