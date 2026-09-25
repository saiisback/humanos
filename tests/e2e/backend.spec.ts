import { test, expect, type Page } from "@playwright/test";
import { startBackendHarness } from "./backend-server";
// No page.route/intercepted API. External World/ENS/models/Flue/effect transports are test-only fixtures.
let backend: Awaited<ReturnType<typeof startBackendHarness>>;
test.beforeAll(async () => {
  backend = await startBackendHarness();
});
test.afterAll(async () => {
  await backend?.close();
});
test.beforeEach(async ({ context }) => {
  const token = await backend.seed();
  await context.addCookies([
    {
      name: "humanos_session",
      value: token,
      url: backend.url,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
});
async function prepare(page: Page) {
  await page.goto(backend.url);
  await page
    .getByLabel("What would you like to get done?")
    .fill("Prepare my Tokyo participant application");
  await page.getByRole("button", { name: "Create mission" }).click();
  await page.getByRole("button", { name: "Authorize & create agent" }).click();
  await page.getByRole("button", { name: "Run mission", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "submit application", exact: true }),
  ).toBeVisible();
  return new URL(page.url()).searchParams.get("mission")!;
}
async function verifyFixture(page: Page, id: string) {
  const a = (await backend.actions(id))[0]!;
  const request = await page.request.post(
    `${backend.url}/api/actions/${a.id}/approval/request`,
    { data: {} },
  );
  expect(request.ok(), await request.text()).toBeTruthy();
  const { request: q } = await request.json();
  const verified = await page.request.post(
    `${backend.url}/api/actions/${a.id}/approval/verify`,
    {
      data: { requestId: q.requestId, proof: await backend.proof(q.requestId) },
    },
  );
  expect(verified.ok(), await verified.text()).toBeTruthy();
  await page.reload();
  return a;
}
test("REAL API + PostgreSQL, provider fixtures: submit, calendar, receipt and replay", async ({
  page,
}) => {
  const id = await prepare(page);
  const action = await verifyFixture(page, id);
  await page.getByRole("button", { name: "Execute approved action" }).click();
  await expect(page.getByText("Execution receipt · succeeded")).toBeVisible();
  expect(backend.effects.get(action.id)).toBe(1);
  const replay = await page.request.post(
    `${backend.url}/api/actions/${action.id}/execute`,
    { data: {} },
  );
  expect(replay.ok()).toBeTruthy();
  expect(backend.effects.get(action.id)).toBe(1);
  await page.getByRole("button", { name: "Resume mission" }).click();
  await expect(
    page.getByRole("heading", { name: "create calendar event", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm consequential action" })
    .click();
  await page.getByRole("button", { name: "Execute approved action" }).click();
  await expect(page.getByText("Execution receipt · succeeded")).toHaveCount(2);
  await expect(
    page.locator(".mission-detail > .section-title .badge"),
  ).toHaveText("completed");
});
test("REAL API + PostgreSQL, provider fixtures: cancellation blocks execution", async ({
  page,
}) => {
  const id = await prepare(page);
  const action = (await backend.actions(id))[0]!;
  await page.getByRole("button", { name: "Cancel action" }).click();
  await expect(page.getByRole("status")).toContainText("rejected");
  const denied = await page.request.post(
    `${backend.url}/api/actions/${action.id}/execute`,
    { data: {} },
  );
  expect(denied.ok()).toBeFalsy();
  expect(backend.effects.has(action.id)).toBeFalsy();
});
test("REAL API + PostgreSQL, provider fixtures: revoked verified approval cannot execute", async ({
  page,
}) => {
  const id = await prepare(page);
  const action = await verifyFixture(page, id);
  await page.getByRole("button", { name: "Revoke authority" }).click();
  await expect(page.getByRole("status")).toContainText("revoked");
  const denied = await page.request.post(
    `${backend.url}/api/actions/${action.id}/execute`,
    { data: {} },
  );
  expect(denied.ok()).toBeFalsy();
  expect(backend.effects.has(action.id)).toBeFalsy();
});
test("REAL API + PostgreSQL, provider fixtures: expiry survives refresh", async ({
  page,
}) => {
  const id = await prepare(page);
  const action = await verifyFixture(page, id);
  await backend.expire(id);
  await page.reload();
  await expect(page.getByRole("status")).toContainText("expired");
  const denied = await page.request.post(
    `${backend.url}/api/actions/${action.id}/execute`,
    { data: {} },
  );
  expect(denied.ok()).toBeFalsy();
  expect(backend.effects.has(action.id)).toBeFalsy();
});
test("REAL API + PostgreSQL, provider fixtures: reload preserves reviewed action and session", async ({
  page,
}) => {
  const id = await prepare(page);
  const action = (await backend.actions(id))[0]!;
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Backend-connected Tokyo mission",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("Inspect exact action & binding").click();
  await expect(
    page.getByText(action.payloadHash, { exact: true }),
  ).toBeVisible();
  expect((await backend.actions(id))[0]!.id).toBe(action.id);
});

for (const revoke of [false, true]) {
  test(`REAL API + PostgreSQL, provider fixtures: reconcile uncertain receipt${revoke ? " after revocation" : ""} without resubmission`, async ({
    page,
  }) => {
    const id = await prepare(page);
    const action = await verifyFixture(page, id);
    backend.ambiguousActions.add(action.id);
    await page.getByRole("button", { name: "Execute approved action" }).click();
    await expect(
      page.getByText("Execution receipt · reconciliation required"),
    ).toBeVisible();
    expect(backend.effects.get(action.id)).toBe(1);
    if (revoke) {
      await page.getByRole("button", { name: "Revoke authority" }).click();
      await expect(page.getByRole("status")).toContainText("revoked");
    }
    await page.getByRole("button", { name: "Check submission status" }).click();
    await expect(page.getByText("Execution receipt · succeeded")).toBeVisible();
    expect(backend.effects.get(action.id)).toBe(1);
    expect(backend.reconciliations.get(action.id)).toBe(1);
    if (revoke) await expect(page.getByRole("status")).toContainText("revoked");
  });
}

test("REAL API + PostgreSQL, provider fixtures: pending verification retries an expired challenge", async ({
  page,
}) => {
  const id = await prepare(page);
  const action = (await backend.actions(id))[0]!;
  const first = await page.request.post(
    `${backend.url}/api/actions/${action.id}/approval/request`,
    { data: {} },
  );
  expect(first.ok()).toBeTruthy();
  const original = await first.json();
  await backend.db.query(
    "UPDATE challenges SET data=jsonb_set(data,'{expiresAt}',to_jsonb($2::text)) WHERE id=$1",
    [original.request.requestId, new Date(Date.now() - 1000).toISOString()],
  );
  await page.reload();
  const renewedResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/actions/${action.id}/approval/request`) &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Retry verification" }).click();
  const response = await renewedResponse;
  expect(response.ok()).toBeTruthy();
  const renewed = await response.json();
  expect(renewed.approval.id).toBe(original.approval.id);
  expect(renewed.request.requestId).not.toBe(original.request.requestId);
  const verify = await page.request.post(
    `${backend.url}/api/actions/${action.id}/approval/verify`,
    {
      data: {
        requestId: renewed.request.requestId,
        proof: await backend.proof(renewed.request.requestId),
      },
    },
  );
  expect(verify.ok(), await verify.text()).toBeTruthy();
  await page.reload();
  await expect(page.locator(".action-review .badge")).toHaveText("verified");
});
