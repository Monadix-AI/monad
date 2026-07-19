import { expect, type Page, test } from '@playwright/test';

/**
 * Scrolling back through a real transcript must not move the content under the reader. Rows enter
 * the viewport carrying an estimate and replace it with a measurement; the compensation for that
 * has to be exact, or every mis-estimated row shifts the text the reader is mid-sentence in.
 *
 * The transcript is a real session captured from a running daemon: 146 rows from 2 to 5000
 * characters, so estimates are wrong by an order of magnitude in both directions.
 */

const HARNESS = '/test/e2e/fixtures/virtual-list.html?dataset=session';
/** Sub-pixel rounding in transforms and rects; anything above this is a visible jump. */
const DRIFT_TOLERANCE_PX = 2;

async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.locator('[role="log"] [data-index]').first().waitFor();
  await expect.poll(async () => (await page.evaluate(() => window.harness.state())).distanceFromBottom).toBe(0);
}

async function settleLayout(page: Page): Promise<void> {
  let previous = -1;
  await expect
    .poll(async () => {
      const { scrollHeight } = await page.evaluate(() => window.harness.state());
      const stable = scrollHeight === previous;
      previous = scrollHeight;
      return stable;
    })
    .toBe(true);
}

async function wheelBy(page: Page, deltaY: number): Promise<void> {
  await page.locator('[role="log"]').hover();
  await page.mouse.wheel(0, deltaY);
  await settleLayout(page);
}

/**
 * The worst content displacement seen over one wheel step, in px: the anchored row should travel
 * across the viewport by exactly the gesture distance and not one pixel more.
 */
async function driftOverWheel(page: Page, deltaY: number): Promise<number> {
  const anchored = await page.evaluate(() => window.harness.anchor());
  if (anchored.id === null) return 0;
  await wheelBy(page, deltaY);
  const duringScroll = await page.evaluate(() => window.harness.anchorDrift());
  // Measurement keeps landing for several frames after the gesture stops; the reader sees those
  // corrections as a delayed jump just as clearly.
  await page.waitForTimeout(250);
  const afterSettle = await page.evaluate(() => window.harness.anchorDrift());
  return Math.max(Math.abs(duringScroll + deltaY), Math.abs(afterSettle + deltaY));
}

test('scrolling back through a real transcript holds the content still', async ({ page }) => {
  await openHarness(page);

  const drifts: number[] = [];
  for (let step = 0; step < 12; step += 1) drifts.push(await driftOverWheel(page, -400));

  expect(Math.max(...drifts)).toBeLessThanOrEqual(DRIFT_TOLERANCE_PX);
});

test('scrolling forward again through a real transcript holds the content still', async ({ page }) => {
  await openHarness(page);
  for (let step = 0; step < 12; step += 1) await wheelBy(page, -400);

  const drifts: number[] = [];
  for (let step = 0; step < 8; step += 1) drifts.push(await driftOverWheel(page, 300));

  expect(Math.max(...drifts)).toBeLessThanOrEqual(DRIFT_TOLERANCE_PX);
});
