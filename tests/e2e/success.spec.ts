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

test("HTTP fixture: successful execution shows pending ENS publication and retries to backend confirmation", async ({
  page,
}) => {
  const data = await fixture(page);
  await createAndRun(page);
  let calls = 0;
  await page.route("**/api/actions/action-fixture/execute", async (route) => {
    calls++;
    data.mission.state = "COMPLETED";
    data.receipts = [
      {
        id: "receipt-ens-fixture",
        missionId: data.mission.id,
        actionId: "action-fixture",
        idempotencyKey: "ens-fixture",
        payloadHash: "0x" + "a".repeat(64),
        externalId: "external-fixture",
        executedAt: data.mission.createdAt,
        status: "SUCCEEDED",
        metadata: { ensUpdateStatus: calls === 1 ? "PENDING" : "CONFIRMED" },
      },
    ];
    await route.fulfill({ json: data.receipts[0] });
  });
  await page.getByRole("button", { name: "Execute approved action" }).click();
  await expect(page.getByText("Execution receipt · succeeded")).toBeVisible();
  await expect(
    page.getByText("ENS receipt publication pending.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("ENS receipt publication confirmed", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Retry ENS receipt publication" })
    .click();
  await expect(
    page.getByText("ENS receipt publication confirmed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry ENS receipt publication" }),
  ).toHaveCount(0);
  expect(calls).toBe(2);
  await expect(
    page.getByText("receipt-ens-fixture", { exact: true }),
  ).toBeVisible();
});
