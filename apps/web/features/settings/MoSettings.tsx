'use client';

import { Cancel01Icon, CatIcon, LoaderPinwheelIcon, PlayIcon, SquareIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn } from '@monad/ui';
import { useCallback, useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { useAsyncAction } from '@/hooks/use-async-action';
import { MO_ATLAS } from '@/lib/mo-atlas';
import { useMonadRuntime } from '@/lib/monad-runtime-provider';

// Atlas layout comes from the generated single source (apps/mo/assets/atlas.json → @/lib/mo-atlas),
// shared with the native shells. The /v1/mo/* endpoints are deliberately outside the Eden treaty,
// so this talks to them via plain fetch against the daemon base URL.
const TILE_W = 96; // displayed cell width (px)
const SCALE = TILE_W / MO_ATLAS.cellW;
const TILE_H = MO_ATLAS.cellH * SCALE;

interface Props {
  onClose: () => void;
}

export function MoSettings({ onClose }: Props) {
  const t = useT();
  const { baseUrl: daemonBaseUrl } = useMonadRuntime();
  const { busy, error, run } = useAsyncAction();
  const [running, setRunning] = useState<boolean | undefined>(undefined);

  const refreshStatus = useCallback(async () => {
    const res = await fetch(`${daemonBaseUrl}/v1/mo/status`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { running: boolean };
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
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
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

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            className="size-4 text-muted-foreground"
            icon={CatIcon}
          />
          <span className="font-semibold text-sm">{t('web.settings.mo')}</span>
        </div>
        <Button
          aria-label={t('web.close')}
          className="size-7"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon icon={Cancel01Icon} />
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
        <p className="text-muted-foreground text-sm">{t('web.settings.moDesc')}</p>

        <div className="flex items-center gap-3">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-xs',
              running ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'
            )}
          >
            <span className={cn('size-1.5 rounded-full', running ? 'bg-emerald-500' : 'bg-muted-foreground/50')} />
            {running ? t('web.settings.moStatusRunning') : t('web.settings.moStatusStopped')}
          </span>
          {running ? (
            <Button
              className="gap-2"
              disabled={busy}
              onClick={() => void run(() => post('/v1/mo/quit'))}
              size="sm"
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
              className="gap-2"
              disabled={busy}
              onClick={() => void run(() => post('/v1/mo/launch'))}
              size="sm"
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
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}

        <div>
          <p className="mb-3 font-medium text-sm">{t('web.settings.moPreview')}</p>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
            {MO_ATLAS.states.map(({ state, row, frames, fps }) => {
              const frame = Math.floor((now / 1000) * fps) % frames;
              return (
                <div
                  className="flex flex-col items-center gap-1"
                  key={state}
                >
                  <div
                    aria-label={state}
                    className="rounded-md border bg-muted/40"
                    role="img"
                    style={{
                      width: TILE_W,
                      height: TILE_H,
                      backgroundImage: 'url(/mochi.webp)',
                      backgroundRepeat: 'no-repeat',
                      backgroundSize: `${MO_ATLAS.cols * TILE_W}px ${MO_ATLAS.rows * TILE_H}px`,
                      backgroundPosition: `-${frame * TILE_W}px -${row * TILE_H}px`,
                      imageRendering: 'pixelated'
                    }}
                  />
                  <span className="text-[10px] text-muted-foreground">{state}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
