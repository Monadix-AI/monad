import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('project title only toggles its expanded state and is not a route link', () => {
  const source = readFileSync(
    join(import.meta.dir, '../../src/features/shell/sidebar/workspace-project-rows.tsx'),
    'utf8'
  );
  const projectRow = source.slice(
    source.indexOf('export function ProjectTreeRow'),
    source.indexOf('export function ProjectSessionTreeRow')
  );

  expect(projectRow).toContain('onToggleProjectExpanded(project.id)');
  expect(projectRow).not.toContain('actions.openProject(project.id)');
  expect(projectRow).not.toContain('href={projectPath(project.id)}');
  expect(projectRow).not.toContain('editableOnDoubleClick');
});

test('button-based project rows preserve the inline rename editor', () => {
  const source = readFileSync(
    join(import.meta.dir, '../../src/features/shell/sidebar/workspace-tree-item.tsx'),
    'utf8'
  );
  const buttonBranch = source.slice(source.indexOf(') : ('), source.indexOf('{actions}'));

  expect(buttonBranch).toContain('<SidebarEditableTitle');
});

test('the app shell does not load a local development preview script', async () => {
  const html = await Bun.file(new URL('../../index.html', import.meta.url)).text();

  expect(html).not.toContain('localhost:8402');
  expect(html).not.toContain('impeccable-live');
});
