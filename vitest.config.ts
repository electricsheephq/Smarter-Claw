import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "installer/**"],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    isolate: false,
    reporters: process.env.CI ? ["default"] : ["default"],
    passWithNoTests: true,
  },
});
