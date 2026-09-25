import { test, expect } from "@playwright/test";
import { fixture, createAndRun } from "./fixtures";
test("HTTP fixture: revoke disables subsequent action controls", async ({
  page,
}) => {
  await fixture(page);
  await createAndRun(page);
  await page.getByRole("button", { name: "Revoke authority" }).click();
  await expect(
    page
      .getByRole("region", { name: "Agent mandate" })
      .getByText("revoked", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Execute approved action" }),
  ).toHaveCount(0);
});
test("HTTP fixture: expired mission is read only", async ({ page }) => {
  await fixture(page, { state: "EXPIRED", existing: true });
  await page.goto("/?mission=mission-fixture");
  await expect(
    page
      .getByRole("region", { name: "Agent mandate" })
      .getByText("expired", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run mission", exact: true }),
  ).toHaveCount(0);
});
