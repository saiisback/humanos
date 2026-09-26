/** Intercepted UI evidence only: no provider, reservation, or live account is used. */
import { test, expect } from "@playwright/test";

test("hotel answers refine the saved task, preserve known details, and never book", async ({ page }, testInfo) => {
  const createdAt = "2026-09-26T09:00:00.000Z";
  await page.clock.setFixedTime(new Date(createdAt));
  const account = { id: `11155111:0x${"1".repeat(40)}`, address: `0x${"1".repeat(40)}`, chainId: 11155111, createdAt };
  const original = "Book a hotel in Tokyo, check-in today and check-out tomorrow, for 1 guest and 1 room. Email ada@example.com.";
  const workflow = { id: "hotel-intake-fixture", accountId: account.id, rootId: null, missionId: null,
    name: "Tokyo hotel stay", status: "DRAFT", latestVersionId: "hotel-v1", createdAt, updatedAt: createdAt, archivedAt: null };
  const version = (goal: string, id: string, number: number) => ({ id, version: number, workflowId: workflow.id, goal,
    graph: { nodes: [{ id: "details", type: "human.input", input: { prompt: "Complete the stay details." } }] },
    requiredCapabilities: [], normalizedIntent: {}, activatedAt: null });
  const versions = [version(original, "hotel-v1", 1)];
  const detail = () => ({ workflow, versions, schedules: [] });
  const mutations: string[] = [];
  const unexpected: string[] = [];
  let submittedGoal: string | undefined;

  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET") mutations.push(`${method} ${path}`);
    let response: unknown;
    if (method === "GET" && path === "/api/auth/session") response = { account, root: null, jawConfigured: true };
    else if (method === "GET" && path === "/api/workflows") response = { workflows: [workflow] };
    else if (method === "GET" && path === "/api/workflow-connections") response = { accountId: account.id, connections: [] };
    else if (method === "GET" && path === `/api/workflows/${workflow.id}`) response = detail();
    else if (method === "GET" && path === `/api/workflows/${workflow.id}/runs`) response = { runs: [] };
    else if (method === "GET" && path === `/api/workflows/${workflow.id}/agent`)
      response = { binding: null, bindings: [], available: false, receiptPublications: [] };
    else if (method === "POST" && path === `/api/workflows/${workflow.id}/refine`) {
      const body = request.postDataJSON() as { goal: string };
      submittedGoal = body.goal;
      const nextVersion = versions.length + 1;
      workflow.latestVersionId = `hotel-v${nextVersion}`;
      versions.push(version(body.goal, workflow.latestVersionId, nextVersion));
      response = detail();
    } else if (method === "POST" && path === `/api/workflows/${workflow.id}/assemble`) response = detail();
    else {
      unexpected.push(`${method} ${path}`);
      await route.fulfill({ status: 501, json: { error: { message: "Blocked: unknown hotel test fixture route" } } });
      return;
    }
    await route.fulfill({ json: response });
  });

  await page.goto(`/?workflow=${workflow.id}`);
  const followup = page.getByRole("region", { name: "Hotel follow-up" });
  await expect(followup.getByRole("heading", { name: "Let’s fill in the missing details" })).toBeVisible();
  await expect(followup.locator("input")).toHaveCount(2);
  await expect(followup.getByLabel("Nightly budget (include currency)")).toBeVisible();
  await expect(followup.getByLabel("Guest’s full name")).toBeVisible();
  for (const label of ["City or area", "Check-in date", "Check-out date", "Guests", "Rooms", "Email"])
    await expect(followup.getByLabel(label, { exact: true })).toHaveCount(0);
  await followup.getByText("Saved stay details", { exact: true }).click();
  for (const value of ["Tokyo", "2026-09-26", "2026-09-27", "ada@example.com"])
    await expect(followup.locator("dd").filter({ hasText: value })).toBeVisible();
  await expect(followup.locator("dd").filter({ hasText: /^1$/ })).toHaveCount(2);
  await followup.getByText("Saved stay details", { exact: true }).click();
  await expect(page.getByRole("button", { name: /^Send/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("hotel-intake-questions.png"), fullPage: true });

  await followup.getByLabel("Nightly budget (include currency)").fill("JPY 15,000 per night");
  await followup.getByLabel("Guest’s full name").fill("Ada Lovelace");
  await followup.getByRole("button", { name: "Continue this task", exact: true }).click();
  await expect(followup.getByRole("heading", { name: "Your stay details are ready" })).toBeVisible();
  await expect(followup.getByText("I have your stay details. A supported hotel-booking service is still needed; nothing has been booked.", { exact: true })).toBeVisible();
  await expect(followup.locator("input")).toHaveCount(0);
  await expect(page).toHaveURL(/\?workflow=hotel-intake-fixture$/);
  expect(submittedGoal?.split("\n\n[Hotel details]\n")[0]).toBe(original);
  expect(JSON.parse(submittedGoal!.split("\n\n[Hotel details]\n")[1]!)).toEqual({
    city: "Tokyo", checkIn: "2026-09-26", checkOut: "2026-09-27", guests: "1", rooms: "1",
    email: "ada@example.com", budget: "JPY 15,000 per night", guestName: "Ada Lovelace",
  });
  for (const value of ["Tokyo", "2026-09-26", "2026-09-27", "ada@example.com", "JPY 15,000 per night", "Ada Lovelace"])
    await expect(followup.locator("dd").filter({ hasText: value })).toBeVisible();
  await expect(page.getByText("[Hotel details]", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Confirm this exact action|Run now|Run workflow/i })).toHaveCount(0);
  await expect.poll(() => mutations).toEqual([
    `POST /api/workflows/${workflow.id}/refine`, `POST /api/workflows/${workflow.id}/assemble`,
  ]);
  await followup.getByRole("button", { name: "Edit stay details", exact: true }).click();
  const known = {
    "City or area": "Tokyo", "Check-in date": "2026-09-26", "Check-out date": "2026-09-27",
    Guests: "1", Rooms: "1", Email: "ada@example.com", "Nightly budget (include currency)": "JPY 15,000 per night",
    "Guest’s full name": "Ada Lovelace",
  };
  for (const [label, value] of Object.entries(known))
    await expect(followup.getByLabel(label, { exact: true })).toHaveValue(value);
  await followup.getByLabel("Guests", { exact: true }).fill("2");
  await followup.getByRole("button", { name: "Save stay details", exact: true }).click();
  await expect(followup.locator("input")).toHaveCount(0);
  await expect(followup.locator("dt").filter({ hasText: /^Guests$/ }).locator("+ dd")).toHaveText("2");
  await expect(followup.locator("dt").filter({ hasText: /^Rooms$/ }).locator("+ dd")).toHaveText("1");
  for (const value of ["Tokyo", "2026-09-26", "2026-09-27", "ada@example.com", "JPY 15,000 per night", "Ada Lovelace"])
    await expect(followup.locator("dd").filter({ hasText: value })).toBeVisible();
  expect(JSON.parse(submittedGoal!.split("\n\n[Hotel details]\n")[1]!)).toEqual({
    city: "Tokyo", checkIn: "2026-09-26", checkOut: "2026-09-27", guests: "2", rooms: "1",
    email: "ada@example.com", budget: "JPY 15,000 per night", guestName: "Ada Lovelace",
  });
  expect(submittedGoal?.split("\n\n[Hotel details]\n")[0]).toBe(original);
  await expect(page).toHaveURL(/\?workflow=hotel-intake-fixture$/);
  await expect(followup.getByText("I have your stay details. A supported hotel-booking service is still needed; nothing has been booked.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Confirm this exact action|Run now|Run workflow/i })).toHaveCount(0);
  await expect.poll(() => mutations).toEqual([
    `POST /api/workflows/${workflow.id}/refine`, `POST /api/workflows/${workflow.id}/assemble`,
    `POST /api/workflows/${workflow.id}/refine`, `POST /api/workflows/${workflow.id}/assemble`,
  ]);
  expect(unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await followup.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("hotel-intake-complete.png"), fullPage: true });
});
