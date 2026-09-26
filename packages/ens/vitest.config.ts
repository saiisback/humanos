import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Local-chain suites deploy the same Foundry script and share its artifact paths.
    // Serialize files to avoid concurrent broadcast/deployment interference.
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
