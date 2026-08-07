import { expect, type Page, test } from '@playwright/test';

/**
 * A SMALL wheel nudge — one that leaves the viewport still inside the positional at-end window —
 * must detach exactly like a large one. Position cannot carry the intent here: after the nudge the
 * distance-from-bottom is under every pin threshold, so any pin gated on position alone re-arms on
 * the next evaluate and drags the reader back on the next append. The detach must be sticky until
 * the reader scrolls DOWN onto the live edge again.
 */

const HARNESS = '/test/e2e/fixtures/virtual-list.html';

async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.locator('[role="log"] [data-index]').first().waitFor();
  await expect.poll(async () => (await page.evaluate(() => window.harness.state())).distanceFromBottom).toBe(0);
}

const read = (page: Page) =>
  page.evaluate(() => {
    const s = document.querySelector<HTMLElement>('[role="log"]');
    return s
      ? { top: Math.round(s.scrollTop), dist: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) }
      : { top: 0, dist: 0 };
  });

test('a nudge inside the at-end window holds against appends until the reader returns to the bottom', async ({
  page
}) => {
  await openHarness(page);

  // One small wheel step: lands ~24px off the bottom — inside the 32px at-end window and the 80px
  // pin window, where a positional gate would immediately re-arm following.
  await page.locator('[role="log"]').hover();
  await page.mouse.wheel(0, -24);
  await expect.poll(async () => (await read(page)).dist).toBeGreaterThan(4);
  const nudged = await read(page);

  // Appends begin only after the nudge settled, so every growth tick tests the sticky detach.
  await page.evaluate(() => {
    (window as unknown as { __a: number }).__a = window.setInterval(() => window.harness.appendRow(), 60);
  });
  let maxTop = nudged.top;
  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(60);
    maxTop = Math.max(maxTop, (await read(page)).top);
  }
  const grown = await read(page);
  expect(maxTop).toBeLessThanOrEqual(nudged.top + 4); // appends never dragged the viewport back down
  expect(grown.dist).toBeGreaterThan(nudged.dist); // the gap only widened as content grew

  // Scrolling DOWN into the at-end window re-attaches: following resumes and the next appends land
  // with the viewport pinned. Wheel steps, as a real return gesture — the stream keeps growing the
  // content underneath, so the gesture chases the bottom the way a reader would.
  for (let i = 0; i < 40 && (await read(page)).dist > 8; i += 1) {
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(20);
  }
  await expect.poll(async () => (await read(page)).dist, { timeout: 2000 }).toBeLessThanOrEqual(2);
  await page.waitForTimeout(200);
  const following = await read(page);
  expect(following.dist).toBeLessThanOrEqual(2); // appends keep landing with the viewport pinned
  await page.evaluate(() => window.clearInterval((window as unknown as { __a: number }).__a));
});

test('a slow scrollbar drag detaches through cumulative travel and holds against appends', async ({ page }) => {
  await openHarness(page);

  // A scrollbar drag emits only scroll events, a few px each — every step below the per-event
  // jitter epsilon. Only their SUM shows the intent.
  await page.evaluate(async () => {
    const s = document.querySelector<HTMLElement>('[role="log"]');
    if (!s) return;
    for (let i = 0; i < 5; i += 1) {
      s.scrollTop -= 3;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
  const dragged = await read(page);
  expect(dragged.dist).toBeGreaterThan(8);

  await page.evaluate(() => {
    (window as unknown as { __b: number }).__b = window.setInterval(() => window.harness.appendRow(), 60);
  });
  let maxTop = dragged.top;
  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(60);
    maxTop = Math.max(maxTop, (await read(page)).top);
  }
  const grown = await read(page);
  expect(maxTop).toBeLessThanOrEqual(dragged.top + 4); // appends never dragged the viewport back down
  expect(grown.dist).toBeGreaterThan(dragged.dist); // the gap only widened as content grew
  await page.evaluate(() => window.clearInterval((window as unknown as { __b: number }).__b));
});
