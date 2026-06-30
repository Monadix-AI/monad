'use client';

import type { QdrantPhase } from '@monad/protocol';

import { useGetMemoryStatusQuery, useSetMem0ModelsMutation, useSetMemoryBackendMutation } from '@monad/client-rtk';
import { Badge, cn, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@monad/ui';
import { Cloud, HardDrive, Loader2, ShieldOff } from 'lucide-react';

import { type TFn, useT } from '@/components/I18nProvider';
import { useModelSettings } from '@/hooks/use-model-settings';
import { Segmented } from './Segmented';

const DEFAULT_LLM = '__default__';
const DEFAULT_EMBED = '__embedding_role__';

function QdrantStatus({ phase, error, t }: { phase: QdrantPhase; error: string | null; t: TFn }) {
  const busy = phase === 'downloading' || phase === 'launching';
  return (
    <div className="flex items-start gap-2">
      {busy ? (
        <Loader2 className="mt-px size-3.5 shrink-0 animate-spin text-muted-foreground" />
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
  const { data: status } = useGetMemoryStatusQuery();
  const { profiles } = useModelSettings();
  const [setMemoryBackend] = useSetMemoryBackendMutation();
  const [setMem0Models] = useSetMem0ModelsMutation();

  const isMem0 = (status?.backend ?? 'builtin') === 'mem0';
  const mem0 = status?.mem0;
  const qdrant = status?.qdrant;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <Label className="text-sm">{t('web.memory.backendLabel')}</Label>
        <p className="mt-1 max-w-prose text-muted-foreground text-sm">{t('web.memory.backendDesc')}</p>
      </div>
      <Segmented
        onChange={(v) => void setMemoryBackend({ backend: v })}
        options={[
          { value: 'builtin', label: t('web.memory.builtin'), icon: HardDrive },
          { value: 'mem0', label: 'mem0', icon: Cloud }
        ]}
        value={isMem0 ? 'mem0' : 'builtin'}
      />

      {isMem0 ? (
        <div className="flex flex-col gap-4 rounded-lg border bg-muted/30 p-4">
          <p className="flex items-start gap-2 text-muted-foreground text-xs">
            <ShieldOff className="mt-px size-3.5 shrink-0" />
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
              {t('web.memory.qdrantLocal')} <code className="font-mono">memory.mem0.vectorStore</code>{' '}
              {t('web.memory.qdrantConfigJoin')} <code className="font-mono">config.json</code>.
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
    </section>
  );
}
