import { test, expect } from "@playwright/test";
import { fixture, createAndRun } from "./fixtures";
test("HTTP fixture: mission mandate, ENS, separate assessments and receipt", async ({
  page,
}) => {
  await fixture(page);
  await createAndRun(page);
  await expect(page.getByText("task.human.eth", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Jev assessment" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "HumanOS policy" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Execute approved action" }).click();
  await expect(page.getByText("Execution receipt · succeeded")).toBeVisible();
  await expect(
    page.getByText("receipt-fixture", { exact: true }),
  ).toBeVisible();
});
test("HTTP fixture: unavailable World does not manufacture approval", async ({
  page,
}) => {
  await fixture(page);
  await createAndRun(page);
  await page.getByRole("button", { name: "Verify sensitive action" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "World integration is unavailable",
  );
  await expect(page.getByText("Execution receipt · succeeded")).toHaveCount(0);
});
