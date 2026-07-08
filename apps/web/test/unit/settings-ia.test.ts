import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const settingsSource = readFileSync(join(import.meta.dir, '../../features/settings/Settings.tsx'), 'utf8');
const settingsSectionsSource = readFileSync(join(import.meta.dir, '../../features/settings/sections.ts'), 'utf8');
const appShellSource = readFileSync(join(import.meta.dir, '../../features/shell/AppShell.tsx'), 'utf8');
const sidebarSource = readFileSync(join(import.meta.dir, '../../features/shell/SessionSidebar.tsx'), 'utf8');
const sidebarNavSource = readFileSync(join(import.meta.dir, '../../features/shell/SessionSidebarNav.tsx'), 'utf8');

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
  expect(appShellSource).toContain('settingsPath(normalizeSettingsSection(section))');
  expect(appShellSource).toContain('setSettingsReturnPathState');
  expect(appShellSource).toContain('settingsSectionFromPathname(pathname)');
  expect(appShellSource).not.toContain("useShellSearchParam('returnTo')");
  expect(appShellSource).not.toContain('buildNavigableModalUrl');
});

test('settings mode swaps the shell sidebar list instead of rendering an inner settings nav', () => {
  expect(sidebarSource).toContain('showSettings ?');
  expect(sidebarSource).toContain('<SettingsSidebarItems');
  expect(sidebarNavSource).toContain('function SettingsSidebarItems');
  expect(sidebarNavSource).toContain("label={t('web.common.back')}");
  expect(settingsSource).not.toContain('SettingsNavList');
});
