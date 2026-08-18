import { CollapseIcon, ExpandIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { atomPackSelectors, useListAtomPacksQuery } from '@monad/client-rtk';
import { Button } from '@monad/ui';
import { useMemo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ContentColumn } from '#/components/ui/content-column';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '#/features/studio/StudioBreadcrumbHeader';
import { useChannelSettings } from '#/hooks/use-channel-settings';
import { ChannelAdapterSection } from './ChannelAdapterSection';
import { type InstalledChannelOption, installedChannelOptions } from './installed-channel-options';

export function ChannelsSettings(_props: { onClose: () => void }) {
  const t = useT();
  const {
    channels,
    statusById,
    loading,
    error,
    saveChannel,
    removeChannel,
    setEnabled,
    setCredential,
    pairChannel,
    refetch
  } = useChannelSettings();
  const atomPacksQuery = useListAtomPacksQuery();
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(() => new Set());
  const adapters = useMemo(() => {
    const installed = atomPacksQuery.data
      ? installedChannelOptions(
          atomPackSelectors.selectAll(atomPacksQuery.data.atomPacks),
          atomPacksQuery.data.conflicts
        )
      : [];
    const installedTypes = new Set(installed.map((adapter) => adapter.type));
    const unavailable = channels.flatMap<InstalledChannelOption>((connection) =>
      installedTypes.has(connection.type)
        ? []
        : [
            {
              type: connection.type,
              label: connection.type,
              packId: 'unavailable',
              available: false,
              connectionMode: 'credential',
              envVars: []
            }
          ]
    );
    return [
      ...installed,
      ...unavailable.filter((adapter, index) => unavailable.findIndex((x) => x.type === adapter.type) === index)
    ];
  }, [atomPacksQuery.data, channels]);
  const allExpanded = adapters.every((adapter) => !collapsedTypes.has(adapter.type));

  const refresh = () => {
    refetch();
    void atomPacksQuery.refetch();
  };

  return (
    <PanelShell>
      <StudioBreadcrumbHeader
        actions={
          <Button
            disabled={adapters.length === 0}
            onClick={() => {
              setCollapsedTypes(allExpanded ? new Set(adapters.map((adapter) => adapter.type)) : new Set());
            }}
            size="sm"
            variant="ghost"
          >
            <HugeiconsIcon icon={allExpanded ? CollapseIcon : ExpandIcon} />
            {allExpanded ? t('web.ch.collapseAll') : t('web.ch.expandAll')}
          </Button>
        }
        title={t('web.ch.title')}
      />

      <PanelShellBody
        className="overflow-y-auto"
        data-testid="channels-scroll-area"
      >
        <ContentColumn className="gap-2 p-4 sm:p-6">
          {loading || atomPacksQuery.isLoading ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.common.loading')}</p>
          ) : null}
          {error || atomPacksQuery.isError ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 p-6 text-center">
              <p className="text-destructive text-sm">{t('web.ch.loadFailed')}</p>
              <Button
                onClick={refresh}
                size="sm"
                variant="outline"
              >
                {t('web.ch.retry')}
              </Button>
            </div>
          ) : null}
          {!loading && !atomPacksQuery.isLoading && !error && !atomPacksQuery.isError && adapters.length === 0 ? (
            <p className="px-1 py-8 text-center text-muted-foreground text-xs">{t('web.ch.noAdapters')}</p>
          ) : null}
          {!loading && !atomPacksQuery.isLoading && !error && !atomPacksQuery.isError
            ? adapters.map((adapter) => (
                <ChannelAdapterSection
                  adapter={adapter}
                  connections={channels.filter((connection) => connection.type === adapter.type)}
                  expanded={!collapsedTypes.has(adapter.type)}
                  key={adapter.type}
                  onExpandedChange={(expanded) => {
                    setCollapsedTypes((current) => {
                      const next = new Set(current);
                      if (expanded) next.delete(adapter.type);
                      else next.add(adapter.type);
                      return next;
                    });
                  }}
                  onPair={pairChannel}
                  onRemove={removeChannel}
                  onSave={saveChannel}
                  onSetCredential={setCredential}
                  onToggle={setEnabled}
                  statusById={statusById}
                />
              ))
            : null}
        </ContentColumn>
      </PanelShellBody>
    </PanelShell>
  );
}
