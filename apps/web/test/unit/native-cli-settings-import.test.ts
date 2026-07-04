import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(import.meta.dir, '..', '..', 'features', 'studio', 'third-party-agents', 'NativeCliAgentsSettings.tsx'),
  'utf8'
);

test('native CLI settings page exposes adapter-backed settings import UI', () => {
  expect(source).toContain('useListNativeCliSettingsImportCandidatesQuery');
  expect(source).toContain('usePreviewNativeCliSettingsImportMutation');
  expect(source).toContain('useApplyNativeCliSettingsImportMutation');
  expect(source).toContain('p.capabilities?.settingsImport === true');
  expect(source).toContain('selectedCandidateSources');
  expect(source).toContain('sources: selectedCandidateSources');
  expect(source).toContain("t('web.nativeCli.importSettings')");
});
