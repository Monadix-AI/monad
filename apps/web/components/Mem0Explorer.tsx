'use client';

import type { GetMem0DataResponse, Mem0EntryView } from '@monad/protocol';

import { useGetMem0DataQuery } from '@monad/client-rtk';
import { Button } from '@monad/ui';
import { Boxes, Database } from 'lucide-react';
import { useMemo } from 'react';

import { useT } from '@/components/I18nProvider';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#14b8a6'];
function colorForScope(scope: string): string {
  let h = 0;
  for (let i = 0; i < scope.length; i++) h = (h * 31 + scope.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function scopeLabel(scope: string): string {
  return scope.startsWith('agent:') ? scope.slice('agent:'.length) : scope;
}

// 2D scatter of the embedding projection, points colored by scope. Hand-rolled SVG (no chart dep);
// coordinates are min/max-normalized into the viewport. Hover shows the memory text via <title>.
function ClusterMap({ entries }: { entries: Mem0EntryView[] }) {
  const pts = entries.filter((e): e is Mem0EntryView & { x: number; y: number } => e.x !== null && e.y !== null);
  const W = 560;
  const H = 320;
  const pad = 24;
  const layout = useMemo(() => {
    if (pts.length === 0) return [];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const xmin = Math.min(...xs);
    const xmax = Math.max(...xs);
    const ymin = Math.min(...ys);
    const ymax = Math.max(...ys);
    const sx = (x: number) => pad + ((x - xmin) / (xmax - xmin || 1)) * (W - 2 * pad);
    const sy = (y: number) => pad + ((y - ymin) / (ymax - ymin || 1)) * (H - 2 * pad);
    return pts.map((p) => ({ e: p, cx: sx(p.x), cy: sy(p.y) }));
  }, [pts]);

  if (layout.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground text-xs">
        No embeddings to plot (the vector store may be off or empty).
      </div>
    );
  }
  return (
    <svg
      className="w-full"
      role="img"
      viewBox={`0 0 ${W} ${H}`}
    >
      <title>mem0 embedding cluster map</title>
      {layout.map(({ e, cx, cy }) => (
        <circle
          cx={cx}
          cy={cy}
          fill={colorForScope(e.scope)}
          fillOpacity={0.85}
          key={e.id}
          r={5}
        >
          <title>{`[${scopeLabel(e.scope)}] ${e.text}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export function Mem0Explorer(_props: { onClose: () => void }) {
  const t = useT();
  const { data, isLoading, isFetching, refetch } = useGetMem0DataQuery();
  const d: GetMem0DataResponse | undefined = data;

  return (
    <StudioPanel>
      <StudioPanelHeader
        actions={
          <Button
            disabled={isFetching}
            onClick={() => refetch()}
            size="sm"
            variant="ghost"
          >
            {t('web.graph.refresh')}
          </Button>
        }
        icon={<Database className="size-4 text-muted-foreground" />}
        subtitle={d?.available ? String(d.total) : undefined}
        title={t('web.settings.mem0')}
      />

      {!isLoading && !d?.available ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center text-muted-foreground text-sm">
          <Database className="size-8 opacity-40" />
          <p>{t('web.mem0.inactive')}</p>
          <p className="text-xs">{t('web.mem0.inactiveHint')}</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          {/* Stats */}
          <section className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="text-sm">
              <span className="font-medium">{d?.total ?? 0}</span>{' '}
              <span className="text-muted-foreground">{t('web.mem0.memories')}</span>
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <Boxes className="size-3.5" />
              {d?.vectorStore}
              {d?.qdrant ? ` · ${d.qdrant.phase}` : ''}
            </span>
            <div className="flex flex-wrap items-center gap-3">
              {d?.scopeCounts.map((s) => (
                <span
                  className="flex items-center gap-1.5 text-muted-foreground text-xs"
                  key={s.scope}
                >
                  <span
                    className="inline-block size-2.5 rounded-full"
                    style={{ background: colorForScope(s.scope) }}
                  />
                  {scopeLabel(s.scope)} · {s.count}
                </span>
              ))}
            </div>
          </section>

          {/* Cluster map */}
          <section className="flex flex-col gap-2">
            <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {t('web.mem0.cluster')}
            </h3>
            <div className="rounded-lg border bg-muted/20 p-2">
              <ClusterMap entries={d?.entries ?? []} />
            </div>
          </section>

          {/* Entry list */}
          <section className="flex flex-col gap-2">
            <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {t('web.mem0.entries')}
            </h3>
            {(d?.entries.length ?? 0) === 0 ? (
              <p className="text-muted-foreground text-sm">{t('web.mem0.noEntries')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {d?.entries.map((e) => (
                  <li
                    className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
                    key={e.id}
                  >
                    <span
                      className="mt-1.5 inline-block size-2 shrink-0 rounded-full"
                      style={{ background: colorForScope(e.scope) }}
                      title={scopeLabel(e.scope)}
                    />
                    <span className="min-w-0 break-words">{e.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </StudioPanel>
  );
}
