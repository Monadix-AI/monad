import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readSource = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('settings exposes a user profile panel for display name and avatar upload', () => {
  const settings = readSource('features/settings/Settings.tsx');
  const profileSettings = readSource('features/settings/ProfileSettings.tsx');

  expect(settings).toContain("'profile'");
  expect(settings).toContain('ProfileSettings');
  expect(settings).toContain('web.settings.profile');
  expect(profileSettings).toContain('useGetProfileSettingsQuery');
  expect(profileSettings).toContain('useSetProfileSettingsMutation');
  expect(profileSettings).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
  expect(profileSettings).toContain('web.settings.profile.displayName');
  expect(profileSettings).toContain('web.settings.profile.avatar');
});
