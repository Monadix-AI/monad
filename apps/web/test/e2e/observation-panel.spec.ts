import { expect, type Page, test } from '@playwright/test';

const HARNESS = '/test/e2e/fixtures/observation-panel.html';

type ObservationState = {
  loadCount: number;
  loadedTopRowOffset: number | null;
  loadingHeader: boolean;
  rowCount: number;
  bottomBodyText: string | null;
  scrollTop: number;
  topVisibleRowId: string | null;
};

function state(page: Page): Promise<ObservationState> {
  return page.evaluate(() => window.observationHarness.state());
}

async function openHarness(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await page.goto(HARNESS);
  await page
    .locator('[role="log"] [data-index]')
    .first()
    .waitFor({ timeout: 5000 })
    .catch((error: unknown) => {
      if (errors.length > 0) throw new Error(errors.join('\n\n'));
      throw error;
    });
}

test('the raw list paints a card body verbatim in the real browser', async ({ page }) => {
  await openHarness(page);

  // The SSR/pure-function unit tests cannot see a VirtualList row (rows only mount client-side).
  // Here the real list is scrolled to its newest frame, so the bottom card's preformatted body must
  // be present and carry its provider payload text.
  const current = await state(page);
  expect(current.rowCount).toBeGreaterThan(0);
  expect(current.bottomBodyText ?? '').toContain('Provider-native raw frame body');
});

test('the panel Scroll to top button loads one page, holds the anchor below the start zone, and does not chain', async ({
  page
}) => {
  await openHarness(page);
  expect(await state(page).then((s) => s.loadCount)).toBe(0);

  // Clicking the panel's own button must reach the list's VirtualList scroll control via
  // contentControlRef and fire onLoadOlderEvents once — not zero (forwarding dropped) and not twice
  // (a second trigger source). This is the panel-forwarding + raw-spread wiring the unit tests mask.
  await page.getByRole('button', { name: 'Scroll to top' }).click();
  await expect.poll(async () => (await state(page)).loadingHeader).toBe(true);
  const beforePrepend = await state(page);
  await expect.poll(async () => (await state(page)).loadCount).toBe(1);
  await expect.poll(async () => (await state(page)).loadingHeader).toBe(false);
  // Let TanStack Virtual finish measuring the prepended rows and reconcile its keyed end anchor.
  await page.waitForTimeout(300);

  // The five older rows were inserted above the previously loaded first row. TanStack's keyed end
  // anchor keeps that row at the same viewport offset and moves the scroller clear of the load zone.
  const after = await state(page);
  const anchorDrift = Math.abs((after.loadedTopRowOffset ?? 0) - (beforePrepend.loadedTopRowOffset ?? 0));
  expect({
    anchorStable: anchorDrift <= 8,
    clearedStartZone: after.scrollTop > 240
  }).toEqual({
    anchorStable: true,
    clearedStartZone: true
  });

  // No further gesture: the viewport now sits below the start zone, so the start edge must not
  // chain-load a second page on its own — the runaway-to-oldest bug.
  await page.waitForTimeout(500);
  expect(await state(page).then((s) => s.loadCount)).toBe(1);
});

test('the loading header is shown while an older page is being fetched', async ({ page }) => {
  await openHarness(page);

  await page.getByRole('button', { name: 'Scroll to top' }).click();
  await expect.poll(async () => (await state(page)).loadingHeader).toBe(true);
  await expect(page.locator('[data-events-state="loading"]')).toHaveText('Loading earlier events…');
  await expect.poll(async () => (await state(page)).loadCount).toBe(1);
});

test('a fast scrollbar jump to the loaded top starts loading without a second nudge', async ({ page }) => {
  await openHarness(page);
  expect(await state(page).then((s) => s.loadCount)).toBe(0);

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[role="log"]');
    if (!scroller) return;
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
  });

  await expect.poll(async () => (await state(page)).loadingHeader).toBe(true);
  await expect.poll(async () => (await state(page)).loadCount).toBe(1);
});
