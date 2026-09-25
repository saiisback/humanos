import { expect, test, type Page } from "@playwright/test";
import { fixture } from "./fixtures";

async function serverGrants(page: Page) {
  return page.evaluate(
    async () =>
      (await (await fetch("/api/jaw/permissions")).json()).grants as Array<{
        status: string;
      }>,
  );
}

test("synthetic JAW grant records exact reviewed constraints but remains unverified", async ({
  page,
}) => {
  await fixture(page, {
    state: "AUTHORIZED",
    existing: true,
    permission: "success",
  });
  await page.goto("/?mission=mission-fixture");
  const review = page.getByRole("region", {
    name: "Onchain permission review",
  });
  await expect(review).toContainText("100 base units");
  await expect(review).toContainText("0xa9059cbb");
  await review.getByRole("button", { name: "Grant permission" }).click();
  await expect(review).toContainText("independent verification is unavailable");
  await expect
    .poll(async () => (await serverGrants(page))[0]?.status)
    .toBe("UNVERIFIED");
});

test("synthetic JAW rejection records no onchain grant", async ({ page }) => {
  await fixture(page, {
    state: "AUTHORIZED",
    existing: true,
    permission: "reject",
  });
  await page.goto("/?mission=mission-fixture");
  const review = page.getByRole("region", {
    name: "Onchain permission review",
  });
  await review.getByRole("button", { name: "Grant permission" }).click();
  await expect(review).toContainText(
    "Permission request cancelled. No grant was recorded.",
  );
  expect(await serverGrants(page)).toEqual([]);
});

test("synthetic JAW revocation marks the server grant revoked", async ({
  page,
}) => {
  await fixture(page, {
    state: "AUTHORIZED",
    existing: true,
    permission: "success",
  });
  await page.goto("/?mission=mission-fixture");
  const review = page.getByRole("region", {
    name: "Onchain permission review",
  });
  await review.getByRole("button", { name: "Grant permission" }).click();
  await expect(
    review.getByRole("button", { name: "Revoke permission" }),
  ).toBeVisible();
  await review.getByRole("button", { name: "Revoke permission" }).click();
  await expect(review).toContainText("Revocation verified");
  await expect
    .poll(async () => (await serverGrants(page))[0]?.status)
    .toBe("REVOKED");
});

test("unavailable JAW permission transport cannot grant authority", async ({
  page,
}) => {
  await fixture(page, {
    state: "AUTHORIZED",
    existing: true,
    permission: "unavailable",
  });
  await page.goto("/?mission=mission-fixture");
  const review = page.getByRole("region", {
    name: "Onchain permission review",
  });
  await expect(review).toContainText("JAW permissions are unavailable");
  await expect(
    review.getByRole("button", { name: "Grant permission" }),
  ).toBeDisabled();
  expect(await serverGrants(page)).toEqual([]);
});
