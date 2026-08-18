import { Alert01Icon, PlusSignIcon, ScanIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { atomPackSelectors, useDiscoverAtomKindsMutation, useListAtomPacksQuery } from '@monad/client-rtk';
import { Button, cn } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { RefreshButton } from '#/components/RefreshButton';
import { ContentColumn } from '#/components/ui/content-column';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '#/features/studio/StudioBreadcrumbHeader';
import { isResolvedEmptyList } from '#/lib/async-list-state';
import { AtomPackCard, ConflictRow } from './AtomPackCard';
import { InstallAtomPackDialog } from './InstallAtomPackDialog';

export function AtomsSettings(_props: { onClose: () => void }) {
  const t = useT();
  const { data, isFetching, isLoading, refetch } = useListAtomPacksQuery();
  const [discover, { isLoading: rescanning }] = useDiscoverAtomKindsMutation();
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [rescanErrors, setRescanErrors] = useState<{ file: string; error: string }[]>([]);
  const packs = data ? atomPackSelectors.selectAll(data.atomPacks) : [];
  const conflicts = data?.conflicts ?? [];

  const rescan = async () => {
    const res = await discover()
      .unwrap()
      .catch(() => null);
    setRescanErrors(res?.errors ?? []);
  };

  return (
    <PanelShell>
      <StudioBreadcrumbHeader
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
            <RefreshButton
              className="size-7"
              iconOnly
              label={t('web.refresh')}
              loading={isFetching}
              onClick={() => refetch()}
              size="icon"
              variant="ghost"
            />
            <Button
              aria-label={t('web.atoms.add')}
              className="size-7"
              onClick={() => setInstallDialogOpen(true)}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon icon={PlusSignIcon} />
            </Button>
          </>
        }
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
              <span className="font-ui">{e.file}</span>: {e.error}
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

      <PanelShellBody className="overflow-y-auto">
        <ContentColumn className="max-w-5xl gap-2 p-4 sm:p-6">
          {isResolvedEmptyList({ isLoading, itemCount: packs.length }) ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.atoms.empty')}</p>
          ) : null}

          {packs.map((p) => (
            <AtomPackCard
              key={p.name}
              pack={p}
            />
          ))}
        </ContentColumn>
      </PanelShellBody>

      <InstallAtomPackDialog
        onOpenChange={setInstallDialogOpen}
        open={installDialogOpen}
      />
    </PanelShell>
  );
}
