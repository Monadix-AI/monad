'use client';

import type { StudioSectionProps } from '@/features/studio/section-registry';

import { BotIcon, MonitorSpeakerIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ScrollArea, Switch } from '@monad/ui';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelShell } from '@/components/ui/panel-shell';
import { studioPath } from '@/features/routes/route-paths';
import { StudioBreadcrumbHeader } from '@/features/studio/StudioBreadcrumbHeader';
import { AcpAgentsSettings } from './AcpAgentsSettings';
import { NativeCliAgentsSettings } from './NativeCliAgentsSettings';

export function ThirdPartyAgentsSettings({ onClose, subpath = [] }: StudioSectionProps) {
  const t = useT();
  const mode = subpath[0];
  const [acpEnabled, setAcpEnabled] = useState(true);

  if (mode === 'acp' || mode === 'cli') {
    const isAcp = mode === 'acp';
    return (
      <PanelShell>
        <StudioBreadcrumbHeader
          backHref={studioPath('thirdPartyAgents')}
          icon={
            isAcp ? (
              <HugeiconsIcon
                className="size-4"
                icon={BotIcon}
              />
            ) : (
              <HugeiconsIcon
                className="size-4"
                icon={MonitorSpeakerIcon}
              />
            )
          }
          parentTitle={t('web.thirdPartyAgents.title')}
          title={isAcp ? t('web.thirdPartyAgents.acpMode') : t('web.thirdPartyAgents.cliMode')}
        />
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto max-w-5xl p-5">
            <section className="min-h-[34rem] overflow-hidden rounded-lg border bg-card">
              {isAcp ? <AcpAgentsSettings onClose={onClose} /> : <NativeCliAgentsSettings onClose={onClose} />}
            </section>
          </div>
        </ScrollArea>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <StudioBreadcrumbHeader
        icon={
          <HugeiconsIcon
            className="size-4"
            icon={BotIcon}
          />
        }
        showSubtitle={false}
        title={t('web.thirdPartyAgents.title')}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 p-5">
          <section className="overflow-hidden rounded-lg border bg-card">
            <div className="flex min-h-12 items-center gap-3 border-b bg-muted/20 px-4">
              <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
                <HugeiconsIcon
                  className="size-4"
                  icon={BotIcon}
                />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="font-medium text-sm">{t('web.thirdPartyAgents.acpMode')}</h3>
                <p className="truncate text-muted-foreground text-xs">{t('web.thirdPartyAgents.acpModeHint')}</p>
              </div>
              <Switch
                aria-label={t('web.thirdPartyAgents.acpMode')}
                checked={acpEnabled}
                onCheckedChange={setAcpEnabled}
              />
            </div>
            {acpEnabled ? (
              <AcpAgentsSettings
                embedded
                onClose={onClose}
              />
            ) : (
              <div className="flex min-h-40 items-center justify-center px-4 text-center text-muted-foreground text-sm">
                {t('web.thirdPartyAgents.acpModeHint')}
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-lg border bg-card">
            <div className="flex min-h-12 items-center gap-3 border-b bg-muted/20 px-4">
              <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
                <HugeiconsIcon
                  className="size-4"
                  icon={MonitorSpeakerIcon}
                />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="font-medium text-sm">{t('web.thirdPartyAgents.cliMode')}</h3>
                <p className="truncate text-muted-foreground text-xs">{t('web.thirdPartyAgents.cliModeHint')}</p>
              </div>
            </div>
            <NativeCliAgentsSettings
              embedded
              onClose={onClose}
            />
          </section>
        </div>
      </ScrollArea>
    </PanelShell>
  );
}
