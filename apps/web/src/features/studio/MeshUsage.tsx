import type { ChannelIcon, MeshAgentUsageResponse } from '@monad/protocol';

import { LoaderPinwheelIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useGetMeshUsageOverviewQuery,
  useListMeshAgentPresetsQuery,
  useListWorkplaceProjectsQuery,
  workplaceProjectAdapter,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { Card, cn, Skeleton } from '@monad/ui';
import { useMemo, useState } from 'react';

import { BrandIcon } from '#/components/BrandIcon';
import { useT } from '#/components/I18nProvider';
import { buildMeshUsageView, type MeshUsageProviderGroup, type MeshUsageTotals } from './mesh-usage-data';

type DetailDimension = 'provider' | 'project';
const SUMMARY_SKELETON_KEYS = ['providers', 'agents', 'projects', 'sessions', 'tokens'] as const;

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

function ProviderRecords({ snapshots }: { snapshots: MeshAgentUsageResponse[] }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <p className="font-medium text-muted-foreground text-xs">{t('web.studio.meshUsageRealtimeProvider')}</p>
      {snapshots.map((snapshot) => (
        <div
          className="rounded-lg border bg-background p-3"
          key={`${snapshot.provider}:${snapshot.agentName}`}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="truncate font-medium text-sm">{snapshot.agentName}</p>
            <p className="shrink-0 text-[11px] text-muted-foreground">
              {t('web.studio.meshUsageUpdated')} {new Date(snapshot.checkedAt).toLocaleTimeString()}
            </p>
          </div>
          {snapshot.records.length === 0 ? (
            <p className="mt-2 text-muted-foreground text-xs">{t('web.studio.meshUsageNoProviderData')}</p>
          ) : (
            <div className="mt-3 grid gap-3">
              {snapshot.records.map((record) => {
                const pct = record.max ? Math.min(100, Math.round((record.current / record.max) * 100)) : null;
                return (
                  <div key={record.name}>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="min-w-0 truncate">{record.name}</span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {fmtTokens(record.current)}
                        {record.max ? ` / ${fmtTokens(record.max)}` : ''}
                      </span>
                    </div>
                    {pct !== null && (
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-[color-mix(in_srgb,var(--info)_72%,var(--primary))]"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                    {record.resetAt && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t('web.studio.meshUsageResets')}: {new Date(record.resetAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ProviderCard({ group, icon }: { group: MeshUsageProviderGroup; icon?: ChannelIcon }) {
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
          <h3 className="truncate font-medium text-sm">{group.provider}</h3>
          <p className="mt-1 text-muted-foreground text-xs">
            {group.agentNames.length} {t('web.studio.meshUsageConnectedAgents')} · {group.projectIds.length}{' '}
            {t('web.studio.meshUsageProjects')} · {group.sessionCount} {t('web.studio.meshUsageSessions')}
          </p>
        </div>
      </div>
      <UsageTotals totals={group} />
      <ProviderRecords snapshots={group.providerUsage} />
    </Card>
  );
}

function MeshUsageSkeleton() {
  return (
    <div
      aria-busy="true"
      className="flex flex-col gap-5"
    >
      <section className="rounded-xl border bg-card p-4">
        <Skeleton className="h-5 w-28" />
        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-5">
          {SUMMARY_SKELETON_KEYS.map((key) => (
            <Skeleton
              className="h-16 rounded-lg"
              key={key}
            />
          ))}
        </div>
      </section>
      <Skeleton className="h-64 rounded-xl" />
    </div>
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
  const projectsQuery = useListWorkplaceProjectsQuery(undefined);
  const projects = workplaceProjectSelectors.selectAll(
    projectsQuery.data?.projects ?? workplaceProjectAdapter.getInitialState()
  );
  const projectTitles = useMemo(() => new Map(projects.map((project) => [project.id, project.title])), [projects]);
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
            {(['provider', 'project'] as const).map((item) => (
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
                {item === 'provider' ? t('web.studio.meshUsageByProvider') : t('web.studio.meshUsageByProject')}
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
                  />
                ))}
              </div>
            )
          ) : view.projects.length === 0 ? (
            <p className="px-1 py-2 text-muted-foreground text-sm">{t('web.studio.meshUsageNoSessions')}</p>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {view.projects.map((group) => (
                <Card
                  className="flex min-w-0 flex-col gap-3 p-4"
                  key={group.projectId}
                >
                  <div>
                    <h3 className="truncate font-medium text-sm">
                      {projectTitles.get(group.projectId) ?? group.projectId}
                    </h3>
                    <p className="mt-1 text-muted-foreground text-xs">
                      {group.providerNames.join(', ')} · {group.agentNames.length}{' '}
                      {t('web.studio.meshUsageConnectedAgents')} · {group.sessionCount}{' '}
                      {t('web.studio.meshUsageSessions')}
                    </p>
                  </div>
                  <UsageTotals totals={group} />
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
