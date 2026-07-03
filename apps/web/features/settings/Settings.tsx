'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';

import {
  CatIcon,
  FileInputIcon,
  GlobeIcon,
  JusticeScaleIcon,
  LanguageSquareIcon,
  RotateLeft01Icon,
  SlidersHorizontalIcon,
  UserGroupIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn } from '@monad/ui';
import dynamic from 'next/dynamic';

import { useT } from '@/components/I18nProvider';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useNavigableModal } from '@/hooks/use-navigable-modal';

const ConnectionSettings = dynamic(() => import('./ConnectionSettings').then((m) => m.ConnectionSettings), {
  ssr: false
});
const LanguageSettings = dynamic(() => import('./LanguageSettings').then((m) => m.LanguageSettings), { ssr: false });
const ProfileSettings = dynamic(() => import('./ProfileSettings').then((m) => m.ProfileSettings), { ssr: false });
const MoSettings = dynamic(() => import('./MoSettings').then((m) => m.MoSettings), { ssr: false });
const LicensesSettings = dynamic(() => import('./LicensesSettings').then((m) => m.LicensesSettings), { ssr: false });
const SystemSettings = dynamic(() => import('./SystemSettings').then((m) => m.SystemSettings), { ssr: false });
const SettingsImport = dynamic(() => import('./SettingsImport').then((m) => m.SettingsImport), { ssr: false });

type SectionId = 'connection' | 'profile' | 'import' | 'language' | 'mo' | 'licenses' | 'system';

const SECTIONS: { id: SectionId; labelKey: WebMessageIdWithoutParams; icon: typeof SlidersHorizontalIcon }[] = [
  { id: 'connection', labelKey: 'web.settings.connection', icon: GlobeIcon },
  { id: 'profile', labelKey: 'web.settings.profile', icon: UserGroupIcon },
  { id: 'import', labelKey: 'web.settings.import', icon: FileInputIcon },
  { id: 'language', labelKey: 'web.settings.language', icon: LanguageSquareIcon },
  { id: 'mo', labelKey: 'web.settings.mo', icon: CatIcon },
  { id: 'licenses', labelKey: 'web.settings.licenses', icon: JusticeScaleIcon },
  { id: 'system', labelKey: 'web.settings.system', icon: RotateLeft01Icon }
];

export function Settings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [rawTab, setTab] = useNavigableModal('settings');
  const section: SectionId = (rawTab as SectionId) || 'connection';

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
        <nav
          aria-label={t('web.settings.title')}
          className="settings-polish-a settings-polish-v3 panel-nav flex w-56 shrink-0 flex-col px-3 py-4"
        >
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
                {t('web.settings.title')}
              </DialogTitle>
              <p className="settings-polish-a-kicker">{t('web.settings.localDaemon')}</p>
            </div>
          </div>
          <div className="settings-polish-a-divider" />
          <div className="settings-polish-a-list">
            {SECTIONS.map(({ id, labelKey, icon: Icon }) => (
              <Button
                aria-current={section === id ? 'page' : undefined}
                className={cn('settings-polish-a-item w-full justify-start text-left', section === id && 'is-active')}
                data-active={section === id}
                key={id}
                onClick={() => setTab(id)}
                size="sm"
                variant="ghost"
              >
                <span className="settings-polish-a-item-icon">
                  <HugeiconsIcon
                    className="size-4"
                    icon={Icon}
                  />
                </span>
                <span className="settings-polish-a-item-label min-w-0 truncate">{t(labelKey)}</span>
              </Button>
            ))}
          </div>
        </nav>
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
            :scope .settings-polish-v1 .settings-polish-a-item.is-active {
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
              background: transparent;
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
            :scope .settings-polish-v3 .settings-polish-a-item.is-active {
              background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
              border-color: color-mix(in srgb, var(--accent-blue) 22%, var(--border));
            }
          }
        `}</style>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {section === 'language' ? (
            <LanguageSettings onClose={onClose} />
          ) : section === 'profile' ? (
            <ProfileSettings onClose={onClose} />
          ) : section === 'import' ? (
            <SettingsImport onClose={onClose} />
          ) : section === 'mo' ? (
            <MoSettings onClose={onClose} />
          ) : section === 'licenses' ? (
            <LicensesSettings onClose={onClose} />
          ) : section === 'system' ? (
            <SystemSettings onClose={onClose} />
          ) : (
            <ConnectionSettings onClose={onClose} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
