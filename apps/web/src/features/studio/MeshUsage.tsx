import type { ChannelIcon } from '@monad/protocol';

import { LoaderPinwheelIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useGetMeshUsageOverviewQuery, useListMeshAgentPresetsQuery } from '@monad/client-rtk';
import { Card, cn, ProductIcon } from '@monad/ui';
import { useMemo, useState } from 'react';

import { BrandIcon } from '#/components/BrandIcon';
import { useT } from '#/components/I18nProvider';
import { MeshUsageSkeleton } from './MeshUsageSkeleton';
import {
  buildMeshUsageView,
  type MeshUsageProviderGroup,
  type MeshUsageRankedItem,
  type MeshUsageSessionGroup,
  type MeshUsageTotals
} from './mesh-usage-data';

type DetailDimension = 'provider' | 'session';

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function UsageTotals({ totals }: { totals: MeshUsageTotals }) {
  const t = useT();
  return (
    <div className="grid grid-cols-3 gap-2">
      {[
        { label: t('web.studio.usageInputTokens'), value: totals.input },
        { label: t('web.studio.usageOutputTokens'), value: totals.output },
        { label: t('web.studio.usageTotalTokens'), value: totals.total }
      ].map((metric) => (
        <div
          className="min-w-0 rounded-lg bg-muted/45 px-3 py-2"
          key={metric.label}
        >
          <p className="truncate text-[11px] text-muted-foreground">{metric.label}</p>
          <p className="mt-1 truncate font-semibold text-sm tabular-nums">{fmtTokens(metric.value)}</p>
        </div>
      ))}
    </div>
  );
}

