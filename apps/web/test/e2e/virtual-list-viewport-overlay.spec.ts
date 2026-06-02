import { expect, test } from '@playwright/test';

const HARNESS = '/test/e2e/fixtures/virtual-list.html';

test('viewport overlay stays fixed without changing the scrollable content height', async ({ page }) => {
  await page.goto(HARNESS);
  const scroller = page.locator('[role="log"]');
  await scroller.locator('[data-index]').first().waitFor();
  await expect.poll(() => page.evaluate(() => window.harness.state().distanceFromBottom)).toBe(0);

  const before = await scroller.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop
  }));
  await page.evaluate(() => window.harness.setViewportOverlay(true));
  const overlay = scroller.locator('[data-viewport-overlay]');

  // presence-ok: enabling the viewport overlay mounts it inside the scroll element.
  await expect(overlay).toHaveCount(1);
  const mounted = await scroller.evaluate((element) => ({
    containsOverlay: element.contains(element.querySelector('[data-viewport-overlay]')),
    scrollHeight: element.scrollHeight
  }));

  const positionBeforeScroll = await overlay.evaluate((element) => element.getBoundingClientRect().top);
  await scroller.evaluate((element) => {
    element.scrollTop -= 1200;
    element.dispatchEvent(new Event('scroll'));
  });
  const positionAfterScroll = await overlay.evaluate((element) => element.getBoundingClientRect().top);

  expect({
    containsOverlay: mounted.containsOverlay,
    overlayTopDrift: Math.round(positionAfterScroll - positionBeforeScroll),
    scrollHeightDelta: mounted.scrollHeight - before.scrollHeight,
    scrolledUp: (await scroller.evaluate((element) => element.scrollTop)) < before.scrollTop
  }).toEqual({
    containsOverlay: true,
    overlayTopDrift: 0,
    scrollHeightDelta: 0,
    scrolledUp: true
  });
});
