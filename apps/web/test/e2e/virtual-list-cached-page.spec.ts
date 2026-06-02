import { expect, type Page, test } from '@playwright/test';

/**
 * Scrolling back through history whose pages are already cached must read as one continuous
 * motion. A cached page lands in a microtask mid-gesture and prepends a whole page of
 * mixed-height rows; the reader's anchored row must still travel by exactly the wheel distance —
 * any extra displacement is the per-page jump this spec pins down.
 */

const HARNESS = '/test/e2e/fixtures/virtual-list.html?topPaging=cachedPage&rows=24';
const DRIFT_TOLERANCE_PX = 2;

async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.locator('[role="log"] [data-index]').first().waitFor();
  await expect.poll(async () => (await page.evaluate(() => window.harness.state())).distanceFromBottom).toBe(0);
}

test('late row reflow above the viewport is absorbed during backward scroll', async ({ page }) => {
  await page.goto('/test/e2e/fixtures/virtual-list.html?lateReflow=1');
  await page.locator('[role="log"] [data-index]').first().waitFor();
  await expect.poll(async () => (await page.evaluate(() => window.harness.state())).distanceFromBottom).toBe(0);
  await page.waitForTimeout(300);

  // Travel-per-gesture is the wrong metric here: when several rows above the viewport settle at
  // once, the correct compensation legitimately absorbs most of the gesture. What must never
  // happen is a large between-frame discontinuity: the anchored row teleporting between painted
  // frames while no scroll input was applied in between.
  const maxFrameDiscontinuity = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const scroller = document.querySelector<HTMLElement>('[role="log"]');
        if (!scroller) {
          resolve(Number.NaN);
          return;
        }
        let worst = 0;
        let applied = 0;
        let prev: { key: string; top: number } | null = null;
        let frames = 0;
        const driver = window.setInterval(() => {
          if (scroller.scrollTop <= 0) return;
          const before = scroller.scrollTop;
          scroller.scrollBy({ top: -180, behavior: 'instant' as ScrollBehavior });
          applied += before - scroller.scrollTop;
        }, 32);
        const anchorRow = () => {
          const rows = [...scroller.querySelectorAll<HTMLElement>('[data-row-id]')];
          const mid = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
          const row = rows.find((r) => r.getBoundingClientRect().bottom > mid);
          return row ? { key: row.dataset.rowId ?? '', top: row.getBoundingClientRect().top } : null;
        };
        const sample = () => {
          frames += 1;
          const cur = anchorRow();
          const appliedSince = applied;
          applied = 0;
          // Scrolling up moves the anchored row down the viewport by exactly the applied input;
          // any other between-frame displacement is content teleporting under the reader.
          if (cur && prev && cur.key === prev.key) worst = Math.max(worst, Math.abs(cur.top - prev.top - appliedSince));
          prev = cur;
          if (frames < 160 && scroller.scrollTop > 0) requestAnimationFrame(sample);
          else {
            window.clearInterval(driver);
            resolve(worst);
          }
        };
        requestAnimationFrame(sample);
      })
  );

  expect(maxFrameDiscontinuity).toBeLessThanOrEqual(90);
});

test('cached pages prepending mid-scroll do not jump the content under the reader', async ({ page }) => {
  await openHarness(page);

  const drifts: number[] = [];
  for (let step = 0; step < 30; step += 1) {
    await page.evaluate(() => window.harness.anchor());
    await page.locator('[role="log"]').hover();
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(80);
    const drift = await page.evaluate(() => window.harness.anchorDrift());
    if (!Number.isNaN(drift)) drifts.push(Math.abs(drift - 400));
  }

  const loads = await page.evaluate(() => window.harness.state().topLoadCount);
  expect(loads).toBeGreaterThan(0);
  expect(Math.max(...drifts)).toBeLessThanOrEqual(DRIFT_TOLERANCE_PX);
});
