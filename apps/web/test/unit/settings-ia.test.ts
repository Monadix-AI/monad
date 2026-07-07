import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const settingsSource = readFileSync(join(import.meta.dir, '../../features/settings/Settings.tsx'), 'utf8');
const settingsModalHostSource = readFileSync(
  join(import.meta.dir, '../../features/shell/app-shell/settings-modal-host.tsx'),
  'utf8'
);

test('settings navigation folds language and composer into experience and removes global import', () => {
  const sectionType = settingsSource.match(/export type SettingsSectionId = ([^;]+);/)?.[1] ?? '';
  expect(sectionType).toContain("'experience'");
  expect(sectionType).not.toContain("'composer'");
  expect(sectionType).not.toContain("'language'");
  expect(sectionType).not.toContain("'import'");
  expect(settingsSource).toContain("value === 'appearance' || value === 'composer' || value === 'language'");
  expect(settingsSource).toContain("if (value === 'import') return 'system'");
});

test('settings modal keeps the active section in the URL query', () => {
  expect(settingsModalHostSource).toContain('onSectionChange={setSettingsTab}');
});
