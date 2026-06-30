import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('developer mode toggle lives in the project top bar, not the project header variant group', async () => {
  const webRoot = join(import.meta.dir, '../..');
  const [headerSource, topBarSource] = await Promise.all([
    Bun.file(join(webRoot, 'features/workplace/project-shell/ProjectHeader.tsx')).text(),
    Bun.file(join(webRoot, 'features/routes/workspace/ProjectTopBar.tsx')).text()
  ]);

  expect(headerSource).not.toContain('setDeveloperModeOpen');
  expect(topBarSource).toContain('setDeveloperModeOpen');
  expect(topBarSource).toContain('ProjectDebugConsole');
  expect(topBarSource).toContain('className="project-topbar-debug"');
});
