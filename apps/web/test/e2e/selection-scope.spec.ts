import { expect, test } from '@playwright/test';

test('text selection defaults stay inside the Monad app root', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(() => {
    const monadText = document.createElement('div');
    monadText.textContent = 'Monad text';
    monadText.dataset.testid = 'monad-text';
    monadText.style.cssText = 'font-size: 24px; line-height: 32px; width: max-content; white-space: nowrap';
    document.getElementById('root')?.append(monadText);

    const pluginOverlay = document.createElement('div');
    pluginOverlay.textContent = 'Plugin overlay text';
    pluginOverlay.dataset.testid = 'plugin-overlay';
    pluginOverlay.style.cssText = 'font-size: 24px; line-height: 32px; width: max-content; white-space: nowrap';
    document.body.append(pluginOverlay);
  });

  async function dragSelect(testId: string): Promise<string> {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const box = await page.getByTestId(testId).boundingBox();
    if (!box) throw new Error(`Selection target ${testId} has no layout box`);
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    return await page.evaluate(() => window.getSelection()?.toString() ?? '');
  }

  expect({
    monad: await dragSelect('monad-text'),
    pluginOverlay: await dragSelect('plugin-overlay')
  }).toEqual({
    monad: '',
    pluginOverlay: 'Plugin overlay text'
  });
});
