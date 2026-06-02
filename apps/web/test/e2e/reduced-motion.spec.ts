import { expect, test } from '@playwright/test';

test('logic E2E completes interactions without waiting for decorative motion', async ({ page }) => {
  await page.goto('/test/e2e/fixtures/reduced-motion.html');
  await page.getByRole('button', { name: 'Run action' }).click();

  expect(
    await page.evaluate(() => ({
      actionResult: document.querySelector('output')?.textContent,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches
    }))
  ).toEqual({
    actionResult: 'completed',
    reducedMotion: true
  });
});
