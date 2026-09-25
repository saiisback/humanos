import { test, expect } from "@playwright/test";
import AxeBuilder from "../../apps/web/node_modules/@axe-core/playwright/dist/index.mjs";
import { fixture, createAndRun } from "./fixtures";
test("HTTP fixture: mission screen accessibility and responsive bounds", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await createAndRun(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: `test-results/mission-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
