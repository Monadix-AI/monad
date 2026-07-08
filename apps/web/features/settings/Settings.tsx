'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';

import dynamic from 'next/dynamic';
import { type ComponentType, type PointerEvent as ReactPointerEvent, useCallback, useRef } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelLoading } from '@/components/PanelLoading';
import { PanelShell, PanelShellBreadcrumbHeader } from '@/components/ui/panel-shell';
import { ConnectionSettings } from './ConnectionSettings';
import { normalizeSettingsSection, type SettingsSectionId } from './sections';

const ProfileSettings = dynamic(() => import('./ProfileSettings').then((m) => m.ProfileSettings), {
  loading: PanelLoading
});
const AppearanceSettings = dynamic(() => import('./AppearanceSettings').then((m) => m.AppearanceSettings), {
  loading: PanelLoading
});
const MoSettings = dynamic(() => import('./MoSettings').then((m) => m.MoSettings), { loading: PanelLoading });
const LicensesSettings = dynamic(() => import('./Licenses').then((m) => m.LicensesSettings), {
  loading: PanelLoading
});
const SystemSettings = dynamic(() => import('./SystemSettings').then((m) => m.SystemSettings), {
  loading: PanelLoading
});

const SECTION_LABEL_KEYS: Record<SettingsSectionId, WebMessageIdWithoutParams> = {
  connection: 'web.settings.connection',
  experience: 'web.settings.appearance',
  licenses: 'web.settings.licenses',
  mo: 'web.settings.mo',
  profile: 'web.settings.profile',
  system: 'web.settings.system'
};

function normalizeSection(value: string | null | undefined): SettingsSectionId {
  return normalizeSettingsSection(value);
}

const SECTION_PANELS: Record<SettingsSectionId, ComponentType> = {
  connection: ConnectionSettings,
  experience: AppearanceSettings,
  licenses: LicensesSettings,
  mo: MoSettings,
  profile: ProfileSettings,
  system: SystemSettings
};

const SWIPE_BACK_MIN_DISTANCE = 90;
const SWIPE_BACK_MAX_VERTICAL_DRIFT = 70;

export function Settings({ onClose, initialSection }: { initialSection: string | null; onClose: () => void }) {
  const t = useT();
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const section = normalizeSection(initialSection);
  const Panel = SECTION_PANELS[section];
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    swipeStartRef.current = { x: event.clientX, y: event.clientY };
  }, []);
  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = Math.abs(event.clientY - start.y);
      if (dx >= SWIPE_BACK_MIN_DISTANCE && dy <= SWIPE_BACK_MAX_VERTICAL_DRIFT) onClose();
    },
    [onClose]
  );

  return (
    <PanelShell>
      <PanelShellBreadcrumbHeader
        crumbs={[
          { id: 'settings', label: t('web.settings.title') },
          { id: 'current', label: t(SECTION_LABEL_KEYS[section]) }
        ]}
      />
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
        onPointerCancel={() => {
          swipeStartRef.current = null;
        }}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
      >
        <Panel />
      </div>
    </PanelShell>
  );
}
