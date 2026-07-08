export type SettingsSectionId = 'connection' | 'profile' | 'experience' | 'mo' | 'licenses' | 'system';

const SETTINGS_SECTION_IDS = new Set<string>(['connection', 'profile', 'experience', 'mo', 'licenses', 'system']);

function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTION_IDS.has(value);
}

export function normalizeSettingsSection(value: string | null | undefined): SettingsSectionId {
  if (value === 'appearance' || value === 'composer' || value === 'language') return 'experience';
  if (value === 'import') return 'system';
  return value && isSettingsSectionId(value) ? value : 'connection';
}
