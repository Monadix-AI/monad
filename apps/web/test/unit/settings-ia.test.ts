import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const settingsSource = readFileSync(join(import.meta.dir, '../../features/settings/Settings.tsx'), 'utf8');
const settingsSectionsSource = readFileSync(join(import.meta.dir, '../../features/settings/sections.ts'), 'utf8');
const shellProviderSource = readFileSync(
  join(import.meta.dir, '../../features/shell/page-shell/ShellRouteProvider.tsx'),
  'utf8'
);
const shellNavigationSource = readFileSync(join(import.meta.dir, '../../features/shell/routing/navigation.ts'), 'utf8');
const shellRouteSource = readFileSync(join(import.meta.dir, '../../features/shell/routing/use-shell-route.ts'), 'utf8');
const sidebarSource = readFileSync(join(import.meta.dir, '../../features/shell/SessionSidebar.tsx'), 'utf8');
const settingsSidebarSource = readFileSync(
  join(import.meta.dir, '../../features/shell/sidebar/settings-items.tsx'),
  'utf8'
);

test('settings navigation folds language and composer into experience and removes global import', () => {
  const sectionType = settingsSectionsSource.match(/export type SettingsSectionId = ([^;]+);/)?.[1] ?? '';
  expect(sectionType).toContain("'experience'");
  expect(sectionType).not.toContain("'composer'");
  expect(sectionType).not.toContain("'language'");
  expect(sectionType).not.toContain("'import'");
  expect(settingsSectionsSource).toContain("value === 'appearance' || value === 'composer' || value === 'language'");
  expect(settingsSectionsSource).toContain("if (value === 'import') return 'system'");
  expect(settingsSource).not.toContain('DialogContent');
  expect(settingsSource).not.toContain('TabsTrigger');
});

test('settings route keeps the active section in the pathname', () => {
  expect(shellNavigationSource).toContain('settingsPath(normalizeSettingsSection(section))');
  expect(shellNavigationSource).toContain('setSettingsReturnPathState');
  expect(shellRouteSource).toContain('settingsSectionFromPathname(pathname)');
  expect(shellProviderSource).not.toContain("useShellSearchParam('returnTo')");
  expect(shellProviderSource).not.toContain('buildNavigableModalUrl');
});

test('settings mode swaps the shell sidebar list instead of rendering an inner settings nav', () => {
  expect(sidebarSource).toContain('showSettings ?');
  expect(sidebarSource).toContain('<SettingsSidebarItems');
  expect(settingsSidebarSource).toContain('function SettingsSidebarItems');
  expect(settingsSidebarSource).toContain("label={t('web.common.back')}");
  expect(settingsSource).not.toContain('SettingsNavList');
});
