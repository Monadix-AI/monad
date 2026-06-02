import { expect, type Page, test } from '@playwright/test';

/**
 * Reading history while the session stays live: rows keep appending at the bottom as the reader
 * scrolls up. Each append re-anchors the end-anchored virtualizer; if that anchor math runs on a
 * stale cached scroll offset mid-gesture, the absolute write swallows the frame's scroll input —
 * on screen the content lurches and snaps back. The recorder measures painted frame-to-frame
 * displacement of the anchored row against the scroll input actually applied.
 */

const HARNESS = '/test/e2e/fixtures/virtual-list.html';

async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.locator('[role="log"] [data-index]').first().waitFor();
  await expect.poll(async () => (await page.evaluate(() => window.harness.state())).distanceFromBottom).toBe(0);
}

test('appends landing mid-scroll do not swallow or revert the gesture', async ({ page }) => {
  await openHarness(page);

  const worst = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const scroller = document.querySelector<HTMLElement>('[role="log"]');
        if (!scroller) {
          resolve(Number.NaN);
          return;
        }
        let worstDev = 0;
        let applied = 0;
        let prev: { key: string; top: number } | null = null;
        let frames = 0;
        const appender = window.setInterval(() => window.harness.appendRow(), 90);
        const driver = window.setInterval(() => {
          if (scroller.scrollTop <= 600) return;
          const before = scroller.scrollTop;
          scroller.scrollBy({ top: -170, behavior: 'instant' as ScrollBehavior });
          applied += before - scroller.scrollTop;
        }, 24);
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
          if (cur && prev && cur.key === prev.key) {
            worstDev = Math.max(worstDev, Math.abs(cur.top - prev.top - appliedSince));
          }
          prev = cur;
          if (frames < 200 && scroller.scrollTop > 600) requestAnimationFrame(sample);
          else {
            window.clearInterval(driver);
            window.clearInterval(appender);
            resolve(worstDev);
          }
        };
        requestAnimationFrame(sample);
      })
  );

  expect(worst).toBeLessThanOrEqual(20);
});
