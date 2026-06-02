import { expect, type Page, test } from '@playwright/test';

/**
 * Reading the last message while the agent keeps streaming: the reader nudges up to re-read a line
 * while tokens are still appending. A follow that re-runs on every append — the library's static
 * followOnAppend, or a pin gated only on distance-from-bottom — drags them back on the next token,
 * because appends keep the distance small no matter how far up they scrolled. The wheel gesture is
 * the one detach signal growth cannot forge; once given, the viewport must hold.
 */

const HARNESS = '/test/e2e/fixtures/virtual-list.html';

async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.locator('[role="log"] [data-index]').first().waitFor();
  await expect.poll(async () => (await page.evaluate(() => window.harness.state())).distanceFromBottom).toBe(0);
}

test('a wheel nudge holds while appends continue below', async ({ page }) => {
  await openHarness(page);

  await page.evaluate(() => {
    (window as unknown as { __a: number }).__a = window.setInterval(() => window.harness.appendRow(), 60);
  });
  await page.waitForTimeout(150);

  const read = () =>
    page.evaluate(() => {
      const s = document.querySelector<HTMLElement>('[role="log"]');
      return s
        ? { top: Math.round(s.scrollTop), dist: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) }
        : { top: 0, dist: 0 };
    });

  await page.locator('[role="log"]').hover();
  // A short burst of wheel steps, as a trackpad flick produces — any one landing is enough to
  // detach; the burst just makes the gesture reliable under a fast append cadence.
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(20);
  }
  await expect.poll(async () => (await read()).dist, { timeout: 2000 }).toBeGreaterThan(250);
  const settled = await read();

  // With appends still arriving, the invariant is: the position the wheel left stays frozen while
  // the distance-from-bottom keeps growing under it. A pin that fought the reader would instead
  // hold the distance small by creeping scrollTop back down.
  let maxTop = settled.top;
  let lastDist = settled.dist;
  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(60);
    const now = await read();
    maxTop = Math.max(maxTop, now.top);
    lastDist = now.dist;
  }

  expect(maxTop).toBeLessThanOrEqual(settled.top + 4); // appends never dragged the viewport back down
  expect(lastDist).toBeGreaterThan(settled.dist); // and the gap only widened as content grew
});
