/**
 * Plan-mode session-extension schema versioning.
 *
 * Per the plan's Open Item #4 (and Wave-6 final adversarial probe P4):
 * the plugin's persisted state shape (PlanModeSessionState) is a wire
 * contract. Other plugins, the host UI, and future plugin versions all
 * read this shape. Schema changes need a versioned migration path; we
 * cannot silently rename fields or change types.
 *
 * # Policy
 *
 * v1.x: additive-only. New fields land as optional; existing fields
 * keep their types and semantics. `__schemaVersion` stays at 1.
 *
 * v2.0: breaking changes allowed. Bump `CURRENT_SCHEMA_VERSION` to 2.
 * Provide a `migrate(state, fromVersion)` function that upgrades v1
 * payloads. State stamped `__schemaVersion: 1` from sessions opened
 * under v1.x continues to read correctly after upgrade.
 *
 * # Stamping
 *
 * Every successful write through PlanModeStore stamps the current
 * version on the payload. Reads detect missing `__schemaVersion`
 * (legacy v0 payloads from before P-3 shipped) and treat them as
 * v1 (additive-only forward-compat).
 */

/**
 * Current schema version. Increment on breaking changes; provide
 * migration path in PlanModeStore.read.
 */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/**
 * Minimum schema version this plugin build can read. Reads of older
 * payloads ALSO succeed via lenient additive-forward-compat (missing
 * fields are treated as undefined).
 */
export const MIN_READABLE_SCHEMA_VERSION = 1 as const;

/**
 * Stamp a payload object with the current schema version. Idempotent —
 * safe to call on an already-stamped object.
 */
export function stampSchemaVersion<T extends object>(
  payload: T,
): T & { __schemaVersion: typeof CURRENT_SCHEMA_VERSION } {
  return { ...payload, __schemaVersion: CURRENT_SCHEMA_VERSION };
}

/**
 * Extract the schema version from a payload, defaulting to 1 (legacy
 * payloads from sessions written before P-3 shipped have no stamp;
 * we treat them as v1 since v1 is the foundational shape).
 */
export function readSchemaVersion(payload: unknown): number {
  if (
    payload != null &&
    typeof payload === "object" &&
    "__schemaVersion" in payload
  ) {
    const v = (payload as { __schemaVersion?: unknown }).__schemaVersion;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return 1;
}
