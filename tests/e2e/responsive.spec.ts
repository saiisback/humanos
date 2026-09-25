import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "../../apps/web/node_modules/@axe-core/playwright/dist/index.mjs";
import { createAndRun, fixture } from "./fixtures";

async function bounds(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("main")!;
    const composer = document.querySelector<HTMLElement>(".composer")!;
    main.scrollTop = main.scrollHeight;
    const last = main.querySelector<HTMLElement>(".transcript-item:last-child");
    return {
      documentFits: document.documentElement.scrollWidth <= innerWidth,
      conversationFits: main.scrollWidth <= main.clientWidth,
      composerVisible:
        composer.getBoundingClientRect().top >= 0 &&
        composer.getBoundingClientRect().bottom <= innerHeight,
      scrollerClearsComposer:
        main.getBoundingClientRect().bottom <=
        composer.getBoundingClientRect().top,
      finalItemReachable:
        !!last &&
        last.getBoundingClientRect().bottom <=
          main.getBoundingClientRect().bottom + 1,
    };
  });
}

test("conversation and final review remain reachable at 320px, iPhone and desktop widths", async ({
  page,
}, testInfo) => {
  for (const viewport of [
    { width: 320, height: 700 },
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    await page.unrouteAll();
    await fixture(page);
    await page.setViewportSize(viewport);
    await createAndRun(page);
    await expect(
      page.getByRole("region", { name: "Action review action-fixture" }),
    ).toBeVisible();
    expect(await bounds(page)).toEqual({
      documentFits: true,
      conversationFits: true,
      composerVisible: true,
      scrollerClearsComposer: true,
      finalItemReachable: true,
    });
    await page.screenshot({
      path: testInfo.outputPath(`conversation-${viewport.width}.png`),
    });
  }
});

test("200 percent zoom equivalent keeps empty, denial and receipt views in bounds", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 640, height: 700 });
  const data = await fixture(page);
  await page.goto("/");
  await expect(
    page.getByLabel("What would you like to get done?"),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("empty-zoom-200.png") });
  await createAndRun(page);
  await page.getByRole("button", { name: "Cancel action" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Action cancelled" }),
  ).toBeVisible();
  expect(await bounds(page)).toEqual({
    documentFits: true,
    conversationFits: true,
    composerVisible: true,
    scrollerClearsComposer: true,
    finalItemReachable: true,
  });
  await page.screenshot({ path: testInfo.outputPath("denial-zoom-200.png") });
  data.mission.state = "COMPLETED";
  data.events = [];
  data.approvals = [];
  data.receipts = [
    {
      id: "receipt-zoom",
      missionId: data.mission.id,
      actionId: "action-fixture",
      idempotencyKey: "zoom",
      payloadHash: `0x${"a".repeat(64)}`,
      status: "SUCCEEDED",
      externalId: null,
      executedAt: "2026-09-24T01:00:00Z",
      metadata: {},
    },
  ];
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Execution receipt" }),
  ).toBeVisible();
  expect(await bounds(page)).toEqual({
    documentFits: true,
    conversationFits: true,
    composerVisible: true,
    scrollerClearsComposer: true,
    finalItemReachable: true,
  });
  await page.screenshot({ path: testInfo.outputPath("receipt-zoom-200.png") });
});

test("all mobile sheets trap focus, close with Escape, restore trigger, and pass axe", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Open missions" });
  for (const sheet of ["missions", "identity", "connections"] as const) {
    await trigger.focus();
    await page.keyboard.press("Enter");
    if (sheet !== "missions")
      await page
        .getByRole("dialog", { name: "missions" })
        .getByRole("button", {
          name: sheet === "identity" ? "Identity" : "Connections",
        })
        .click();
    const dialog = page.getByRole("dialog", { name: sheet });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: `Close ${sheet}` }),
    ).toBeFocused();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(i % 2 ? "Shift+Tab" : "Tab");
      expect(
        await page.evaluate(
          () => document.activeElement?.closest("dialog") !== null,
        ),
      ).toBe(true);
    }
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`${sheet}-sheet-320.png`),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});

test("desktop mission rail collapses and reopens with keyboard controls", async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Collapse missions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".app-shell")).toHaveClass(/rail-closed/);
  await page.getByRole("button", { name: "Expand missions" }).press("Enter");
  await expect(page.locator(".app-shell")).toHaveClass(/rail-open/);
});
