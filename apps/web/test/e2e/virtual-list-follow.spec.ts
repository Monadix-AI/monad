import { expect, type Page, test } from '@playwright/test';

const HARNESS = '/test/e2e/fixtures/virtual-list.html';

type HarnessState = {
  atBottom: boolean;
  distanceFromBottom: number;
  renderedCount: number;
  scrollHeight: number;
  scrollTop: number;
  topVisibleRowId: string | null;
  topVisibleRowOffset: number | null;
};

async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.locator('[role="log"] [data-index]').first().waitFor();
  await expectSettledAtBottom(page);
}

function state(page: Page): Promise<HarnessState> {
  return page.evaluate(() => window.harness.state());
}

/**
 * Polls rather than sleeps: measurement, the re-pin and the settle loop each take an unpredictable
 * number of frames, so a fixed wait either flakes on a loaded CI runner or hides a real slowdown.
 */
async function expectSettledAtBottom(page: Page): Promise<void> {
  await expect.poll(async () => (await state(page)).distanceFromBottom).toBe(0);
}

/** Wait for the layout to stop moving, for assertions about a viewport that must NOT follow. */
async function waitForStableScrollHeight(page: Page): Promise<void> {
  let previous = -1;
  await expect
    .poll(async () => {
      const { scrollHeight } = await state(page);
      const stable = scrollHeight === previous;
      previous = scrollHeight;
      return stable;
    })
    .toBe(true);
}

/** Scrolling as the user does: a wheel gesture, which is what cancels bottom-following. */
async function wheelBy(page: Page, deltaY: number): Promise<void> {
  await page.locator('[role="log"]').hover();
  await page.mouse.wheel(0, deltaY);
  await waitForStableScrollHeight(page);
}

test('lands on the exact bottom even though rows are far taller than the estimate', async ({ page }) => {
  await openHarness(page);

  const initial = await state(page);
  expect({ distanceFromBottom: initial.distanceFromBottom, atBottom: initial.atBottom }).toEqual({
    distanceFromBottom: 0,
    atBottom: true
  });
  // Virtualized, not fully rendered: an 80-row list of this height must not mount every row.
  expect(initial.renderedCount).toBeLessThan(80);
});

test('a row growing in place keeps the viewport pinned to the bottom', async ({ page }) => {
  await openHarness(page);
  const before = await state(page);

  for (let round = 0; round < 3; round += 1) {
    await page.evaluate(() => window.harness.growLastRow(3));
    await expectSettledAtBottom(page);
  }

  const after = await state(page);
  expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight);
});

test('a row growing outside React (image load, font swap) still keeps the bottom pinned', async ({ page }) => {
  await openHarness(page);
  const before = await state(page);

  await page.evaluate(() => window.harness.growLastRowInDom(500));
  await expectSettledAtBottom(page);

  const after = await state(page);
  expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight);
});

test('appended rows are followed while the reader sits at the bottom', async ({ page }) => {
  await openHarness(page);

  for (let round = 0; round < 3; round += 1) {
    await page.evaluate(() => window.harness.appendRow());
    await expectSettledAtBottom(page);
  }
});

test('scrolling up stops following, and new content no longer drags the viewport', async ({ page }) => {
  await openHarness(page);
  await wheelBy(page, -3000);

  const away = await state(page);
  expect(away.atBottom).toBe(false);
  expect(away.distanceFromBottom).toBeGreaterThan(0);

  await page.evaluate(() => window.harness.appendRow());
  await page.evaluate(() => window.harness.growLastRow(3));
  await waitForStableScrollHeight(page);

  const afterGrowth = await state(page);
  expect(afterGrowth.atBottom).toBe(false);
  expect(afterGrowth.scrollTop).toBe(away.scrollTop);
});

test('jump-to-latest re-arms following, including after a smooth animation', async ({ page }) => {
  await openHarness(page);
  await wheelBy(page, -3000);
  expect(await state(page).then((s) => s.atBottom)).toBe(false);

  // Jumping while content is still arriving: the animation aims at the bottom as it was when it
  // started, so growth during the flight must still be caught once it ends.
  await page.evaluate(async () => {
    window.harness.jumpToLatest('smooth');
    for (let round = 0; round < 6; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      window.harness.growLastRowInDom(600);
    }
  });
  await expectSettledAtBottom(page);
  expect(await state(page).then((s) => s.atBottom)).toBe(true);

  // Following is armed again: later growth must keep the viewport pinned without another jump.
  await page.evaluate(() => window.harness.growLastRow(3));
  await expectSettledAtBottom(page);
});

test('clicking inside a row while content streams does not cancel following', async ({ page }) => {
  await openHarness(page);

  // A press on a row is not scroll intent. If it were treated as such it would clear the
  // self-scroll bookkeeping, and the correction already in flight would land unrecognized and
  // silently unpin the list mid-stream. The press is dispatched rather than clicked because
  // Playwright scrolls an element into view before clicking it — which IS a scroll.
  for (let round = 0; round < 4; round += 1) {
    await page.evaluate(() => {
      window.harness.growLastRowInDom(300);
      const rows = document.querySelectorAll<HTMLElement>('[role="log"] [data-row-id]');
      rows[rows.length - 1]?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      window.harness.growLastRowInDom(300);
    });
    await expectSettledAtBottom(page);
  }

  expect(await state(page).then((s) => s.atBottom)).toBe(true);
});

test('prepending older rows leaves the reader on the same row', async ({ page }) => {
  await openHarness(page);
  await wheelBy(page, -2000);
  const before = await state(page);

  await page.evaluate(() => window.harness.prependRows(5));
  await waitForStableScrollHeight(page);

  const after = await state(page);
  // Same row at the viewport top, at the same offset: the inserted height went above it, and the
  // scroll position absorbed exactly that height instead of the content jumping.
  expect(after.topVisibleRowId).toBe(before.topVisibleRowId);
  expect(Math.abs((after.topVisibleRowOffset ?? 0) - (before.topVisibleRowOffset ?? 0))).toBeLessThanOrEqual(2);
  expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
});

test('scrollToKey brings an off-screen row into view and hands control to the reader', async ({ page }) => {
  await openHarness(page);

  await page.evaluate(() => window.harness.scrollToKey('row_5'));

  await expect(page.locator('[data-row-id="row_5"]')).toBeVisible();
  expect(await state(page).then((s) => s.atBottom)).toBe(false);
});
