'use client';

import { Alert01Icon, PlusSignIcon, Refresh01Icon, ScanIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useDiscoverAtomKindsMutation, useListAtomKindsQuery, useListAtomPacksQuery } from '@monad/client-rtk';
import { Badge, Button, cn, ScrollArea } from '@monad/ui';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelShell, PanelShellHeader } from '@/components/ui/panel-shell';
import { AtomPackCard, ConflictRow } from './AtomPackCard';
import { InstallForm } from './InstallForm';

export function AtomsSettings(_props: { onClose: () => void }) {
  const t = useT();
  const { data, isFetching, refetch } = useListAtomPacksQuery();
  const { data: kindsData } = useListAtomKindsQuery();
  const [discover, { isLoading: rescanning }] = useDiscoverAtomKindsMutation();
  const [adding, setAdding] = useState(false);
  const [rescanErrors, setRescanErrors] = useState<{ file: string; error: string }[]>([]);
  const packs = data?.atomPacks ?? [];
  const conflicts = data?.conflicts ?? [];

  const rescan = async () => {
    const res = await discover()
      .unwrap()
      .catch(() => null);
    setRescanErrors(res?.errors ?? []);
  };

  return (
    <PanelShell>
      <PanelShellHeader
        actions={
          <>
            <Button
              aria-label={t('web.atoms.rescan')}
              className="size-7"
              disabled={rescanning}
              onClick={() => void rescan()}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon
                className={cn(rescanning && 'animate-pulse')}
                icon={ScanIcon}
              />
            </Button>
            <Button
              aria-label={t('web.refresh')}
              className="size-7"
              onClick={() => refetch()}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon
                className={cn(isFetching && 'animate-spin')}
                icon={Refresh01Icon}
              />
            </Button>
            <Button
              aria-label={t('web.atoms.add')}
              className="size-7"
              onClick={() => setAdding(true)}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon icon={PlusSignIcon} />
            </Button>
          </>
        }
        subtitle={t('web.atoms.subtitle')}
        title={t('web.atoms.title')}
      />

      {rescanErrors.length > 0 ? (
        <div className="flex flex-col gap-1 border-amber-500/30 border-b bg-amber-500/10 px-5 py-2 text-xs">
          <span className="flex items-center gap-1 font-medium text-warning">
            <HugeiconsIcon
              className="size-3"
              icon={Alert01Icon}
            />
            {t('web.atoms.rescanErrors')}
          </span>
          {rescanErrors.map((e) => (
            <span
              className="text-muted-foreground"
              key={e.file}
            >
              <span className="font-mono">{e.file}</span>: {e.error}
            </span>
          ))}
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-amber-500/30 border-b bg-amber-500/10 px-5 py-2 text-xs">
          <span className="flex items-center gap-1 font-medium text-warning">
            <HugeiconsIcon
              className="size-3"
              icon={Alert01Icon}
            />
            {t('web.atoms.conflicts')}
          </span>
          {conflicts.map((c) => (
            <ConflictRow
              conflict={c}
              key={`${c.kind}:${c.bareId}`}
            />
          ))}
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-4">
          {adding ? (
            <InstallForm
              onCancel={() => setAdding(false)}
              onInstalled={() => setAdding(false)}
            />
          ) : null}

          {packs.length === 0 && !adding ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.atoms.empty')}</p>
          ) : null}

          {packs.map((p) => (
            <AtomPackCard
              key={p.name}
              pack={p}
            />
          ))}
        </div>
      </ScrollArea>

      {kindsData && kindsData.kinds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t px-5 py-2 text-muted-foreground text-xs">
          <span>{t('web.atoms.registeredKinds')}:</span>
          {kindsData.kinds.map((k) => (
            <Badge
              className="text-[10px]"
              key={k}
              variant="secondary"
            >
              {k}
            </Badge>
          ))}
        </div>
      ) : null}
    </PanelShell>
  );
}
