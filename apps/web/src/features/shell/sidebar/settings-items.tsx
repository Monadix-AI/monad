import type { IconSvgElement } from '@hugeicons/react';
import type { SettingsSectionId } from '#/features/settings/sections';
import type { TFunction } from './types';

import {
  ArrowLeft01Icon,
  EyeIcon,
  GlobeIcon,
  JusticeScaleIcon,
  RotateLeft01Icon,
  UserGroupIcon
} from '@hugeicons/core-free-icons';

import { settingsPath } from '#/features/shell/routing/paths';
import { SidebarNavItem, SidebarNavSection, SidebarNavSectionLabel } from './nav-item';
import { SidebarScrollArea } from './scroll-area';

const SETTINGS_SECTION_ITEMS: {
  id: SettingsSectionId;
  icon: IconSvgElement;
  i18nKey:
    | 'web.settings.connection'
    | 'web.settings.profile'
    | 'web.settings.appearance'
    | 'web.settings.licenses'
    | 'web.settings.system';
}[] = [
  { id: 'connection', icon: GlobeIcon, i18nKey: 'web.settings.connection' },
  { id: 'profile', icon: UserGroupIcon, i18nKey: 'web.settings.profile' },
  { id: 'experience', icon: EyeIcon, i18nKey: 'web.settings.appearance' },
  { id: 'licenses', icon: JusticeScaleIcon, i18nKey: 'web.settings.licenses' },
  { id: 'system', icon: RotateLeft01Icon, i18nKey: 'web.settings.system' }
];

export function SettingsSidebarItems({
  activeSection,
  onBack,
  onSelect,
  t
}: {
  activeSection: SettingsSectionId;
  onBack: () => void;
  onSelect: (section: SettingsSectionId) => void;
  t: TFunction;
}) {
  return (
    <>
      <SidebarNavSection>
        <SidebarNavItem
          icon={ArrowLeft01Icon}
          label={t('web.common.back')}
          onClick={onBack}
        />
      </SidebarNavSection>
      <SidebarScrollArea>
        <SidebarNavSection>
          <SidebarNavSectionLabel>{t('web.settings.title')}</SidebarNavSectionLabel>
          {SETTINGS_SECTION_ITEMS.map(({ id, icon, i18nKey }) => (
            <SidebarNavItem
              active={activeSection === id}
              href={settingsPath(id)}
              icon={icon}
              key={id}
              label={t(i18nKey)}
              onClick={() => onSelect(id)}
            />
          ))}
        </SidebarNavSection>
      </SidebarScrollArea>
    </>
  );
}
