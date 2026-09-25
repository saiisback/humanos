import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  ...(process.env.HUMANOS_RECORD === "1"
    ? { workers: 1, timeout: 120_000, expect: { timeout: 20_000 } }
    : {}),
  ...(process.env.HUMANOS_RECORD_DIR
    ? { outputDir: process.env.HUMANOS_RECORD_DIR }
    : {}),
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5183",
    trace: "retain-on-failure",
    video: process.env.HUMANOS_RECORD === "1" ? "on" : "off",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command:
      "pnpm --filter @humanos/web exec vite --mode e2e --host 127.0.0.1 --port 5183 --strictPort",
    url: "http://127.0.0.1:5183",
    reuseExistingServer: false,
  },
});
