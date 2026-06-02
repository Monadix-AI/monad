'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';

import { Button, cn } from '@monad/ui';
import { Cat, FileInput, Globe, Languages, RefreshCcw, Scale, SlidersHorizontal } from 'lucide-react';
import dynamic from 'next/dynamic';

import { useT } from '@/components/I18nProvider';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useNavigableModal } from '@/hooks/use-navigable-modal';

const ConnectionSettings = dynamic(() => import('./ConnectionSettings').then((m) => m.ConnectionSettings), {
  ssr: false
});
const LanguageSettings = dynamic(() => import('./LanguageSettings').then((m) => m.LanguageSettings), { ssr: false });
const MoSettings = dynamic(() => import('./MoSettings').then((m) => m.MoSettings), { ssr: false });
const LicensesSettings = dynamic(() => import('./LicensesSettings').then((m) => m.LicensesSettings), { ssr: false });
const SystemSettings = dynamic(() => import('./SystemSettings').then((m) => m.SystemSettings), { ssr: false });
const SettingsImport = dynamic(() => import('./SettingsImport').then((m) => m.SettingsImport), { ssr: false });

type SectionId = 'connection' | 'import' | 'language' | 'mo' | 'licenses' | 'system';

const SECTIONS: { id: SectionId; labelKey: WebMessageIdWithoutParams; icon: typeof SlidersHorizontal }[] = [
  { id: 'connection', labelKey: 'web.settings.connection', icon: Globe },
  { id: 'import', labelKey: 'web.settings.import', icon: FileInput },
  { id: 'language', labelKey: 'web.settings.language', icon: Languages },
  { id: 'mo', labelKey: 'web.settings.mo', icon: Cat },
  { id: 'licenses', labelKey: 'web.settings.licenses', icon: Scale },
  { id: 'system', labelKey: 'web.settings.system', icon: RefreshCcw }
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
        <nav className="panel-nav flex w-56 shrink-0 flex-col gap-1 px-3 py-4">
          <div className="mb-2 px-2 pr-8">
            <p className="panel-kicker mb-3">{t('web.settings.title')}</p>
            <div className="flex items-center gap-2 text-muted-foreground">
              <SlidersHorizontal className="size-4" />
              <DialogTitle
                className="poster-heading text-[1.6rem] text-foreground"
                id="settings-title"
              >
                {t('web.settings.title')}
              </DialogTitle>
            </div>
          </div>
          <div className="mb-2 px-2 pr-8 text-[11px] text-muted-foreground">{t('web.settings.summary')}</div>
          <div className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground">
            <SlidersHorizontal className="size-4" />
            <span className="label-mono">{t('web.settings.title')}</span>
          </div>
          {SECTIONS.map(({ id, labelKey, icon: Icon }) => (
            <Button
              className={cn('justify-start gap-2 rounded-(--radius-lg) px-3 py-2 text-left')}
              data-active={section === id}
              key={id}
              onClick={() => setTab(id)}
              size="sm"
              variant={section === id ? 'secondary' : 'ghost'}
            >
              <Icon className="size-4" />
              {t(labelKey)}
            </Button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {section === 'language' ? (
            <LanguageSettings onClose={onClose} />
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
