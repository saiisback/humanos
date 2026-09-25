import { test, expect } from "@playwright/test";
test("LIVE LOCAL API: readiness and unauthenticated onboarding", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    process.env.HUMANOS_LIVE_API !== "1",
    "Requires actual local backend on port 3001. No interception.",
  );
  const response = await request.get("http://127.0.0.1:3001/api/ready");
  expect(response.ok()).toBeTruthy();
  const readiness = await response.json();
  expect(readiness.services).toBeInstanceOf(Array);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Sign in with JAW" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connections" }).click();
  await expect(page.getByRole("dialog", { name: "connections" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`live-onboarding-${testInfo.project.name}.png`),
    fullPage: true,
  });
});