function UsageRanking({ items, title }: { items: MeshUsageRankedItem[]; title: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <p className="font-medium text-muted-foreground text-xs">{title}</p>
      {items.map((item, index) => (
        <div
          className="flex items-center gap-3 rounded-lg bg-muted/45 px-3 py-2.5"
          key={item.id}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted font-medium text-xs tabular-nums">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="min-w-0 truncate font-medium text-sm">{item.name}</p>
              {item.provider ? (
                <ProductIcon
                  background="none"
                  product={item.provider}
                  size={14}
                />
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground tabular-nums">
              {t('web.studio.usageInputTokens')} {fmtTokens(item.input)} · {t('web.studio.usageOutputTokens')}{' '}
              {fmtTokens(item.output)}
            </p>
          </div>
          <span className="shrink-0 font-semibold text-sm tabular-nums">{fmtTokens(item.total)}</span>
        </div>
      ))}
    </div>
  );
}

function ProviderCard({ group, icon, name }: { group: MeshUsageProviderGroup; icon?: ChannelIcon; name: string }) {
  const t = useT();
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
          {icon ? (
            <BrandIcon
              className="size-4"
              icon={icon}
            />
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium text-sm">{name}</h3>
          <p className="mt-1 text-muted-foreground text-xs">
            {group.agentCount} {t('web.studio.meshUsageConnectedAgents')} · {group.projectIds.length}{' '}
            {t('web.studio.meshUsageProjects')} · {group.sessionCount} {t('web.studio.meshUsageSessions')}
          </p>
        </div>
      </div>
      <UsageTotals totals={group} />
      <UsageRanking
        items={group.topSessions}
        title={t('web.studio.meshUsageTopSessions')}
      />
    </Card>
  );
}

function SessionCard({ group }: { group: MeshUsageSessionGroup }) {
  const t = useT();
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div>
        <h3 className="truncate font-medium text-sm">{group.sessionTitle}</h3>
        <p className="mt-1 text-muted-foreground text-xs">
          {group.providerNames.join(', ')} · {group.agentCount} {t('web.studio.meshUsageConnectedAgents')}
        </p>
      </div>
      <UsageTotals totals={group} />
      <UsageRanking
        items={group.topAgents}
        title={t('web.studio.meshUsageTopAgentMembers')}
      />
    </Card>
  );
}

export function MeshUsage() {
  const t = useT();
  const [dimension, setDimension] = useState<DetailDimension>('provider');
  const usageQuery = useGetMeshUsageOverviewQuery(undefined, {
    pollingInterval: 60_000,
    refetchOnFocus: true
  });
  const presetsQuery = useListMeshAgentPresetsQuery();
  const usageData = usageQuery.data;
  const view = useMemo(() => (usageData ? buildMeshUsageView(usageData) : null), [usageData]);
  const iconsByProvider = useMemo(
    () =>
      new Map(
        (presetsQuery.data ?? []).flatMap<[string, ChannelIcon]>((preset) =>
          preset.icon ? [[preset.provider, preset.icon]] : []
        )
      ),
    [presetsQuery.data]
  );
  const namesByProvider = useMemo(
    () => new Map((presetsQuery.data ?? []).map((preset) => [preset.provider, preset.label])),
    [presetsQuery.data]
  );

  if (usageQuery.isLoading || !usageData || !view) return <MeshUsageSkeleton />;

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-medium text-base">{t('web.studio.meshUsageOverviewTitle')}</h2>
            <p className="mt-1 max-w-3xl text-muted-foreground text-sm">{t('web.studio.meshUsagePersisted')}</p>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            {usageQuery.isFetching && (
              <HugeiconsIcon
                className="size-3.5 animate-spin"
                icon={LoaderPinwheelIcon}
              />
            )}
            <span>
              {t('web.studio.meshUsageUpdated')} {new Date(usageData.checkedAt).toLocaleTimeString()}
            </span>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {[
            { label: t('web.studio.meshUsageProviders'), value: view.providers.length.toLocaleString() },
            { label: t('web.studio.meshUsageConnectedAgents'), value: view.agents.toLocaleString() },
            { label: t('web.studio.meshUsageProjects'), value: view.projects.length.toLocaleString() },
            { label: t('web.studio.meshUsageSessions'), value: view.sessions.toLocaleString() },
            { label: t('web.studio.usageTotalTokens'), value: fmtTokens(view.totals.total) }
          ].map((metric) => (
            <Card
              className="flex flex-col gap-1 p-3"
              key={metric.label}
            >
              <p className="text-muted-foreground text-xs">{metric.label}</p>
              <p className="truncate font-semibold text-base tabular-nums">{metric.value}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <h2 className="font-medium text-base">{t('web.studio.meshUsageDetailsTitle')}</h2>
            <p className="mt-1 text-muted-foreground text-sm">{t('web.studio.meshUsageDesc')}</p>
          </div>
          <div className="flex rounded-lg bg-muted p-1">
            {(['provider', 'session'] as const).map((item) => (
              <button
                aria-pressed={dimension === item}
                className={cn(
                  'rounded-md px-3 py-1.5 font-medium text-xs transition-colors',
                  dimension === item ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
                )}
                key={item}
                onClick={() => setDimension(item)}
                type="button"
              >
                {item === 'provider' ? t('web.studio.meshUsageByProvider') : t('web.studio.meshUsageBySession')}
              </button>
            ))}
          </div>
        </div>
        <div className="p-3">
          {dimension === 'provider' ? (
            view.providers.length === 0 ? (
              <p className="px-1 py-2 text-muted-foreground text-sm">{t('web.studio.meshUsageEmpty')}</p>
            ) : (
              <div className="grid gap-3 xl:grid-cols-2">
                {view.providers.map((group) => (
                  <ProviderCard
                    group={group}
                    icon={iconsByProvider.get(group.provider)}
                    key={group.provider}
                    name={namesByProvider.get(group.provider) ?? group.provider}
                  />
                ))}
              </div>
            )
          ) : view.sessionGroups.length === 0 ? (
            <p className="px-1 py-2 text-muted-foreground text-sm">{t('web.studio.meshUsageNoSessions')}</p>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {view.sessionGroups.map((group) => (
                <SessionCard
                  group={group}
                  key={group.sessionId}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
