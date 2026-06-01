import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as Record<string, unknown>;
}

describe("OpenClaw v2026.6.1-beta.1 release target metadata", () => {
  it("pins the runtime/install floor to the GitHub release target", () => {
    const manifest = readJson("openclaw.plugin.json");
    const pkg = readJson("package.json");
    const openclaw = pkg.openclaw as {
      target?: Record<string, unknown>;
      install?: Record<string, unknown>;
    };

    expect(pkg.version).toBe("1.0.0-port.19");
    expect(manifest.minHostVersion).toBe("2026.6.1-beta.1");
    expect(openclaw.target).toEqual(
      expect.objectContaining({
        version: "2026.6.1-beta.1",
        source: "github-release",
        tag: "v2026.6.1-beta.1",
        commit: "2fc497e67b9cf40b2c12a9355afd785e7f8672dc",
        npmPackageAvailable: false,
      }),
    );
    expect(openclaw.install?.minHostVersion).toBe(">=2026.6.1-beta.1");
    expect((pkg.peerDependencies as Record<string, unknown>).openclaw).toBe(
      ">=2026.6.1-beta.1",
    );
  });

  it("requires explicit SDK fallback metadata while the target is not on npm", () => {
    const pkg = readJson("package.json");
    const openclaw = pkg.openclaw as {
      target?: { npmPackageAvailable?: boolean };
      sdkValidation?: Record<string, unknown>;
    };
    const devOpenClaw = (pkg.devDependencies as Record<string, unknown>).openclaw;

    expect(openclaw.target?.npmPackageAvailable).toBe(false);
    expect(openclaw.sdkValidation).toEqual(
      expect.objectContaining({
        npmFallbackVersion: devOpenClaw,
        githubReleaseTag: "v2026.6.1-beta.1",
      }),
    );
  });
});
