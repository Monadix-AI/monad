import { LoaderPinwheelIcon, PlayIcon, SquareIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn, Skeleton } from '@monad/ui';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { useT } from '#/components/I18nProvider';
import { useAsyncAction } from '#/hooks/use-async-action';
import { useMonadRuntime } from '#/lib/monad-runtime-context';
import moAtlasManifest from '../../../../mo/assets/atlas.json' with { type: 'json' };

const moStatusSchema = z.object({ running: z.boolean() });
const errorResponseSchema = z.object({ error: z.string().optional() }).nullable();

const MO_ATLAS = {
  cols: moAtlasManifest.columns,
  rows: moAtlasManifest.rows,
  cellW: moAtlasManifest.cell_width,
  cellH: moAtlasManifest.cell_height,
  states: moAtlasManifest.states
};

const TILE_W = 96; // displayed cell width (px)
const SCALE = TILE_W / MO_ATLAS.cellW;
const TILE_H = MO_ATLAS.cellH * SCALE;
const HERO_TILE_W = 148;
const HERO_TILE_H = MO_ATLAS.cellH * (HERO_TILE_W / MO_ATLAS.cellW);
const MO_SKELETON_PREVIEW_IDS = ['idle', 'walk', 'drop', 'think', 'sleep', 'wake'] as const;

type MoAtlasState = (typeof MO_ATLAS.states)[number];

