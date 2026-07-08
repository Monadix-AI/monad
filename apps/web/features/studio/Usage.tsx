'use client';

import type { GetStatsResponse, GetUsageResponse, StatsRange } from '@monad/protocol';

import { Delete02Icon, LoaderPinwheelIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  externalAgentSessionSelectors,
  useGetExternalAgentUsageQuery,
  useGetStatsQuery,
  useGetUsageQuery,
  useListLiveExternalAgentSessionsQuery,
  useListWorkplaceProjectsQuery,
  useResetUsageMutation,
  workplaceProjectAdapter,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { Button, Card, cn } from '@monad/ui';
import { useMemo, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { useExternalAgentSettings } from '@/hooks/use-external-agent-settings';

type UsageTab = 'overview' | 'models' | 'ledger';

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtMoney(n: number) {
  return n > 0 ? `$${n.toFixed(2)}` : '$0.00';
}

function peakHourLabel(hour: number | null | undefined) {
  if (hour == null) return '-';
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hr = hour % 12 === 0 ? 12 : hour % 12;
  return `${hr} ${suffix}`;
}

function Heatmap({ stats }: { stats?: GetStatsResponse }) {
  const t = useT();
  const heatmapDaySet = new Map(stats?.heatmap.map((d) => [d.day, d.totalTokens]) ?? []);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const gridStart = new Date(today);
  gridStart.setDate(gridStart.getDate() - 125 - gridStart.getDay());
  const gridDays: { day: string; tokens: number }[] = [];
  for (let i = 0; i < 126; i++) {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    gridDays.push({ day: key, tokens: heatmapDaySet.get(key) ?? 0 });
  }
  const maxTokens = Math.max(...gridDays.map((d) => d.tokens), 1);
  const todayStr = today.toISOString().slice(0, 10);
  const lotrMultiple = stats ? Math.round(stats.totalTokens / 500_000) : 0;

  return (
    <Card className="p-3">
      <div className="flex flex-wrap gap-[3px]">
        {gridDays.map(({ day, tokens }) => {
          const intensity = tokens > 0 ? Math.ceil((tokens / maxTokens) * 4) : 0;
          const bg =
            intensity === 0
              ? 'bg-muted'
              : intensity === 1
                ? 'bg-primary/20'
                : intensity === 2
                  ? 'bg-primary/40'
                  : intensity === 3
                    ? 'bg-primary/70'
                    : 'bg-primary';
          return (
            <div
              className={cn('size-3 rounded-sm transition-colors', bg, day === todayStr && 'ring-1 ring-foreground/30')}
              key={day}
              title={tokens > 0 ? `${day}: ${fmtTokens(tokens)} tokens` : day}
            />
          );
        })}
      </div>
      {lotrMultiple > 0 && (
        <p className="mt-2 text-muted-foreground text-xs">{t('web.studio.usageLotr', { count: lotrMultiple })}</p>
      )}
    </Card>
  );
}

function UsageToolbar({
  range,
  setRange,
  tab,
  setTab
}: {
  range: StatsRange;
  setRange: (range: StatsRange) => void;
  tab: UsageTab;
  setTab: (tab: UsageTab) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex gap-1 rounded-md bg-muted p-0.5 text-xs">
        {(['overview', 'models', 'ledger'] as const).map((tb) => (
          <button
            className={cn(
              'rounded px-2.5 py-1 font-medium transition-colors',
              tab === tb ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
            key={tb}
            onClick={() => setTab(tb)}
            type="button"
          >
            {tb === 'overview'
              ? t('web.studio.usageOverview')
              : tb === 'models'
                ? t('web.studio.usageModels')
                : t('web.studio.usageLedger')}
          </button>
        ))}
      </div>
      <div className="flex gap-0.5 rounded-md bg-muted p-0.5 text-xs">
        {(['all', '30d', '7d'] as const).map((r) => (
          <button
            className={cn(
              'rounded px-2 py-1 font-medium transition-colors',
              range === r ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
            key={r}
            onClick={() => setRange(r)}
            type="button"
          >
            {r === 'all' ? 'All' : r}
          </button>
        ))}
      </div>
    </div>
  );
}

function MonadUsageContent({
  ledger,
  stats,
  tab
}: {
  ledger?: GetUsageResponse;
  stats?: GetStatsResponse;
  tab: UsageTab;
}) {
  const t = useT();

  if (tab === 'models') {
    if (!stats || stats.models.length === 0)
      return <p className="text-muted-foreground text-sm">{t('web.studio.usageEmpty')}</p>;
    return (
      <div className="flex flex-col gap-2">
        {stats.models.map((m) => (
          <Card
            className="flex flex-col gap-1.5 p-3"
            key={`${m.provider}:${m.model}`}
          >
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">{m.model}</span>
              <span className="shrink-0 font-semibold">{m.pct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${m.pct}%` }}
              />
            </div>
            <div className="flex justify-between gap-3 text-muted-foreground text-xs">
              <span>
                {fmtTokens(m.inputTokens)} in - {fmtTokens(m.outputTokens)} out
              </span>
              <span>{fmtTokens(m.totalTokens)} total</span>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  if (tab === 'ledger') {
    if (!ledger || ledger.entries.length === 0)
      return <p className="text-muted-foreground text-sm">{t('web.studio.usageLedgerEmpty')}</p>;
    return (
      <div className="flex flex-col gap-2">
        {ledger.entries.slice(0, 8).map((entry) => (
          <Card
            className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
            key={`${entry.provider}:${entry.model}`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-sm">{entry.model}</span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {entry.provider}
                </span>
              </div>
              <div className="mt-2 grid gap-1 text-muted-foreground text-xs sm:grid-cols-2">
                <span>
                  {t('web.studio.usageInputTokens')}: {fmtTokens(entry.inputTokens)}
                </span>
                <span>
                  {t('web.studio.usageOutputTokens')}: {fmtTokens(entry.outputTokens)}
                </span>
                <span>
                  {t('web.studio.usageCacheTokens')}: {fmtTokens(entry.cacheReadTokens + entry.cacheWriteTokens)}
                </span>
                <span>
                  {t('web.studio.usageReasoningTokens')}: {fmtTokens(entry.reasoningTokens)}
                </span>
              </div>
            </div>
            <div className="text-left sm:text-right">
              <p className="font-semibold text-sm">{fmtMoney(entry.costUsd)}</p>
              <p className="text-muted-foreground text-xs">
                {fmtTokens(entry.inputTokens + entry.outputTokens)} tokens
              </p>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: t('web.studio.usageSessions'), value: stats?.sessions.toLocaleString() ?? '-' },
          { label: t('web.studio.usageMessages'), value: stats?.messages.toLocaleString() ?? '-' },
          { label: t('web.studio.usageTotalTokens'), value: fmtTokens(stats?.totalTokens ?? 0) },
          { label: t('web.studio.usageCost'), value: fmtMoney(ledger?.totalCostUsd ?? 0) },
          { label: t('web.studio.usageActiveDays'), value: stats?.activeDays.toLocaleString() ?? '-' },
          { label: t('web.studio.usageCurrentStreak'), value: stats ? `${stats.currentStreak}d` : '-' },
          { label: t('web.studio.usagePeakHour'), value: peakHourLabel(stats?.peakHour) },
          { label: t('web.studio.usageFavoriteModel'), value: stats?.favoriteModel ?? '-' }
        ].map(({ label, value }) => (
          <Card
            className="flex flex-col gap-1 p-3"
            key={label}
          >
            <p className="text-muted-foreground text-xs">{label}</p>
            <p
              className="truncate font-semibold text-sm"
              title={value}
            >
              {value}
            </p>
          </Card>
        ))}
      </div>
      <Heatmap stats={stats} />
    </div>
  );
}

export function MonadAgentUsage() {
  const t = useT();
  const [tab, setTab] = useState<UsageTab>('overview');
  const [range, setRange] = useState<StatsRange>('all');
  const [resetUsage, { isLoading: resetting }] = useResetUsageMutation();
  const [confirmReset, setConfirmReset] = useState(false);
  const statsQuery = useGetStatsQuery(range);
  const ledgerQuery = useGetUsageQuery({ limit: 100, offset: 0 });
  const totalTokens = statsQuery.data?.totalTokens ?? 0;

  return (
    <section className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="font-medium text-base">{t('web.studio.monadAgentUsage')}</h2>
          <p className="mt-1 text-muted-foreground text-sm">{t('web.studio.monadAgentUsageDesc')}</p>
        </div>
        {totalTokens > 0 &&
          (confirmReset ? (
            <span className="flex items-center gap-1">
              <Button
                disabled={resetting}
                onClick={async () => {
                  await resetUsage()
                    .unwrap()
                    .catch(() => {});
                  setConfirmReset(false);
                }}
                size="sm"
                variant="destructive"
              >
                {resetting ? (
                  <HugeiconsIcon
                    className="size-3 animate-spin"
                    icon={LoaderPinwheelIcon}
                  />
                ) : (
                  t('web.settings.system.resetUsage')
                )}
              </Button>
              <Button
                onClick={() => setConfirmReset(false)}
                size="sm"
                variant="ghost"
              >
                {t('web.common.cancel')}
              </Button>
            </span>
          ) : (
            <Button
              aria-label={t('web.settings.system.resetUsage')}
              className="size-8"
              onClick={() => setConfirmReset(true)}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={Delete02Icon}
              />
            </Button>
          ))}
      </div>
      <div className="flex flex-col gap-3 p-3">
        <UsageToolbar
          range={range}
          setRange={setRange}
          setTab={setTab}
          tab={tab}
        />
        {statsQuery.isLoading || ledgerQuery.isLoading ? (
          <HugeiconsIcon
            className="size-4 animate-spin text-muted-foreground"
            icon={LoaderPinwheelIcon}
          />
        ) : (
          <MonadUsageContent
            ledger={ledgerQuery.data}
            stats={statsQuery.data}
            tab={tab}
          />
        )}
      </div>
    </section>
  );
}

function ExternalAgentUsageRows({ agentName }: { agentName: string }) {
  const t = useT();
  const { data, isLoading } = useGetExternalAgentUsageQuery(agentName, { pollingInterval: 60_000 });
  if (isLoading) {
    return (
      <HugeiconsIcon
        className="size-4 animate-spin text-muted-foreground"
        icon={LoaderPinwheelIcon}
      />
    );
  }
  if (!data || data.records.length === 0)
    return <p className="text-muted-foreground text-xs">{t('web.studio.meshUsageNoProviderData')}</p>;
  return (
    <div className="grid gap-2">
      {data.records.map((record) => {
        const pct =
          record.max && record.max > 0 ? Math.min(100, Math.round((record.current / record.max) * 100)) : null;
        return (
          <div
            className="rounded-lg border bg-background px-3 py-2"
            key={`${agentName}:${record.name}`}
          >
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">{record.name}</span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {fmtTokens(record.current)}
                {record.max ? ` / ${fmtTokens(record.max)}` : ''}
              </span>
            </div>
            {pct !== null && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
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
  );
}

export function MeshUsage() {
  const t = useT();
  const externalAgent = useExternalAgentSettings();
  const projects = useListWorkplaceProjectsQuery(undefined);
  const sessions = useListLiveExternalAgentSessionsQuery(undefined);
  const projectList = workplaceProjectSelectors.selectAll(
    projects.data?.projects ?? workplaceProjectAdapter.getInitialState()
  );
  const sessionList = sessions.data ? externalAgentSessionSelectors.selectAll(sessions.data.sessions) : [];
  const activeAgents = useMemo(() => new Set(sessionList.map((session) => session.agentName)), [sessionList]);

  return (
    <section className="rounded-xl border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="font-medium text-base">{t('web.studio.meshUsage')}</h2>
        <p className="mt-1 text-muted-foreground text-sm">{t('web.studio.meshUsageDesc')}</p>
      </div>
      <div className="flex flex-col gap-3 p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: t('web.studio.meshUsageConnectedAgents'), value: externalAgent.agents.length.toLocaleString() },
            { label: t('web.studio.meshUsageActiveRuntimes'), value: sessionList.length.toLocaleString() },
            { label: t('web.studio.meshUsageActiveAgents'), value: activeAgents.size.toLocaleString() },
            { label: t('web.studio.meshUsageProjects'), value: projectList.length.toLocaleString() }
          ].map(({ label, value }) => (
            <Card
              className="flex flex-col gap-1 p-3"
              key={label}
            >
              <p className="text-muted-foreground text-xs">{label}</p>
              <p className="truncate font-semibold text-sm">{value}</p>
            </Card>
          ))}
        </div>
        {externalAgent.agents.length === 0 ? (
          <p className="px-1 py-2 text-muted-foreground text-sm">{t('web.studio.meshUsageEmpty')}</p>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {externalAgent.agents.map((agent) => (
              <Card
                className="flex flex-col gap-3 p-3"
                key={agent.name}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-medium text-sm">{agent.name}</h3>
                    <p className="text-muted-foreground text-xs">{agent.provider}</p>
                  </div>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 font-medium text-[11px]',
                      activeAgents.has(agent.name) ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {activeAgents.has(agent.name) ? t('web.studio.meshUsageActive') : t('web.studio.meshUsageIdle')}
                  </span>
                </div>
                <ExternalAgentUsageRows agentName={agent.name} />
              </Card>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
