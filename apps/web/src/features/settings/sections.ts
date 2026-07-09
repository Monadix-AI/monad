export type SettingsSectionId = 'connection' | 'profile' | 'experience' | 'mo' | 'licenses' | 'system';

const SETTINGS_SECTION_IDS = ['connection', 'profile', 'experience', 'mo', 'licenses', 'system'] as const;

const SETTINGS_SECTION_ID_SET = new Set<string>(SETTINGS_SECTION_IDS);

function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTION_ID_SET.has(value);
}

export function normalizeSettingsSection(value: string | null | undefined): SettingsSectionId {
  if (value === 'appearance' || value === 'composer' || value === 'language') return 'experience';
  if (value === 'import') return 'system';
  return value && isSettingsSectionId(value) ? value : 'connection';
}
