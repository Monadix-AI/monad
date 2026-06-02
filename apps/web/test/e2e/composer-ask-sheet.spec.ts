import { expect, test } from '@playwright/test';

const HARNESS = '/test/e2e/fixtures/composer-ask-sheet.html';

test('selecting an answer enables submission and emits the exact request answer', async ({ page }) => {
  await page.goto(HARNESS);

  const submit = page.getByRole('button', { name: /Submit/ });
  const ship = page.getByRole('button', { name: /Ship/ });
  await expect(submit).toBeDisabled();

  await ship.click();
  await expect(ship).toHaveAttribute('aria-pressed', 'true');
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByRole('status', { name: 'Result' })).toHaveText(
    JSON.stringify({ answer: 'Ship', requestId: 'clarify_1', type: 'answered' })
  );
});

test('multiple selection and custom text produce one ordered answer contract', async ({ page }) => {
  await page.goto(`${HARNESS}?mode=multiple&other=1`);

  const ship = page.getByRole('button', { name: /Ship/ });
  const revise = page.getByRole('button', { name: /Revise/ });
  await ship.click();
  await revise.click();
  await ship.click();
  await page.getByRole('textbox', { name: 'Other answer' }).fill('Custom');
  await page.getByRole('button', { name: /Submit/ }).click();

  await expect(page.getByRole('status', { name: 'Result' })).toHaveText(
    JSON.stringify({ answer: 'Revise | Custom', requestId: 'clarify_1', type: 'answered' })
  );
});

test('number and enter shortcuts select and submit the focused answer', async ({ page }) => {
  await page.goto(HARNESS);
  await page.getByRole('group', { name: 'Proceed?' }).press('2');
  await page.getByRole('group', { name: 'Proceed?' }).press('Enter');

  await expect(page.getByRole('status', { name: 'Result' })).toHaveText(
    JSON.stringify({ answer: 'Revise', requestId: 'clarify_1', type: 'answered' })
  );
});

test('escape dismisses the exact pending request without fabricating an answer', async ({ page }) => {
  await page.goto(HARNESS);
  await page.getByRole('group', { name: 'Proceed?' }).press('Escape');

  await expect(page.getByRole('status', { name: 'Result' })).toHaveText(
    JSON.stringify({ requestId: 'clarify_1', type: 'dismissed' })
  );
});

test('multi-question card preserves drafts and sends all answers only from the final question', async ({ page }) => {
  await page.goto(`${HARNESS}?card=multi`);

  await expect(page.getByRole('button', { name: 'Submit' })).toHaveCount(0);
  await page.getByRole('button', { name: 'All' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('group', { name: 'Targets?' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Result' })).toHaveText('pending');

  await page.getByRole('button', { name: 'Codex' }).click();
  await page.getByRole('textbox', { name: 'Other answer' }).fill('Custom');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Submit' }).click();

  await expect(page.getByRole('status', { name: 'Result' })).toHaveText(
    JSON.stringify({
      answer: JSON.stringify({ scope: 'All', targets: ['Codex', 'Custom'] }),
      requestId: 'clarify_1',
      type: 'answered'
    })
  );
});

test('dismissing any page skips the whole multi-question card', async ({ page }) => {
  await page.goto(`${HARNESS}?card=multi`);
  await page.getByRole('button', { name: 'All' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: /Dismiss/ }).click();

  await expect(page.getByRole('status', { name: 'Result' })).toHaveText(
    JSON.stringify({ requestId: 'clarify_1', type: 'dismissed' })
  );
});
