import type { QdrantPhase } from '@monad/protocol';

import { CloudIcon, HardDriveIcon, LoaderPinwheelIcon, ShieldQuestionMarkIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useGetMemoryStatusQuery,
  usePrepareMemoryBackendMutation,
  useSetMem0ModelsMutation,
  useSetMemoryBackendMutation
} from '@monad/client-rtk';
import {
  Badge,
  Button,
  Confirm,
  cn,
  Label,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@monad/ui';
import { useEffect, useState } from 'react';

import { type TFn, useT } from '#/components/I18nProvider';
import { useModelSettings } from '#/hooks/use-model-settings';
import { formatMemoryDownloadProgress, mem0Activation } from './memory-settings-state';
import { Segmented } from './Segmented';

const DEFAULT_LLM = '__default__';
const DEFAULT_EMBED = '__embedding_role__';

function QdrantStatus({ phase, error, t }: { phase: QdrantPhase; error: string | null; t: TFn }) {
  const busy = phase === 'downloading' || phase === 'launching';
  return (
    <div className="flex items-start gap-2">
      {busy ? (
        <HugeiconsIcon
          className="mt-px size-3.5 shrink-0 animate-spin text-muted-foreground"
          icon={LoaderPinwheelIcon}
        />
      ) : (
        <div
          className={cn('mt-1 size-2 shrink-0 rounded-full', {
            'bg-muted-foreground/40': phase === 'idle',
            'bg-green-500': phase === 'ready',
            'bg-destructive': phase === 'failed'
          })}
        />
      )}
      <span className={cn('text-xs', phase === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
        {phase === 'idle' && t('web.memory.qdrantIdle')}
        {phase === 'downloading' && t('web.memory.qdrantDownloading')}
        {phase === 'launching' && t('web.memory.qdrantLaunching')}
        {phase === 'ready' && t('web.memory.qdrantReady')}
        {phase === 'failed' && t('web.memory.qdrantFailed', { error: error ?? 'failed to start' })}
      </span>
    </div>
  );
}

// L1 backend: built-in Markdown vs mem0. When mem0 is active, its model selection (chosen from the
// model registry) + the local qdrant status disclose below the toggle.
export function BackendSection() {
  const t = useT();
  const [polling, setPolling] = useState(false);
  const { data: status } = useGetMemoryStatusQuery(undefined, {
    pollingInterval: polling ? 500 : 0,
    skipPollingIfUnfocused: true
  });
  const { profiles } = useModelSettings();
  const [prepareMemoryBackend, prepareState] = usePrepareMemoryBackendMutation();
  const [setMemoryBackend] = useSetMemoryBackendMutation();
  const [setMem0Models] = useSetMem0ModelsMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);

  const isMem0 = (status?.backend ?? 'builtin') === 'mem0';
  const mem0 = status?.mem0;
  const qdrant = status?.qdrant;
  const preparation = qdrant?.preparation;
  const download =
    preparation?.phase === 'downloading'
      ? formatMemoryDownloadProgress(preparation.loadedBytes, preparation.totalBytes)
      : null;

  useEffect(() => {
    const active = prepareState.isLoading || qdrant?.phase === 'downloading' || qdrant?.phase === 'launching';
    setPolling(active);
  }, [prepareState.isLoading, qdrant?.phase]);

  const activateMem0 = async () => {
    setPrepareError(null);
    setPolling(true);
    try {
      await prepareMemoryBackend({ backend: 'mem0' }).unwrap();
      await setMemoryBackend({ backend: 'mem0' }).unwrap();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
            ? error.message
            : t('web.memory.prepareFailed');
      setPrepareError(message);
    }
  };

  const selectBackend = (backend: 'builtin' | 'mem0') => {
    if (backend === 'builtin') {
      setPrepareError(null);
      void setMemoryBackend({ backend });
      return;
    }
    if (mem0Activation(qdrant) === 'confirm') {
      setConfirmOpen(true);
      return;
    }
    void setMemoryBackend({ backend });
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <Label className="text-sm">{t('web.memory.backendLabel')}</Label>
        <p className="mt-1 max-w-prose text-muted-foreground text-sm">{t('web.memory.backendDesc')}</p>
      </div>
      <Segmented
        onChange={selectBackend}
        options={[
          { value: 'builtin', label: t('web.memory.builtin'), icon: HardDriveIcon },
          { value: 'mem0', label: 'mem0', icon: CloudIcon }
        ]}
        value={isMem0 ? 'mem0' : 'builtin'}
      />

      {download ? (
        <div
          aria-live="polite"
          className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3"
        >
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-muted-foreground">
              {t('web.memory.prepareDownloading', { asset: preparation?.assetName ?? 'Qdrant' })}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {download.total
                ? t('web.memory.downloadKnown', {
                    loaded: download.loaded,
                    total: download.total,
                    percent: String(download.percent ?? 0)
                  })
                : t('web.memory.downloadUnknown', { loaded: download.loaded })}
            </span>
          </div>
          <Progress
            className={cn(download.percent === null && 'animate-pulse')}
            value={download.percent}
          />
        </div>
      ) : null}

      {prepareError || preparation?.phase === 'failed' ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-destructive text-xs">
            {prepareError ?? preparation?.error ?? t('web.memory.prepareFailed')}
          </p>
          <Button
            onClick={() => void activateMem0()}
            size="sm"
            variant="outline"
          >
            {t('web.memory.retryDownload')}
          </Button>
        </div>
      ) : null}

      {isMem0 || prepareState.isLoading ? (
        <div className="flex flex-col gap-4 rounded-lg border bg-muted/30 p-4">
          <p className="flex items-start gap-2 text-muted-foreground text-xs">
            <HugeiconsIcon
              className="mt-px size-3.5 shrink-0"
              icon={ShieldQuestionMarkIcon}
            />
            <span>{t('web.memory.mem0Automatic')}</span>
          </p>

          <p className="text-muted-foreground text-xs">{t('web.memory.mem0Profiles')}</p>

          {qdrant ? (
            <QdrantStatus
              error={qdrant.error}
              phase={qdrant.phase}
              t={t}
            />
          ) : (
            <p className="text-muted-foreground text-xs">
              {t('web.memory.qdrantLocal')} <code className="font-code">memory.mem0.vectorStore</code>{' '}
              {t('web.memory.qdrantConfigJoin')} <code className="font-code">config.json</code>.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>{t('web.memory.extractModel')}</Label>
              <Select
                onValueChange={(v) => void setMem0Models({ llm: v === DEFAULT_LLM ? null : v })}
                value={mem0?.llm ?? DEFAULT_LLM}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_LLM}>{t('web.memory.chatDefault')}</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem
                      key={p.alias}
                      value={p.alias}
                    >
                      {p.alias}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('web.memory.embedModel')}</Label>
              <Select
                onValueChange={(v) => void setMem0Models({ embedder: v === DEFAULT_EMBED ? null : v })}
                value={mem0?.embedder ?? DEFAULT_EMBED}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_EMBED}>{t('web.memory.embedRole')}</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem
                      key={p.alias}
                      value={p.alias}
                    >
                      {p.alias}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {mem0?.error ? (
            <div className="flex items-start gap-2">
              <Badge variant="destructive">{t('web.memory.statusUnresolved')}</Badge>
              <p className="text-destructive text-xs">{mem0.error}</p>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{t('web.memory.statusReady')}</Badge>
              <p className="text-muted-foreground text-xs">
                {t('web.memory.embedDim', { dim: mem0?.embedDim ?? '—' })}
              </p>
            </div>
          )}
        </div>
      ) : null}

      <Confirm
        cancelLabel={t('web.common.cancel')}
        confirmLabel={t('web.memory.downloadAndEnable')}
        description={t('web.memory.mem0ConfirmDescription')}
        onConfirm={() => {
          setConfirmOpen(false);
          void activateMem0();
        }}
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        title={t('web.memory.mem0ConfirmTitle')}
      />
    </section>
  );
}
