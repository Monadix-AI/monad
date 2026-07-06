'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';

import {
  CatIcon,
  EyeIcon,
  FileInputIcon,
  GlobeIcon,
  JusticeScaleIcon,
  LanguageSquareIcon,
  RotateLeft01Icon,
  SlidersHorizontalIcon,
  UserGroupIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@monad/ui';
import dynamic from 'next/dynamic';
import { type ComponentType, memo, useCallback, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelLoading } from '@/components/PanelLoading';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ConnectionSettings } from './ConnectionSettings';

const LanguageSettings = dynamic(() => import('./LanguageSettings').then((m) => m.LanguageSettings), {
  loading: PanelLoading
});
const ProfileSettings = dynamic(() => import('./ProfileSettings').then((m) => m.ProfileSettings), {
  loading: PanelLoading
});
const AppearanceSettings = dynamic(() => import('./AppearanceSettings').then((m) => m.AppearanceSettings), {
  loading: PanelLoading
});
const ComposerSettings = dynamic(() => import('./ComposerSettings').then((m) => m.ComposerSettings), {
  loading: PanelLoading
});
const MoSettings = dynamic(() => import('./MoSettings').then((m) => m.MoSettings), { loading: PanelLoading });
const LicensesSettings = dynamic(() => import('./Licenses').then((m) => m.LicensesSettings), {
  loading: PanelLoading
});
const SystemSettings = dynamic(() => import('./SystemSettings').then((m) => m.SystemSettings), {
  loading: PanelLoading
});
const SettingsImport = dynamic(() => import('./SettingsImport').then((m) => m.SettingsImport), {
  loading: PanelLoading
});

export type SettingsSectionId =
  | 'connection'
  | 'profile'
  | 'appearance'
  | 'composer'
  | 'import'
  | 'language'
  | 'mo'
  | 'licenses'
  | 'system';

const SECTIONS: { id: SettingsSectionId; labelKey: WebMessageIdWithoutParams; icon: typeof SlidersHorizontalIcon }[] = [
  { id: 'connection', labelKey: 'web.settings.connection', icon: GlobeIcon },
  { id: 'profile', labelKey: 'web.settings.profile', icon: UserGroupIcon },
  { id: 'appearance', labelKey: 'web.settings.appearance', icon: EyeIcon },
  { id: 'composer', labelKey: 'web.settings.composer', icon: SlidersHorizontalIcon },
  { id: 'import', labelKey: 'web.settings.import', icon: FileInputIcon },
  { id: 'language', labelKey: 'web.settings.language', icon: LanguageSquareIcon },
  { id: 'mo', labelKey: 'web.settings.mo', icon: CatIcon },
  { id: 'licenses', labelKey: 'web.settings.licenses', icon: JusticeScaleIcon },
  { id: 'system', labelKey: 'web.settings.system', icon: RotateLeft01Icon }
];

const SECTION_IDS = new Set<string>(SECTIONS.map((section) => section.id));

function normalizeSection(value: string | null | undefined): SettingsSectionId {
  return SECTION_IDS.has(value ?? '') ? (value as SettingsSectionId) : 'connection';
}

const SettingsPolishStyle = memo(function SettingsPolishStyle() {
  return (
    <style data-impeccable-css="be3934ac">{`
      @scope ([data-impeccable-variant="1"]) {
        :scope .settings-polish-v1 {
          gap: 12px;
          background: color-mix(in srgb, var(--card) 84%, transparent);
        }
        :scope .settings-polish-v1 .settings-polish-a-list {
          gap: 5px;
        }
        :scope .settings-polish-v1 .settings-polish-a-item {
          min-height: 36px;
          padding-inline: 10px;
        }
        :scope .settings-polish-v1 .settings-polish-a-item[data-state='active'] {
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-blue) 18%, transparent);
        }
      }
      @scope ([data-impeccable-variant="2"]) {
        :scope .settings-polish-v2 {
          gap: 8px;
          padding-block: 14px;
        }
        :scope .settings-polish-v2 .settings-polish-a-head {
          padding: 0 8px 8px;
        }
        :scope .settings-polish-v2 .settings-polish-a-title {
          font-size: 18px;
        }
        :scope .settings-polish-v2 .settings-polish-a-summary {
          padding: 4px 0 0;
        }
        :scope .settings-polish-v2 .settings-polish-a-item {
          min-height: 32px;
          border-radius: 7px;
        }
      }
      @scope ([data-impeccable-variant="3"]) {
        :scope .settings-polish-v3 {
          gap: 14px;
        }
        :scope .settings-polish-v3 .settings-polish-a-head {
          padding-top: 0;
        }
        :scope .settings-polish-v3 .settings-polish-a-kicker {
          margin: 4px 0 0;
          color: var(--muted-foreground);
          text-transform: none;
        }
        :scope .settings-polish-v3 .settings-polish-a-list {
          gap: 3px;
        }
        :scope .settings-polish-v3 .settings-polish-a-item {
          min-height: 34px;
        }
        :scope .settings-polish-v3 .settings-polish-a-item[data-state='active'] {
          background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
          border-color: color-mix(in srgb, var(--accent-blue) 22%, var(--border));
        }
      }
    `}</style>
  );
});

