import { expect, type Page, test } from '@playwright/test';

/**
 * A wheel gesture toward the top while the viewport already sits inside the start zone is an
 * explicit request for older rows that produces NO scroll event (scrollTop is clamped at the top),
 * so the scroll-path evaluate can never see it. It must fire the start edge anyway — it is the
 * retry gesture after a failed page load left the edge disarmed, and the only possible request
 * while the content does not overflow the viewport yet.
 */

const HARNESS = '/test/e2e/fixtures/virtual-list.html';

async function state(page: Page) {
  return await page.evaluate(() => window.harness.state());
}

async function wheelUp(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[role="log"]');
    scroller?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -30 }));
  });
}

async function firstRowId(page: Page): Promise<string | null> {
  return await page.evaluate(
    () => document.querySelector<HTMLElement>('[role="log"] [data-row-id]')?.dataset.rowId ?? null
  );
}

test('content that underfills the viewport pages older rows on a wheel-up gesture', async ({ page }) => {
  await page.goto(`${HARNESS}?topPaging=1&rows=2&smallRows=1`);
  await page.locator('[role="log"] [data-index]').first().waitFor();

  // Nothing overflows, so nothing loads on its own — the reader has not asked for history yet.
  await page.waitForTimeout(300);
  expect(await state(page).then((value) => value.topLoadCount)).toBe(0);

  await wheelUp(page);
  await expect.poll(async () => (await state(page)).topLoadCount).toBe(1);
  await expect.poll(async () => firstRowId(page)).toBe('row_-1');

  // The landed page must not chain another request while the reader stays put.
  await page.waitForTimeout(400);
  expect(await state(page).then((value) => value.topLoadCount)).toBe(1);

  await wheelUp(page);
  await expect.poll(async () => (await state(page)).topLoadCount).toBe(2);
  await expect.poll(async () => firstRowId(page)).toBe('row_-2');
});

test('a failed page load is retried by wheeling up at the loaded top', async ({ page }) => {
  await page.goto(`${HARNESS}?topPaging=1&failFirstTopLoad=1`);
  await page.locator('[role="log"] [data-index]').first().waitFor();
  await expect.poll(async () => (await state(page)).distanceFromBottom).toBe(0);

  await page.evaluate(() => window.harness.jumpToLoadedTop());
  await expect.poll(async () => (await state(page)).topLoadCount).toBe(1);
  await expect.poll(async () => (await state(page)).topLoading).toBe(false);

  // The attempt consumed the armed edge and delivered nothing: the reader is still parked at the
  // loaded top, where no further scroll event can ever fire the edge again.
  const stalled = await state(page);
  expect({ scrollTop: stalled.scrollTop, firstRow: await firstRowId(page) }).toEqual({
    scrollTop: 0,
    firstRow: 'row_0'
  });

  await wheelUp(page);
  await expect.poll(async () => (await state(page)).topLoadCount).toBe(2);
  await expect.poll(async () => firstRowId(page)).toBe('row_-1');
});

test('a keyboard press at the loaded top re-arms the start edge, same as wheel-up', async ({ page }) => {
  await page.goto(`${HARNESS}?topPaging=1&rows=2&smallRows=1`);
  await page.locator('[role="log"] [data-index]').first().waitFor();

  expect(await state(page).then((value) => value.topLoadCount)).toBe(0);
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[role="log"]');
    scroller?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }));
  });
  await expect.poll(async () => (await state(page)).topLoadCount).toBe(1);
  await expect.poll(async () => firstRowId(page)).toBe('row_-1');
});

test('a touch tap at the loaded top re-arms the start edge, same as wheel-up', async ({ page }) => {
  await page.goto(`${HARNESS}?topPaging=1&rows=2&smallRows=1`);
  await page.locator('[role="log"] [data-index]').first().waitFor();

  expect(await state(page).then((value) => value.topLoadCount)).toBe(0);
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[role="log"]');
    scroller?.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
  });
  await expect.poll(async () => (await state(page)).topLoadCount).toBe(1);
  await expect.poll(async () => firstRowId(page)).toBe('row_-1');
});

test('the opening bottom settle is not disturbed by an arming attempt before the list has ever reached the end', async ({
  page
}) => {
  await page.goto(`${HARNESS}?topPaging=1&settleOnLoad=1`);
  // Before the first layout settles, the scroller can legitimately sit at scrollTop 0 — a wheel-up
  // there must not fire a page load and steal the opening convergence to the newest message.
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[role="log"]');
    scroller?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -30 }));
  });
  await expect.poll(async () => (await state(page)).distanceFromBottom).toBe(0);
  expect(await state(page).then((value) => value.topLoadCount)).toBe(0);
});
