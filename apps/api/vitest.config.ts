import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration files each open isolated PostgreSQL pools; keep local runs bounded.
    maxWorkers: 2,
  },
});