const SettingsNavHead = memo(function SettingsNavHead({ title }: { title: string }) {
  const t = useT();
  return (
    <div className="settings-polish-a-head">
      <div className="settings-polish-a-icon">
        <HugeiconsIcon
          className="size-4"
          icon={SlidersHorizontalIcon}
        />
      </div>
      <div className="min-w-0">
        <DialogTitle
          className="settings-polish-a-title"
          id="settings-title"
        >
          {title}
        </DialogTitle>
        <p className="settings-polish-a-kicker">{t('web.settings.localDaemon')}</p>
      </div>
    </div>
  );
});

const SettingsNavList = memo(function SettingsNavList() {
  const t = useT();
  return (
    <TabsList className="settings-polish-a-list h-auto w-full flex-col items-stretch gap-0 rounded-none border-0 bg-transparent p-0">
      {SECTIONS.map(({ id, labelKey, icon: Icon }) => (
        <TabsTrigger
          className="settings-polish-a-item h-auto w-full justify-start rounded-md border-0 bg-transparent text-left shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          data-settings-section={id}
          key={id}
          value={id}
        >
          <span className="settings-polish-a-item-icon">
            <HugeiconsIcon
              className="size-4"
              icon={Icon}
            />
          </span>
          <span className="settings-polish-a-item-label min-w-0 truncate">{t(labelKey)}</span>
        </TabsTrigger>
      ))}
    </TabsList>
  );
});

const SECTION_PANELS: Record<SettingsSectionId, ComponentType<{ onClose: () => void }>> = {
  appearance: AppearanceSettings,
  composer: ComposerSettings,
  connection: ConnectionSettings,
  import: SettingsImport,
  language: LanguageSettings,
  licenses: LicensesSettings,
  mo: MoSettings,
  profile: ProfileSettings,
  system: SystemSettings
};

export function Settings({
  onClose,
  onSectionChange,
  initialSection
}: {
  initialSection: string | null;
  onClose: () => void;
  onSectionChange?: (section: SettingsSectionId) => void;
}) {
  const t = useT();
  const [section, setSection] = useState<SettingsSectionId>(() => normalizeSection(initialSection));
  const [visitedSections, setVisitedSections] = useState<ReadonlySet<SettingsSectionId>>(
    () => new Set([normalizeSection(initialSection)])
  );
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);
  const selectSection = useCallback(
    (nextSection: SettingsSectionId) => {
      setSection(nextSection);
      setVisitedSections((prev) => (prev.has(nextSection) ? prev : new Set(prev).add(nextSection)));
      onSectionChange?.(nextSection);
    },
    [onSectionChange]
  );

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent
        className="flex h-[min(860px,calc(100vh-1.5rem))] min-w-0 max-w-6xl overflow-hidden p-0 sm:max-w-6xl"
        showCloseButton={false}
      >
        <Tabs
          className="h-full min-h-0 w-full flex-row gap-0 overflow-hidden"
          onValueChange={(value) => selectSection(value as SettingsSectionId)}
          orientation="vertical"
          value={section}
        >
          <div className="settings-polish-a settings-polish-v3 panel-nav flex w-56 shrink-0 flex-col px-3 py-4">
            <SettingsNavHead title={t('web.settings.title')} />
            <div className="settings-polish-a-divider" />
            <SettingsNavList />
          </div>
          <SettingsPolishStyle />

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {SECTIONS.filter(({ id }) => visitedSections.has(id)).map(({ id }) => {
              const Panel = SECTION_PANELS[id];
              return (
                <TabsContent
                  className="flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
                  forceMount
                  key={id}
                  value={id}
                >
                  <Panel onClose={handleClose} />
                </TabsContent>
              );
            })}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
