import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('developer mode toggle lives in the dev tools widget, not the project header bars', async () => {
  const webRoot = join(import.meta.dir, '../..');
  const [headerSource, topBarSource, devToolsSource] = await Promise.all([
    Bun.file(join(webRoot, 'features/workplace/project-shell/ProjectHeader.tsx')).text(),
    Bun.file(join(webRoot, 'features/routes/workspace/ProjectTopBar.tsx')).text(),
    Bun.file(join(webRoot, 'features/shell/DevToolsWidget.tsx')).text()
  ]);

  expect(headerSource).not.toContain('setDeveloperModeOpen');
  expect(topBarSource).not.toContain('setDeveloperModeOpen');
  expect(topBarSource).not.toContain('ProjectDebugConsole');
  expect(topBarSource).not.toContain('project-topbar-debug');
  expect(devToolsSource).toContain('setDeveloperModeOpen');
  expect(devToolsSource).toContain('ProjectDebugConsole');
  expect(devToolsSource).toContain('Developer Mode');
});

test('project top bar workdir updates the workplace project, not a Monad session', async () => {
  const webRoot = join(import.meta.dir, '../..');
  const topBarSource = await Bun.file(join(webRoot, 'features/routes/workspace/ProjectTopBar.tsx')).text();

  expect(topBarSource).toContain('useUpdateWorkplaceProjectMutation');
  expect(topBarSource).not.toContain('useUpdateSessionMutation');
  expect(topBarSource).toContain('updateWorkplaceProject({ id: projectId, cwd: value.trim() })');
});

test('project top bar experience switch does not use a native select', async () => {
  const webRoot = join(import.meta.dir, '../..');
  const topBarSource = await Bun.file(join(webRoot, 'features/routes/workspace/ProjectTopBar.tsx')).text();

  expect(topBarSource).not.toContain('<select');
  expect(topBarSource).not.toContain('project-topbar-select');
  expect(topBarSource).toContain('DropdownMenuItem');
});

test('graphic view does not render the right-side agent tasks rail', async () => {
  const webRoot = join(import.meta.dir, '../..');
  const graphicViewSource = await Bun.file(
    join(webRoot, 'features/workplace/experiences/graphic-view/GraphicViewExperience.tsx')
  ).text();

  expect(graphicViewSource).not.toContain('AgentTasksRail');
});
