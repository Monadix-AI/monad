import type { ReactElement } from 'react';

export type ComposerContextUsagePanelProps = {
  approximate?: boolean;
  contextUsedLabel: string;
  limit: number;
  percent: number;
  /** Cumulative tokens reclaimed by lossless tool-result eviction so far this session. Informational
   *  — already excluded from `used`/segments upstream, shown as a separate footer line. */
  reclaimed?: number;
  reclaimedLabel?: string;
  segments?: { category: string; color?: string; label: string; tokens: number }[];
  used: number;
};

export function ComposerContextUsagePanel({
  approximate = false,
  contextUsedLabel,
  limit,
  percent,
  reclaimed,
  reclaimedLabel,
  segments,
  used
}: ComposerContextUsagePanelProps): ReactElement {
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b p-3 text-xs">
        <span>
          {percent}% {contextUsedLabel}
        </span>
        <span className="font-mono text-muted-foreground">
          {formatCompact(used)} / {formatCompact(limit)}
          {approximate ? ' ~' : ''}
        </span>
      </div>
      {segments && segments.length > 0 ? (
        <div className="flex flex-col gap-2 p-3">
          {segments.map((segment) => (
            <div
              className="flex items-center justify-between gap-4 text-xs"
              key={`${segment.category}-${segment.label}`}
            >
              <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: segment.color ?? 'hsl(215 16% 47% / 0.65)' }}
                />
                <span className="truncate">{segment.label}</span>
              </span>
              <span className="shrink-0 font-mono tabular-nums">{segment.tokens.toLocaleString()}</span>
            </div>
          ))}
        </div>
      ) : null}
      {reclaimed && reclaimed > 0 ? (
        <div className="flex items-center justify-between gap-3 border-t p-3 text-muted-foreground text-xs">
          <span>{reclaimedLabel}</span>
          <span className="shrink-0 font-mono tabular-nums">{formatCompact(reclaimed)}</span>
        </div>
      ) : null}
    </>
  );
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
