/** Browser interaction fixtures only; chain integration evidence lives in packages/ens tests. */
import { test, expect } from "@playwright/test";
test("workflow identity opens in place, registers once, revokes, and fits the viewport", async ({
  page,
}, testInfo) => {
  const account = {
    id: `11155111:0x${"1".repeat(40)}`,
    address: `0x${"1".repeat(40)}`,
    chainId: 11155111,
    createdAt: new Date().toISOString(),
  };
  const root = {
    id: "browser-root",
    ensName: null,
    createdAt: account.createdAt,
    verificationEnvironment: "staging",
  };
  const workflow = {
    id: "agent-browser",
    accountId: account.id,
    rootId: root.id,
    missionId: null,
    name: "Draft a Tokyo travel note",
    status: "ACTIVE",
    latestVersionId: "v1",
    createdAt: account.createdAt,
    updatedAt: account.createdAt,
    archivedAt: null,
  };
  const version = {
    id: "v1",
    version: 1,
    workflowId: workflow.id,
    goal: workflow.name,
    graph: { nodes: [{ id: "write", type: "content.generate" }] },
    requiredCapabilities: [],
    activatedAt: account.createdAt,
  };
  let binding: any = null,
    enables = 0,
    revokes = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let result: unknown = {};
    if (path === "/api/auth/session")
      result = { account, root, jawConfigured: true };
    else if (path === "/api/workflows") result = { workflows: [workflow] };
    else if (path === "/api/workflow-connections")
      result = { accountId: account.id, connections: [] };
    else if (path === `/api/workflows/${workflow.id}`)
      result = { workflow, versions: [version], schedules: [] };
    else if (path.endsWith("/runs")) result = { runs: [] };
    else if (path.endsWith("/agent/review"))
      result = {
        review: {
          id: "review1",
          reviewHash: `0x${"a".repeat(64)}`,
          workflowId: workflow.id,
          versionId: "v1",
          accountId: account.id,
          rootId: root.id,
          capabilities: ["drafts.write"],
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          reviewExpiresAt: new Date(Date.now() + 300000).toISOString(),
          chainId: 11155111,
          parentName: "test-humanos.eth",
        },
      };
    else if (path.endsWith("/agent/enable")) {
      enables++;
      expect(route.request().postDataJSON()).toEqual({
        reviewId: "review1",
        expectedReviewHash: `0x${"a".repeat(64)}`,
      });
      binding = {
        id: "binding1",
        workflowId: workflow.id,
        versionId: "v1",
        accountId: account.id,
        rootId: root.id,
        capabilities: ["drafts.write"],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        chainId: 11155111,
        ensName: "m0123456789abcdef.r0123456789abcdef.test-humanos.eth",
        agentAddress: `0x${"2".repeat(40)}`,
        node: `0x${"d".repeat(64)}`,
        state: "ACTIVE",
        generation: 1,
        revision: 1,
        graphHash: `0x${"c".repeat(64)}`,
        registrationTxHashes: [`0x${"b".repeat(64)}`],
        revocationTxHashes: [],
      };
      result = { binding };
    } else if (path.endsWith("/revoke")) {
      revokes++;
      binding = { ...binding, state: "REVOKED", revision: 2 };
      result = { binding };
    } else if (path.endsWith("/agent"))
      result = {
        binding,
        bindings: binding ? [binding] : [],
        available: true,
        receiptPublications: binding
          ? [
              {
                runId: "fixture-run",
                receiptHash: `0x${"e".repeat(64)}`,
                state: "PUBLISHED",
                txHashes: [`0x${"f".repeat(64)}`],
              },
            ]
          : [],
      };
    else if (path === "/api/workflow-agents")
      result = { bindings: binding ? [binding] : [], available: true };
    else
      return route.fulfill({
        status: 404,
        json: { error: { message: "Unknown browser fixture route" } },
      });
    return route.fulfill({ json: result });
  });
  await page.goto(`/?workflow=${workflow.id}`);
  await expect(
    page.getByRole("heading", { name: "Plan ready for review" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Identity & permissions", exact: true })
    .click();
  await expect(page).toHaveURL(/workflow=agent-browser&identity=1/);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Identity & permissions" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Enable ENS agent", exact: true })
    .click();
  await expect(dialog.getByText("drafts.write", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "Register ENS agent", exact: true })
    .click();
  await expect(
    dialog.getByText("Active on Sepolia", { exact: true }),
  ).toBeVisible();
  expect(enables).toBe(1);
  await expect(
    dialog.getByRole("heading", { name: "ENS receipt publications" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath("agent-panel.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Back to workflow", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/\?workflow=agent-browser$/);
  await page
    .getByRole("button", { name: "Identity & permissions", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Revoke agent…", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Revoke agent", exact: true })
    .click();
  await expect(dialog.getByText("Revoked", { exact: true })).toBeVisible();
  expect(revokes).toBe(1);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Run again", exact: true }),
  ).toBeDisabled();
});
