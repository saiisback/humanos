import { test, expect } from "@playwright/test";
import { fixture, createAndRun } from "./fixtures";
test("HTTP fixture: reload resumes persisted mission detail from server", async ({
  page,
}) => {
  await fixture(page);
  await createAndRun(page);
  await page.reload();
  await expect(
    page
      .getByRole("list", { name: "Mission conversation" })
      .getByText("Tokyo application", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "submit application", exact: true }),
  ).toBeVisible();
});
test("HTTP fixture: network failure is recoverable without inventing identity", async ({
  page,
}) => {
  await page.route("**/api/**", (r) =>
    r.fulfill({
      status: 503,
      json: { error: { message: "Service unavailable" } },
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Service unavailable");
  await expect(
    page.getByRole("button", { name: "Retry connection" }),
  ).toBeVisible();
});
