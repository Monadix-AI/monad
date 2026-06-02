import { expect, type Page, test } from '@playwright/test';

/**
 * The bottom pin has two edges that are easy to get wrong in opposite directions: it must not
 * fight a reader easing away from the bottom, and it must still settle the very first layout at
 * the bottom even though that layout is built from estimates.
 */

const HARNESS = '/test/e2e/fixtures/virtual-list.html';
const SESSION_HARNESS = '/test/e2e/fixtures/virtual-list.html?dataset=session';

async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.locator('[role="log"] [data-index]').first().waitFor();
}

test('a small scroll away from the bottom is not pulled back', async ({ page }) => {
  await openHarness(page);
  await expect.poll(async () => (await page.evaluate(() => window.harness.state())).distanceFromBottom).toBe(0);

  // A nudge smaller than the follow threshold: exactly the range a pin that runs on every scroll
  // notification would snap back.
  await page.locator('[role="log"]').hover();
  await page.mouse.wheel(0, -72);
  await page.waitForTimeout(120);

  expect((await page.evaluate(() => window.harness.state())).distanceFromBottom).toBeGreaterThanOrEqual(60);
});

test('the first layout settles at the true bottom despite estimate-based sizing', async ({ page }) => {
  await page.goto(SESSION_HARNESS);
  await page.locator('[role="log"] [data-index]').first().waitFor();

  // Rows mount at a 96px estimate while real heights run into the thousands, so the initial
  // end-scroll lands far short until measurements settle and the pin closes the gap.
  await expect
    .poll(async () => (await page.evaluate(() => window.harness.state())).distanceFromBottom, { timeout: 4000 })
    .toBe(0);

  const state = await page.evaluate(() => window.harness.state());
  expect({ atBottom: state.atBottom, distanceFromBottom: state.distanceFromBottom }).toEqual({
    atBottom: true,
    distanceFromBottom: 0
  });
});
