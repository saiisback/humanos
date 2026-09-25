import { test, expect } from "@playwright/test";
import { fixture, createAndRun } from "./fixtures";
test("HTTP fixture: cancellation leaves no execution receipt", async ({
  page,
}) => {
  await fixture(page);
  await createAndRun(page);
  await page.getByRole("button", { name: "Cancel action" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Action cancelled" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Execute approved action" }),
  ).toHaveCount(0);
});
test("HTTP fixture: sensitive action cannot use consequential confirmation", async ({
  page,
}) => {
  await fixture(page);
  await createAndRun(page);
  await page
    .getByRole("button", { name: "Confirm consequential action" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Sensitive actions require fresh World verification",
  );
});

test("synthetic World action widget cancellation records a cancelled approval", async ({
  page,
}) => {
  const data = await fixture(page);
  await createAndRun(page);
  await page.getByRole("button", { name: "Verify sensitive action" }).click();
  await page
    .getByRole("dialog", { name: "Synthetic World verification" })
    .getByRole("button", { name: "Cancel synthetic verification" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Action cancelled" }),
  ).toBeVisible();
  expect(data.approvals[0]?.status).toBe("CANCELLED");
  expect(data.receipts).toEqual([]);
});
