import { expect, type Page, test } from '@playwright/test';

/**
 * A transcript that opens at its newest message has to reach the bottom even when the first
 * layout is built from estimates that are wrong by a wide margin — and it has to stop trying the
 * moment the reader takes over. Those two requirements pull against each other: the position that
 * says "still settling" and the position that says "the reader scrolled up" look identical.
 */

const HARNESS = '/test/e2e/fixtures/virtual-list.html?dataset=session&settleOnLoad=1';

async function state(page: Page) {
  return page.evaluate(() => window.harness.state());
}

test('an opening transcript closes a gap left by estimate-based sizing', async ({ page }) => {
  await page.goto(HARNESS);
  await page.locator('[role="log"] [data-index]').first().waitFor();

  await expect.poll(async () => (await state(page)).distanceFromBottom, { timeout: 4000 }).toBe(0);
});

test('the settling pass yields to a reader who scrolls away', async ({ page }) => {
  await page.goto(HARNESS);
  await page.locator('[role="log"] [data-index]').first().waitFor();
  await expect.poll(async () => (await state(page)).distanceFromBottom, { timeout: 4000 }).toBe(0);

  await page.locator('[role="log"]').hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(400);

  const after = await state(page);
  expect({
    stayedWhereTheReaderPutIt: after.distanceFromBottom > 400,
    followFlagCleared: after.atBottom
  }).toEqual({ stayedWhereTheReaderPutIt: true, followFlagCleared: false });
});
