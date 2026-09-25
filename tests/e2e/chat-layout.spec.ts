import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "../../apps/web/node_modules/@axe-core/playwright/dist/index.mjs";
import type { MissionDetailResponse } from "../../packages/schemas/src/api";

const long = "ThisIsALongSchemaValidUnbrokenServerValue".repeat(16);
const mission: MissionDetailResponse = {
  mission: {
    id: "mission-fixture",
    rootId: "root-fixture",
    agentEns: `agent-${long}.eth`,
    title: long.slice(0, 180),
    goal: long,
    capabilities: ["application.submit"],
    approvedCapabilities: ["application.submit"],
    steps: [long],
    expiresAt: "2099-09-24T12:00:00Z",
    createdAt: "2026-09-24T01:00:00Z",
    updatedAt: "2026-09-24T01:00:00Z",
    policyVersion: "v1",
    state: "AWAITING_APPROVAL",
  },
  actions: [
    {
      id: "action-fixture",
      rootId: "root-fixture",
      missionId: "mission-fixture",
      agentEns: `agent-${long}.eth`,
      type: "SUBMIT_APPLICATION",
      capability: "application.submit",
      payload: { event: long, url: `https://example.com/${long}` },
      reason: long,
      payloadHash: `0x${"a".repeat(64)}`,
      nonce: long,
      expiresAt: "2099-09-24T12:00:00Z",
      createdAt: "2026-09-24T01:00:00Z",
    },
  ],
  approvals: [],
  receipts: [],
  events: [],
  assessment: null,
  decision: null,
};
async function mockChat(page: Page, failPolling = false) {
  let reads = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          account: {
            id: `11155111:0x${"1".repeat(40)}`,
            address: `0x${"1".repeat(40)}`,
            chainId: 11155111,
            createdAt: "2026-09-24T01:00:00Z",
          },
          root: {
            id: "root-fixture",
            ensName: "human.eth",
            createdAt: "2026-09-24T01:00:00Z",
            verificationEnvironment: "staging",
          },
          jawConfigured: false,
        },
      });
    if (path === "/api/ready")
      return route.fulfill({
        json: {
          ready: false,
          services: [
            { name: "DeepSeek", ready: false, reason: long },
            { name: "Jev", ready: false, reason: null },
          ],
        },
      });
    if (path === "/api/missions")
      return route.fulfill({ json: { missions: [mission.mission] } });
    if (path === "/api/missions/mission-fixture") {
      reads++;
      return reads > 2 && failPolling
        ? route.fulfill({
            status: 503,
            json: {
              error: { code: "UNAVAILABLE", message: "Connection unavailable" },
            },
          })
        : route.fulfill({ json: mission });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "Not found" } },
    });
  });
}
async function geometry(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("main")!;
    const composer = document.querySelector<HTMLElement>(".composer")!;
    const box = composer.getBoundingClientRect();
    return {
      mainOverflow: main.scrollWidth > main.clientWidth,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      composerInViewport: box.top >= 0 && box.bottom <= innerHeight,
      mainAboveComposer: main.getBoundingClientRect().bottom <= box.top,
    };
  });
}
test("populated conversation keeps composer visible at phone and desktop sizes, including an error", async ({
  page,
}) => {
  for (const size of [
    { width: 320, height: 700 },
    { width: 1280, height: 900 },
  ]) {
    await page.unrouteAll();
    await mockChat(page, true);
    await page.setViewportSize(size);
    await page.goto("/?mission=mission-fixture");
    await expect(
      page.getByRole("region", { name: "Action review action-fixture" }),
    ).toBeVisible();
    expect(await geometry(page)).toEqual({
      mainOverflow: false,
      pageOverflow: false,
      composerInViewport: true,
      mainAboveComposer: true,
    });
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 8_000 });
    expect(await geometry(page)).toEqual({
      mainOverflow: false,
      pageOverflow: false,
      composerInViewport: true,
      mainAboveComposer: true,
    });
    await expect(page.getByRole("button", { name: /^Send/ })).toBeVisible();
    await page.screenshot({
      path: `test-results/task-6-chat-${size.width}.png`,
    });
  }
});
test("mobile navigation reaches connections and restores focus", async ({
  page,
}) => {
  await mockChat(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/?mission=mission-fixture");
  await page.getByRole("button", { name: "Open missions" }).click();
  await page.getByRole("button", { name: "Connections" }).click();
  await expect(page.getByRole("dialog", { name: "connections" })).toBeVisible();
  await expect(
    page.getByText("Configuration status is not proof"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open missions" }),
  ).toBeFocused();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.getByRole("button", { name: "Open missions" }).click();
  await page.getByRole("button", { name: "Connections" }).click();
  await expect(page.getByRole("dialog", { name: "connections" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open missions" }),
  ).toBeFocused();
});
