import type { TFunction } from './types';

import { runtimeSectionEnabled } from '#/features/init/init-readiness';
import { studioPath } from '#/features/shell/routing/paths';
import {
  STUDIO_MESH_SECTIONS,
  STUDIO_RUNTIME_SECTIONS,
  STUDIO_SYSTEM_SECTIONS,
  type StudioSectionId,
  type StudioSectionItem
} from '#/features/studio/sections';
import { SidebarNavItem, SidebarNavSection, SidebarNavSectionLabel } from './nav-item';

const STUDIO_SHORTCUT_ITEMS = [...STUDIO_RUNTIME_SECTIONS, ...STUDIO_MESH_SECTIONS, ...STUDIO_SYSTEM_SECTIONS];

export function StudioSidebarItems({
  activeSection,
  onSelect,
  runtimeReady,
  shortcutModifierLabel,
  showShortcutBadges,
  t
}: {
  activeSection: StudioSectionId;
  onSelect: (section: StudioSectionId) => void;
  runtimeReady: boolean;
  shortcutModifierLabel: string;
  t: TFunction;
  showShortcutBadges?: boolean;
}) {
  const shortcutNumbers = new Map(STUDIO_SHORTCUT_ITEMS.slice(0, 9).map((item, index) => [item.id, index + 1]));
  const disabledReason = t('web.studio.runtimeOnboardingRequired');
  const renderItem = ({ id, icon, i18nKey }: StudioSectionItem) => {
    const disabled = !runtimeSectionEnabled(id, runtimeReady);
    return (
      <SidebarNavItem
        active={activeSection === id}
        disabled={disabled}
        disabledReason={disabledReason}
        href={disabled ? undefined : studioPath(id)}
        icon={icon}
        key={id}
        label={t(i18nKey)}
        onClick={() => onSelect(id)}
        shortcutModifierLabel={shortcutModifierLabel}
        shortcutValue={showShortcutBadges && !disabled ? shortcutNumbers.get(id) : undefined}
      />
    );
  };

  return (
    <>
      <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto">
        <SidebarNavSection>
          <SidebarNavSectionLabel>{t('web.studio.agentRuntime')}</SidebarNavSectionLabel>
          {STUDIO_RUNTIME_SECTIONS.map(renderItem)}
        </SidebarNavSection>
        <SidebarNavSection>
          <SidebarNavSectionLabel>{t('web.studio.agentMesh')}</SidebarNavSectionLabel>
          {STUDIO_MESH_SECTIONS.map(renderItem)}
        </SidebarNavSection>
      </div>
      <SidebarNavSection>
        <SidebarNavSectionLabel>{t('web.studio.system')}</SidebarNavSectionLabel>
        {STUDIO_SYSTEM_SECTIONS.map(renderItem)}
      </SidebarNavSection>
    </>
  );
}
