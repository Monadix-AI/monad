import type { GetStatsResponse, GetUsageResponse, StatsRange } from '@monad/protocol';

import { RotateLeft01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useGetStatsQuery, useGetUsageQuery, useResetUsageMutation } from '@monad/client-rtk';
import { Button, Card, Confirm, cn, Skeleton } from '@monad/ui';
import * as HeatGraph from 'heat-graph';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';

type UsageTab = 'overview' | 'models' | 'ledger';

function UsageSkeleton() {
  return (
    <div
      aria-busy="true"
      className="flex flex-col gap-3 p-5"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-40 rounded-md" />
        <Skeleton className="h-7 w-36 rounded-md" />
      </div>
      <div className="usage-stats-grid grid grid-cols-2 gap-2 sm:grid-cols-4 min-[1100px]:grid-cols-8">
        {Array.from({ length: 8 }, (_, i) => `usage-stat-skeleton-${i}`).map((key) => (
          <Card
            className="flex flex-col gap-2 p-3"
            key={key}
          >
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-4 w-16 rounded" />
          </Card>
        ))}
      </div>
      <Card className="flex flex-col gap-3 p-4">
        <Skeleton className="h-4 w-32 rounded" />
        <div className="grid grid-flow-col grid-rows-7 gap-1 overflow-hidden">
          {Array.from({ length: 84 }, (_, i) => `usage-day-skeleton-${i}`).map((key) => (
            <Skeleton
              className="size-3 rounded-sm"
              key={key}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

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
  gridStart.setDate(gridStart.getDate() - 363 - gridStart.getDay());
  const gridDays: { day: string; tokens: number }[] = [];
  for (let i = 0; i < 364; i++) {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    gridDays.push({ day: key, tokens: heatmapDaySet.get(key) ?? 0 });
  }
  const lotrMultiple = stats ? Math.round(stats.totalTokens / 500_000) : 0;
  const heatGraphData = gridDays.map(({ day, tokens }) => ({ date: day, count: tokens }));
  const heatGraphColors = [
    'var(--muted)',
    'color-mix(in srgb, var(--primary) 20%, var(--card))',
    'color-mix(in srgb, var(--primary) 40%, var(--card))',
    'color-mix(in srgb, var(--primary) 70%, var(--card))',
    'var(--primary)'
  ];

  return (
    <Card className="usage-punch-card w-full p-3">
      <HeatGraph.Root
        colorScale={heatGraphColors}
        data={heatGraphData}
        end={today}
        start={gridStart}
        weekStart="sunday"
      >
        <div className="relative mb-1 h-4 text-[10px] text-muted-foreground">
          <HeatGraph.MonthLabels>
            {({ label, totalWeeks }) => (
              <span
                className="absolute top-0 whitespace-nowrap"
                style={{ left: `${(label.column / totalWeeks) * 100}%` }}
              >
                {new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(2020, label.month, 1))}
              </span>
            )}
          </HeatGraph.MonthLabels>
        </div>
        <HeatGraph.Grid className="usage-punch-grid w-full gap-[3px]">
          {({ cell }) => (
            <HeatGraph.Cell
              aria-label={`${cell.date.toLocaleDateString()}: ${t('web.studio.usageTotalTokens')} ${fmtTokens(cell.count)}`}
              className="aspect-square w-full rounded-[3px] transition-[background-color,box-shadow] duration-150 hover:ring-1 hover:ring-foreground/40"
              role="img"
            />
          )}
        </HeatGraph.Grid>
        <HeatGraph.Tooltip
          className="popup-surface z-50 rounded-md px-2.5 py-1.5 text-popover-foreground text-xs shadow-md"
          sideOffset={6}
        >
          {({ cell }) => (
            <span className="flex items-center gap-1.5">
              <span>{cell.date.toLocaleDateString()}</span>
              <span aria-hidden="true">·</span>
              <span className="font-medium">
                {t('web.studio.usageTotalTokens')}: {fmtTokens(cell.count)}
              </span>
            </span>
          )}
        </HeatGraph.Tooltip>
      </HeatGraph.Root>
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
              className="truncate font-semibold text-base"
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
  const [resetError, setResetError] = useState<string>();
  const statsQuery = useGetStatsQuery(range);
  const ledgerQuery = useGetUsageQuery({ limit: 100, offset: 0 });
  const totalTokens = statsQuery.data?.totalTokens ?? 0;

  return (
    <>
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center gap-4 border-b bg-[color-mix(in_srgb,var(--secondary)_45%,var(--card))] px-4 py-3.5">
          <h2 className="min-w-0 flex-1 font-medium text-sm">{t('web.studio.monadAgentUsage')}</h2>
          {totalTokens > 0 && (
            <Button
              aria-label={t('web.settings.system.resetUsage')}
              className="size-8 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                setResetError(undefined);
                setConfirmReset(true);
              }}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={RotateLeft01Icon}
              />
            </Button>
          )}
        </div>
        <p className="px-4 py-3.5 text-muted-foreground text-xs leading-relaxed">
          {t('web.studio.monadAgentUsageDesc')}
        </p>
        <div className="flex flex-col gap-4 px-4 pt-0 pb-4 [&>:first-child]:border-border [&>:first-child]:border-b [&>:first-child]:px-0.5 [&>:first-child]:pt-0.5 [&>:first-child]:pb-3 [&_[data-slot=card]]:border-border/80 [&_[data-slot=card]]:bg-[color-mix(in_srgb,var(--card)_92%,var(--secondary))] [&_[data-slot=card]_p:last-child]:tabular-nums">
          <UsageToolbar
            range={range}
            setRange={setRange}
            setTab={setTab}
            tab={tab}
          />
          {statsQuery.isLoading || ledgerQuery.isLoading ? (
            <UsageSkeleton />
          ) : (
            <MonadUsageContent
              ledger={ledgerQuery.data}
              stats={statsQuery.data}
              tab={tab}
            />
          )}
        </div>
      </section>
      <Confirm
        cancelLabel={t('web.common.cancel')}
        confirmLabel={t('web.settings.system.resetUsage')}
        confirmVariant="destructive"
        description={t('web.settings.system.resetUsageDesc')}
        error={resetError}
        onConfirm={() => {
          setResetError(undefined);
          void resetUsage()
            .unwrap()
            .then(() => setConfirmReset(false))
            .catch((error: unknown) => {
              setResetError(error instanceof Error ? error.message : t('web.settings.system.resetUsageFailed'));
            });
        }}
        onOpenChange={(open) => {
          setConfirmReset(open);
          if (!open) setResetError(undefined);
        }}
        open={confirmReset}
        pending={resetting}
        pendingLabel={t('web.settings.system.resettingUsage')}
        title={t('web.settings.system.resetUsageConfirmTitle')}
      />
    </>
  );
}
