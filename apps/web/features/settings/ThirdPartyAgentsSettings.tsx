'use client';

import type { ReactNode } from 'react';

import { Button, ScrollArea, Switch } from '@monad/ui';
import { Bot, MonitorPlay, RefreshCw } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelShell } from '@/components/ui/panel-shell';
import { studioDetailPath, studioPath, studioSubpathFromPathname } from '@/features/routes/route-paths';
import { StudioBreadcrumbHeader } from '@/features/studio/StudioBreadcrumbHeader';
import { AcpAgentsSettings } from './AcpAgentsSettings';
import { NativeCliAgentsSettings } from './NativeCliAgentsSettings';

export function ThirdPartyAgentsSettings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const pathname = usePathname();
  const router = useRouter();
  const mode = studioSubpathFromPathname(pathname)[0];
  const [acpEnabled, setAcpEnabled] = useState(true);
  const [cliEnabled, setCliEnabled] = useState(true);

  if (mode === 'acp' || mode === 'cli') {
    const isAcp = mode === 'acp';
    return (
      <PanelShell>
        <StudioBreadcrumbHeader
          backHref={studioPath('thirdPartyAgents')}
          icon={isAcp ? <Bot className="size-4" /> : <MonitorPlay className="size-4" />}
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
        icon={<Bot className="size-4" />}
        title={t('web.thirdPartyAgents.title')}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 p-5">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-3">
            <ModeCard
              checked={acpEnabled}
              description={t('web.thirdPartyAgents.acpModeHint')}
              icon={<Bot className="size-4" />}
              label={t('web.thirdPartyAgents.acpMode')}
              onCheckedChange={setAcpEnabled}
              onOpen={() => router.replace(studioDetailPath('thirdPartyAgents', 'acp'))}
            />
            <ModeCard
              checked={cliEnabled}
              description={t('web.thirdPartyAgents.cliModeHint')}
              icon={<MonitorPlay className="size-4" />}
              label={t('web.thirdPartyAgents.cliMode')}
              onCheckedChange={setCliEnabled}
              onOpen={() => router.replace(studioDetailPath('thirdPartyAgents', 'cli'))}
            />
          </div>

          {acpEnabled || cliEnabled ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,30rem),1fr))] items-start gap-4">
              {acpEnabled ? (
                <section className="min-h-[34rem] overflow-hidden rounded-lg border bg-card">
                  <AcpAgentsSettings onClose={onClose} />
                </section>
              ) : null}
              {cliEnabled ? (
                <section className="min-h-[34rem] overflow-hidden rounded-lg border bg-card">
                  <NativeCliAgentsSettings onClose={onClose} />
                </section>
              ) : null}
            </div>
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-center">
              <p className="max-w-md text-muted-foreground text-sm">{t('web.thirdPartyAgents.emptyModes')}</p>
              <Button
                onClick={() => {
                  setAcpEnabled(true);
                  setCliEnabled(true);
                }}
                size="sm"
                variant="secondary"
              >
                <RefreshCw />
                {t('web.thirdPartyAgents.restoreModes')}
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </PanelShell>
  );
}

function ModeCard({
  checked,
  description,
  icon,
  label,
  onCheckedChange,
  onOpen
}: {
  checked: boolean;
  description: string;
  icon: ReactNode;
  label: string;
  onCheckedChange: (checked: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex min-h-28 items-start gap-3 rounded-lg border bg-card p-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-md border bg-background text-muted-foreground">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium text-sm">{label}</h3>
          <Switch
            aria-label={label}
            checked={checked}
            onCheckedChange={onCheckedChange}
          />
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
        <Button
          className="mt-2 self-start"
          onClick={onOpen}
          size="sm"
          variant="secondary"
        >
          {label}
        </Button>
      </div>
    </div>
  );
}
