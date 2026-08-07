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

test('with content that underfills the viewport the overlay pins to the viewport bottom, not the content end', async ({
  page
}) => {
  await page.goto(`${HARNESS}?rows=2&smallRows=1`);
  const scroller = page.locator('[role="log"]');
  await scroller.locator('[data-index]').first().waitFor();
  await page.evaluate(() => window.harness.setViewportOverlay(true));
  const overlay = scroller.locator('[data-viewport-overlay]');

  const geometry = await overlay.evaluate((element) => {
    const scrollerRect = (element.closest('[role="log"]') as HTMLElement).getBoundingClientRect();
    const rows = [...document.querySelectorAll<HTMLElement>('[role="log"] [data-row-id]')];
    const lastRowBottom = Math.max(...rows.map((row) => row.getBoundingClientRect().bottom));
    const rect = element.getBoundingClientRect();
    return {
      overlayBottomAtViewportBottom: Math.round(scrollerRect.bottom - rect.bottom),
      overlayClearOfContent: rect.bottom - lastRowBottom
    };
  });

  // Anchored to the scroller's bottom edge (not floating at the content end mid-viewport).
  expect(geometry.overlayBottomAtViewportBottom).toBe(0);
  expect(geometry.overlayClearOfContent).toBeGreaterThan(100);
});