function MoSprite({
  frame,
  label,
  row,
  tileH = TILE_H,
  tileW = TILE_W
}: {
  frame: number;
  label: string;
  row: number;
  tileH?: number;
  tileW?: number;
}) {
  return (
    <div
      aria-label={label}
      className="rounded-lg border border-border/70 bg-muted/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]"
      role="img"
      style={{
        width: tileW,
        height: tileH,
        backgroundImage: 'url(/mochi.webp)',
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${MO_ATLAS.cols * tileW}px ${MO_ATLAS.rows * tileH}px`,
        backgroundPosition: `-${frame * tileW}px -${row * tileH}px`,
        imageRendering: 'pixelated'
      }}
    />
  );
}

function MoStatusBadge({ running, t }: { running: boolean | undefined; t: ReturnType<typeof useT> }) {
  const checking = running === undefined;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium text-xs',
        checking
          ? 'border-border/70 bg-muted text-muted-foreground'
          : running
            ? 'border-emerald-500/20 bg-emerald-500/12 text-emerald-700'
            : 'border-border/70 bg-background/80 text-muted-foreground'
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          checking ? 'animate-pulse bg-muted-foreground/45' : running ? 'bg-emerald-500' : 'bg-muted-foreground/50'
        )}
      />
      {checking
        ? t('web.settings.moStatusChecking')
        : running
          ? t('web.settings.moStatusRunning')
          : t('web.settings.moStatusStopped')}
    </span>
  );
}

function MoPreviewTile({ frame, item, t }: { frame: number; item: MoAtlasState; t: ReturnType<typeof useT> }) {
  return (
    <div className="group flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card/70 p-2.5 transition-[background-color,border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-border hover:bg-card">
      <div className="flex justify-center">
        <MoSprite
          frame={frame}
          label={item.state}
          row={item.row}
        />
      </div>
      <div className="min-w-0">
        <p className="truncate font-medium text-xs">{item.state}</p>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {item.frames} {t('web.settings.moFrames')} / {item.fps} fps
        </p>
      </div>
    </div>
  );
}

function MoSettingsSkeleton() {
  return (
    <div
      aria-busy="true"
      className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6"
    >
      <Skeleton className="h-4 w-3/5 rounded" />
      <div className="grid gap-4 lg:grid-cols-[minmax(280px,0.82fr)_minmax(0,1.18fr)]">
        <section className="rounded-xl border border-border/70 bg-card/70 p-5">
          <Skeleton className="h-3 w-24 rounded" />
          <Skeleton className="mx-auto mt-8 h-28 w-32 rounded-lg" />
          <Skeleton className="mt-8 h-8 w-full rounded-md" />
        </section>
        <section className="rounded-xl border border-border/70 bg-card p-5">
          <Skeleton className="h-3 w-32 rounded" />
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {MO_SKELETON_PREVIEW_IDS.map((id) => (
              <Skeleton
                className="h-28 rounded-xl"
                key={id}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export function MoSettings() {
  const t = useT();
  const { baseUrl: daemonBaseUrl } = useMonadRuntime();
  const { busy, error, run } = useAsyncAction();
  const [running, setRunning] = useState<boolean | undefined>(undefined);

  const refreshStatus = useCallback(async () => {
    const res = await fetch(`${daemonBaseUrl}/v1/mo/status`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = moStatusSchema.parse(await res.json());
    setRunning(body.running);
  }, [daemonBaseUrl]);

  // Poll status on mount + every 3s (Mo can also be launched/quit from the cli, so reflect that).
  useEffect(() => {
    void refreshStatus().catch(() => setRunning(undefined));
    const id = setInterval(() => void refreshStatus().catch(() => {}), 3000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const post = async (path: string) => {
    const res = await fetch(`${daemonBaseUrl}${path}`, { method: 'POST' });
    if (!res.ok) {
      const body = errorResponseSchema.parse(await res.json().catch(() => null));
      throw new Error(body?.error ?? `request failed (${res.status})`);
    }
    await refreshStatus();
  };

  // Animation clock for the previews. ~12fps is plenty for the ≤10fps rows; pause entirely while the
  // tab is hidden so a backgrounded settings panel does no work.
  const [now, setNow] = useState(0);
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      id ??= setInterval(() => setNow(performance.now()), 80);
    };
    const stop = () => {
      if (id) {
        clearInterval(id);
        id = undefined;
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const featuredState = MO_ATLAS.states[0];
  const featuredFrame = featuredState ? Math.floor((now / 1000) * featuredState.fps) % featuredState.frames : 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {running === undefined ? (
        <MoSettingsSkeleton />
      ) : (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
          <div className="max-w-2xl">
            <p className="text-muted-foreground text-sm leading-relaxed">{t('web.settings.moDesc')}</p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(280px,0.82fr)_minmax(0,1.18fr)]">
            <section className="relative overflow-hidden rounded-xl border border-border/70 bg-card/75 p-4 shadow-[0_18px_42px_-34px_rgba(15,23,42,0.45)] sm:p-5">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_30%_0%,rgba(16,185,129,0.13),transparent_48%),linear-gradient(90deg,rgba(15,23,42,0.08),transparent)]"
              />
              <div className="relative flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-sm">{t('web.settings.moControl')}</h3>
                  <p className="mt-1 text-muted-foreground text-xs">{t('web.settings.moControlDesc')}</p>
                </div>
                <MoStatusBadge
                  running={running}
                  t={t}
                />
              </div>

              <div className="relative mt-8 flex flex-col items-center text-center">
                {featuredState && (
                  <MoSprite
                    frame={featuredFrame}
                    label={featuredState.state}
                    row={featuredState.row}
                    tileH={HERO_TILE_H}
                    tileW={HERO_TILE_W}
                  />
                )}
                <p className="mt-4 font-semibold text-base">{t('web.settings.moDesktopSprite')}</p>
                <p className="mt-1 max-w-64 text-muted-foreground text-xs leading-relaxed">
                  {running ? t('web.settings.moRunningHelp') : t('web.settings.moStoppedHelp')}
                </p>
              </div>

              <div className="relative mt-6">
                {running ? (
                  <Button
                    className="w-full gap-2 active:translate-y-[1px]"
                    disabled={busy}
                    onClick={() => void run(() => post('/v1/mo/quit'))}
                    variant="secondary"
                  >
                    {busy ? (
                      <HugeiconsIcon
                        className="size-4 animate-spin"
                        icon={LoaderPinwheelIcon}
                      />
                    ) : (
                      <HugeiconsIcon
                        className="size-4"
                        icon={SquareIcon}
                      />
                    )}
                    {t('web.settings.moQuit')}
                  </Button>
                ) : (
                  <Button
                    className="w-full gap-2 active:translate-y-[1px]"
                    disabled={busy}
                    onClick={() => void run(() => post('/v1/mo/launch'))}
                  >
                    {busy ? (
                      <HugeiconsIcon
                        className="size-4 animate-spin"
                        icon={LoaderPinwheelIcon}
                      />
                    ) : (
                      <HugeiconsIcon
                        className="size-4"
                        icon={PlayIcon}
                      />
                    )}
                    {t('web.settings.moLaunch')}
                  </Button>
                )}
                {error && (
                  <p className="mt-3 rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-destructive text-xs">
                    {error}
                  </p>
                )}
              </div>
            </section>

            <section className="rounded-xl border border-border/70 bg-card p-4 shadow-[0_18px_42px_-34px_rgba(15,23,42,0.42)] sm:p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-sm">{t('web.settings.moPreview')}</h3>
                  <p className="mt-1 text-muted-foreground text-xs">{t('web.settings.moPreviewDesc')}</p>
                </div>
                <span className="shrink-0 rounded-full border border-border/70 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  {MO_ATLAS.states.length} {t('web.settings.moStates')}
                </span>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {MO_ATLAS.states.map((item) => {
                  const frame = Math.floor((now / 1000) * item.fps) % item.frames;
                  return (
                    <MoPreviewTile
                      frame={frame}
                      item={item}
                      key={item.state}
                      t={t}
                    />
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
