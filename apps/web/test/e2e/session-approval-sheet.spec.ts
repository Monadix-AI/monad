import { expect, test } from '@playwright/test';

const HARNESS = '/test/e2e/fixtures/session-approval-sheet.html';

test('keyboard approval resolves the oldest request and advances to the next request', async ({ page }) => {
  await page.goto(HARNESS);

  const first = page.getByRole('group', { name: 'Review high-risk tool call: shell' });
  await first.press('Enter');

  await expect(page.getByRole('status', { name: 'Result' })).toHaveText(
    JSON.stringify([{ allow: true, requestId: 'approval-1', scope: 'once' }])
  );
  // presence-ok: resolving the oldest approval advances the queue to the next request.
  await expect(page.getByRole('group', { name: 'Network access' })).toBeVisible();
});

test('escape denies the oldest request and advances to the next request', async ({ page }) => {
  await page.goto(HARNESS);

  const first = page.getByRole('group', { name: 'Review high-risk tool call: shell' });
  await first.press('Escape');

  await expect(page.getByRole('status', { name: 'Result' })).toHaveText(
    JSON.stringify([{ allow: false, requestId: 'approval-1', scope: 'once', reason: 'denied by operator' }])
  );
  // presence-ok: denying the oldest approval advances the queue to the next request.
  await expect(page.getByRole('group', { name: 'Network access' })).toBeVisible();
});

test('remembered approval scopes stay available from the compact action menu', async ({ page }) => {
  await page.goto(HARNESS);

  await page.getByRole('button', { name: 'More approval options' }).click();
  await page.getByRole('menuitem', { name: 'This session' }).click();

  await expect(page.getByRole('status', { name: 'Result' })).toHaveText(
    JSON.stringify([{ allow: true, requestId: 'approval-1', scope: 'session' }])
  );
});
