import { expect, type Page, test } from '@playwright/test';

/**
 * Live observation streaming must not visibly flicker. The harness feeds the real
 * MeshAgentObservationPanel a card projection rebuilt every 60ms — reasoning deltas growing the
 * tail card, tool pairs and turn boundaries appending — and instruments the two things a reader
 * perceives as flicker: frames where the end-pinned viewport sits off the bottom, and DOM
 * remounts of rows whose keys did not change.
 */

const HARNESS = '/test/e2e/fixtures/observation-stream.html';

async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.locator('[role="log"] [data-index]').first().waitFor();
  await expect.poll(async () => (await page.evaluate(() => window.streamHarness.state())).distanceFromBottom).toBe(0);
}

test('streaming growth keeps the pinned viewport on the bottom without bouncing', async ({ page }) => {
  await openHarness(page);

  const initialMetrics = await page.evaluate(() => window.streamHarness.metrics());
  await page.evaluate(() => window.streamHarness.start());
  await expect
    .poll(async () => {
      const metrics = await page.evaluate(() => window.streamHarness.metrics());
      return metrics.frameSamples - initialMetrics.frameSamples >= 100 && metrics.tick - initialMetrics.tick >= 24;
    })
    .toBe(true);
  await page.evaluate(() => window.streamHarness.stop());

  const metrics = await page.evaluate(() => window.streamHarness.metrics());
  expect(metrics.frameSamples).toBeGreaterThan(100);
  expect({
    remountEvents: metrics.remountEvents,
    offBottomFramesUnderTwoPercent: metrics.bounceFrames <= metrics.frameSamples * 0.02,
    maxBounceWithinOneTextLine: metrics.maxBounce <= 20,
    settled: (await page.evaluate(() => window.streamHarness.state())).distanceFromBottom
  }).toEqual({
    remountEvents: 0,
    offBottomFramesUnderTwoPercent: true,
    maxBounceWithinOneTextLine: true,
    settled: 0
  });
});

test('a reader scrolled up mid-history is not dragged or shifted by streaming appends', async ({ page }) => {
  await openHarness(page);

  await page.evaluate(() => window.streamHarness.scrollUpBy(600));
  await page.waitForTimeout(120);
  await page.evaluate(() => window.streamHarness.anchor());

  const initialTick = await page.evaluate(() => window.streamHarness.metrics().tick);
  await page.evaluate(() => window.streamHarness.start());
  await expect
    .poll(async () => (await page.evaluate(() => window.streamHarness.metrics().tick)) - initialTick)
    .toBeGreaterThanOrEqual(24);
  await page.evaluate(() => window.streamHarness.stop());

  const drift = await page.evaluate(() => window.streamHarness.anchorDrift());
  expect(Math.abs(drift)).toBeLessThanOrEqual(2);
});
