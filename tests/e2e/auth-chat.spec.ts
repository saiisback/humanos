import { expect, test } from "@playwright/test";
import { fixture } from "./fixtures";

test("synthetic JAW sign-in creates an account session, then PoH unlocks the composer", async ({
  page,
}) => {
  await fixture(page, { auth: "signed-out" });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Sign in with JAW" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Sign in with JAW" }).click();
  await expect(
    page.getByRole("heading", { name: "Verify with World ID" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Send/ })).toBeDisabled();
  await page.getByRole("button", { name: "Verify with World ID" }).click();
  await page
    .getByRole("dialog", { name: "Synthetic World verification" })
    .getByRole("button", { name: "Complete synthetic verification" })
    .click();
  await page
    .getByLabel("What would you like to get done?")
    .fill("Ask an agent to plan Tokyo");
  await expect(page.getByRole("button", { name: /^Send/ })).toBeEnabled();
});

test("synthetic JAW cancellation leaves the user signed out", async ({
  page,
}) => {
  await fixture(page, { auth: "signed-out", jaw: "reject" });
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with JAW" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Passkey sign-in was cancelled",
  );
  await expect(
    page.getByRole("button", { name: "Sign in with JAW" }),
  ).toBeVisible();
});

test("backend SIWE rejection never produces an account session", async ({
  page,
}) => {
  await fixture(page, { auth: "signed-out", verifyRejected: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with JAW" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid signature");
  await expect(
    page.getByRole("button", { name: "Sign in with JAW" }),
  ).toBeVisible();
});

test("no-root account can explore and cancel PoH without losing JAW session", async ({
  page,
}) => {
  await fixture(page, { auth: "no-root" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Verify with World ID" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Verify with World ID" }).click();
  await page
    .getByRole("dialog", { name: "Synthetic World verification" })
    .getByRole("button", { name: "Cancel synthetic verification" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Verify with World ID" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Send/ })).toBeDisabled();
  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.getByRole("dialog", { name: "identity" })).toContainText(
    "JAW account",
  );
});

test("unavailable PoH retains account and denies mission creation", async ({
  page,
}) => {
  await fixture(page, { auth: "no-root", worldUnavailable: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Verify with World ID" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "World integration is unavailable",
  );
  await expect(page.getByRole("button", { name: /^Send/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
});

test("logout revokes the presented session and reconnect begins with a rootless account", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Account" }).click();
  await page
    .getByRole("dialog", { name: "identity" })
    .getByRole("button", { name: "Sign out" })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Sign in with JAW" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in with JAW" }).click();
  await expect(
    page.getByRole("heading", { name: "Verify with World ID" }),
  ).toBeVisible();
});

test("a draft survives a session expiry and waits for fresh sign-in", async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto("/");
  await page
    .getByLabel("What would you like to get done?")
    .fill("Keep this draft while I reconnect");
  // The server loses the session between visits; the local draft remains user-owned.
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { account: null, root: null, jawConfigured: true } }),
  );
  await page.reload();
  await expect(page.getByLabel("What would you like to get done?")).toHaveValue(
    "Keep this draft while I reconnect",
  );
  await expect(page.getByRole("button", { name: /^Send/ })).toBeDisabled();
  expect(data.mission.state).toBe("PROPOSED");
});
