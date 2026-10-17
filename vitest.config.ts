import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "mcp/**/*.test.ts", "demos/**/*.test.ts"],
    globalSetup: ["./vitest.globalSetup.ts"],
    // The catalog and route suites talk to a local FalkorDB container.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
