/**
 * Schema-version stamping + parsing tests.
 */

import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  MIN_READABLE_SCHEMA_VERSION,
  readSchemaVersion,
  stampSchemaVersion,
} from "../../src/state/schema-version.js";

describe("P-3 schema-version", () => {
  it("CURRENT_SCHEMA_VERSION is 1 (additive-only v1.x policy)", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  it("MIN_READABLE_SCHEMA_VERSION is 1", () => {
    expect(MIN_READABLE_SCHEMA_VERSION).toBe(1);
  });

  it("stampSchemaVersion adds the version field", () => {
    const stamped = stampSchemaVersion({ foo: "bar" });
    expect(stamped.__schemaVersion).toBe(1);
    expect(stamped.foo).toBe("bar");
  });

  it("stampSchemaVersion is idempotent", () => {
    const stamped1 = stampSchemaVersion({ x: 1 });
    const stamped2 = stampSchemaVersion(stamped1);
    expect(stamped2.__schemaVersion).toBe(1);
    expect(stamped2.x).toBe(1);
  });

  it("readSchemaVersion returns the stamped value", () => {
    expect(readSchemaVersion({ __schemaVersion: 1 })).toBe(1);
    expect(readSchemaVersion({ __schemaVersion: 7 })).toBe(7);
  });

  it("readSchemaVersion defaults missing field to 1 (legacy compat)", () => {
    expect(readSchemaVersion({ no: "version" })).toBe(1);
    expect(readSchemaVersion({})).toBe(1);
  });

  it("readSchemaVersion is defensive vs malformed input", () => {
    expect(readSchemaVersion(undefined)).toBe(1);
    expect(readSchemaVersion(null)).toBe(1);
    expect(readSchemaVersion("string")).toBe(1);
    expect(readSchemaVersion(42)).toBe(1);
    expect(readSchemaVersion({ __schemaVersion: "bogus" })).toBe(1);
    expect(readSchemaVersion({ __schemaVersion: -1 })).toBe(1);
    expect(readSchemaVersion({ __schemaVersion: 0 })).toBe(1);
    expect(readSchemaVersion({ __schemaVersion: NaN })).toBe(1);
  });
});
