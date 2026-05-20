/**
 * Common types for Layer-1 parity checks.
 *
 * A check pins ONE plugin surface against an in-host reference. Each
 * check runs N cases (from a JSON input table OR from a captured byte
 * fixture); each case produces an outcome the check classifies as
 * pass or fail.
 *
 * The diff driver (`parity-harness/diff.ts`) iterates registered
 * checks, aggregates results, prints a structured report, and exits
 * non-zero on any failure. The vitest wrapper at
 * `tests/parity/parity-harness.test.ts` enforces the same gate in CI.
 */

export interface CheckCaseResult {
  /** Stable identifier for this case (cited in failure messages). */
  caseId: string;
  /** Human-readable description (shown when the case fails). */
  description: string;
  /** true iff plugin output matches the in-host reference. */
  ok: boolean;
  /** When ok=false, a multi-line diff summary. Empty when ok=true. */
  diff: string;
}

export interface CheckReport {
  /** Stable name of the check (e.g. "persistApprovalRequest", "prompts"). */
  name: string;
  /** Cases run; SUM(cases) = passing + failing. */
  cases: CheckCaseResult[];
}

export interface ParityCheck {
  name: string;
  run(): Promise<CheckReport> | CheckReport;
}
