import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('shell navigation uses synchronous shell URL helpers for programmatic navigation', () => {
  const source = readFileSync(join(import.meta.dir, '../../features/shell/routing/navigation.ts'), 'utf8');

  expect(source).toContain("from '#/hooks/use-shell-location'");
  expect(source).toContain('pushShellUrl(nextUrl)');
  expect(source).toContain('replaceShellUrl(nextUrl)');
});

test('ShellLink renders through Next Link', () => {
  const source = readFileSync(join(import.meta.dir, '../../components/ShellLink.tsx'), 'utf8');

  expect(source).toContain("from 'next/link'");
  expect(source).toContain('<Link');
});

test('workspace sidebar primary navigation items expose hrefs', () => {
  const workspaceSource = readFileSync(
    join(import.meta.dir, '../../features/shell/sidebar/workspace-items.tsx'),
    'utf8'
  );
  const studioSource = readFileSync(join(import.meta.dir, '../../features/shell/sidebar/studio-items.tsx'), 'utf8');
  const settingsSource = readFileSync(join(import.meta.dir, '../../features/shell/sidebar/settings-items.tsx'), 'utf8');

  expect(workspaceSource).toContain('projectSessionPath(project.id,');
  expect(workspaceSource).toContain('projectPath(project.id)');
  expect(workspaceSource).toContain('href="/');
  expect(studioSource).toContain('href={disabled ? undefined : studioPath(id)}');
  expect(settingsSource).toContain('href={settingsPath(id)}');
});
