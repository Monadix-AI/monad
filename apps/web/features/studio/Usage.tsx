'use client';

import { useGetStatsQuery, useResetUsageMutation } from '@monad/client-rtk';
import { Button, Card, cn } from '@monad/ui';
import { Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';

type StatsRange = 'all' | '30d' | '7d';

/** Studio › Usage: cross-agent token/usage observability. Lifted out of model-settings into its own
 *  top-level Studio page (overview heatmap + per-model breakdown + reset). */
export function Usage() {
  const t = useT();
  const [tab, setTab] = useState<'overview' | 'models'>('overview');
  const [range, setRange] = useState<StatsRange>('all');
  const [resetUsage, { isLoading: resetting }] = useResetUsageMutation();
  const [confirmReset, setConfirmReset] = useState(false);

  const { data: stats, isLoading } = useGetStatsQuery(range);

  if (isLoading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;

  const fmtTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString();
  };

  // heatmap: build a full grid starting from (today - N weeks back)
  const heatmapDaySet = new Map(stats?.heatmap.map((d) => [d.day, d.totalTokens]) ?? []);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // 18 weeks = 126 days, align to Sunday
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

  // lord of the rings comparison (500k tokens)
  const lotrMultiple = stats ? Math.round(stats.totalTokens / 500_000) : 0;

  const peakLabel =
    stats?.peakHour != null
      ? (() => {
          const h = stats.peakHour;
          const suffix = h >= 12 ? 'PM' : 'AM';
          const hr = h % 12 === 0 ? 12 : h % 12;
          return `${hr} ${suffix}`;
        })()
      : '—';

  return (
    <div className="flex flex-col gap-3 p-5">
      {/* toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 rounded-md bg-muted p-0.5 text-xs">
          {(['overview', 'models'] as const).map((tb) => (
            <button
              className={cn(
                'rounded px-2.5 py-1 font-medium transition-colors',
                tab === tb ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
              key={tb}
              onClick={() => setTab(tb)}
              type="button"
            >
              {tb === 'overview' ? t('web.studio.usageOverview') : t('web.studio.usageModels')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
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
          {(stats?.totalTokens ?? 0) > 0 &&
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
                  {resetting ? <Loader2 className="size-3 animate-spin" /> : t('web.settings.system.resetUsage')}
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
                className="gap-1.5"
                onClick={() => setConfirmReset(true)}
                size="sm"
                variant="ghost"
              >
                <Trash2 className="size-3.5" />
              </Button>
            ))}
        </div>
      </div>

      {tab === 'overview' && (
        <div className="flex flex-col gap-3">
          {/* stat cards */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: t('web.studio.usageSessions'), value: stats?.sessions.toLocaleString() ?? '—' },
              { label: t('web.studio.usageMessages'), value: stats?.messages.toLocaleString() ?? '—' },
              { label: t('web.studio.usageTotalTokens'), value: fmtTokens(stats?.totalTokens ?? 0) },
              { label: t('web.studio.usageActiveDays'), value: stats?.activeDays.toLocaleString() ?? '—' },
              { label: t('web.studio.usageCurrentStreak'), value: stats ? `${stats.currentStreak}d` : '—' },
              { label: t('web.studio.usageLongestStreak'), value: stats ? `${stats.longestStreak}d` : '—' },
              { label: t('web.studio.usagePeakHour'), value: peakLabel },
              { label: t('web.studio.usageFavoriteModel'), value: stats?.favoriteModel ?? '—' }
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

          {/* heatmap */}
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
                    className={cn(
                      'size-3 rounded-sm transition-colors',
                      bg,
                      day === todayStr && 'ring-1 ring-foreground/30'
                    )}
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
        </div>
      )}

      {tab === 'models' && (
        <div className="flex flex-col gap-2">
          {!stats || stats.models.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('web.studio.usageEmpty')}</p>
          ) : (
            stats.models.map((m) => (
              <Card
                className="flex flex-col gap-1.5 p-3"
                key={`${m.provider}:${m.model}`}
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{m.model}</span>
                  <span className="font-semibold">{m.pct}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${m.pct}%` }}
                  />
                </div>
                <div className="flex justify-between text-muted-foreground text-xs">
                  <span>
                    {fmtTokens(m.inputTokens)} in · {fmtTokens(m.outputTokens)} out
                  </span>
                  <span>{fmtTokens(m.totalTokens)} total</span>
                </div>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
