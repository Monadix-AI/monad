'use client';

import { useGetMemoryStatusQuery, useSetMemoryGraphMutation } from '@monad/client-rtk';
import { Input, Label, Switch } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { Segmented } from './Segmented';

const DEFAULT_INTERVAL = 30;

// The whole memory pipeline as one control: how DEEP /consolidate runs (level), and whether it runs
// on its own (auto + interval). Level and the background timer were two separate sections before;
// they're the same concept — the timer runs the pipeline to the chosen level.
export function ConsolidationSection() {
  const t = useT();
  const { data: status } = useGetMemoryStatusQuery();
  const [setMemoryGraph] = useSetMemoryGraphMutation();
  const [intervalDraft, setIntervalDraft] = useState<string | null>(null);

  const level = status?.level ?? 1;
  const auto = status?.graph?.autoConsolidate ?? false;
  const interval = status?.graph?.intervalMinutes ?? DEFAULT_INTERVAL;
  const intervalValue = intervalDraft ?? String(interval);
  const commitInterval = () => {
    if (intervalDraft === null) return;
    const n = Number.parseInt(intervalDraft, 10);
    if (Number.isFinite(n) && n > 0 && n !== interval) void setMemoryGraph({ intervalMinutes: n });
    setIntervalDraft(null);
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <Label className="text-sm">{t('web.memory.consolidationLabel')}</Label>
        <p className="mt-1 max-w-prose text-muted-foreground text-sm">{t('web.memory.consolidationDesc')}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Segmented
          onChange={(v) => void setMemoryGraph({ level: Number(v) })}
          options={[
            { value: '1', label: 'L1' },
            { value: '2', label: 'L2' },
            { value: '3', label: 'L3' }
          ]}
          value={String(level)}
        />
        <p className="text-muted-foreground text-xs">{t(`web.memory.level${level}`)}</p>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <div className="min-w-0">
          <Label className="text-sm">{t('web.memory.graphAuto')}</Label>
          <p className="mt-0.5 text-muted-foreground text-xs">{t('web.memory.graphAutoDesc')}</p>
        </div>
        <Switch
          aria-label={t('web.memory.graphAuto')}
          checked={auto}
          onCheckedChange={(v) => void setMemoryGraph({ autoConsolidate: v })}
        />
      </div>

      {auto ? (
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label>{t('web.memory.graphInterval')}</Label>
          <Input
            className="h-9"
            min={1}
            onBlur={commitInterval}
            onChange={(e) => setIntervalDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitInterval();
            }}
            type="number"
            value={intervalValue}
          />
        </div>
      ) : null}
    </section>
  );
}
