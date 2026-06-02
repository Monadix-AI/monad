import type { MemoryPanelProps } from './types';

import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  factSelectors,
  useAddMemoryFactMutation,
  useForgetMemoryFactMutation,
  useGetMemoryStatusQuery,
  useListMemoryFactsQuery
} from '@monad/client-rtk';
import { Badge, Button, Confirm, Input } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { SwitchSetting } from '#/components/ui/switch-setting';
import { studioPath } from '#/features/shell/routing/paths';

export function MemoryPanel({
  agentId,
  advancedMemoryEnabled,
  memoryAutoConsolidate,
  memoryEnabled,
  memoryIntervalMinutes,
  setAdvancedMemoryEnabled,
  setMemoryAutoConsolidate,
  setMemoryEnabled,
  setMemoryIntervalMinutes
}: MemoryPanelProps) {
  const t = useT();
  const scope = { scopeKind: 'agent' as const, scopeId: agentId };
  const { data: status } = useGetMemoryStatusQuery();
  const { data, isLoading } = useListMemoryFactsQuery(scope);
  const facts = factSelectors.selectAll(data?.facts ?? { ids: [], entities: {} });
  const [draft, setDraft] = useState('');
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const [forgetFailed, setForgetFailed] = useState(false);
  const [addFact, { isLoading: adding }] = useAddMemoryFactMutation();
  const [forgetFact, { isLoading: forgetting }] = useForgetMemoryFactMutation();

  const add = async () => {
    const content = draft.trim();
    if (!content) return;
    await addFact({ ...scope, content }).unwrap();
    setDraft('');
  };

  return (
    <div className="space-y-5">
      <div className="divide-y rounded-xl border">
        <SwitchSetting
          checked={memoryEnabled}
          className="p-3"
          description={t('web.studio.agentEditor.memory.enabledHint')}
          onCheckedChange={setMemoryEnabled}
          title={t('web.studio.agentEditor.memory.enabled')}
        />
        <SwitchSetting
          checked={advancedMemoryEnabled}
          className="p-3"
          description={t('web.studio.agentEditor.memory.advancedHint')}
          disabled={!memoryEnabled}
          onCheckedChange={setAdvancedMemoryEnabled}
          title={t('web.studio.agentEditor.memory.advanced')}
        />
        <SwitchSetting
          checked={memoryAutoConsolidate}
          className="p-3"
          description={t('web.studio.agentEditor.memory.autoConsolidateHint')}
          disabled={!memoryEnabled}
          onCheckedChange={setMemoryAutoConsolidate}
          title={t('web.studio.agentEditor.memory.autoConsolidate')}
        />
        <div className="flex items-center justify-between gap-4 p-3">
          <span>
            <span className="block font-medium text-sm">{t('web.studio.agentEditor.memory.interval')}</span>
            <span className="block text-muted-foreground text-xs">
              {t('web.studio.agentEditor.memory.intervalHint')}
            </span>
          </span>
          <Input
            aria-label={t('web.studio.agentEditor.memory.interval')}
            className="h-8 w-24"
            disabled={!memoryEnabled || !memoryAutoConsolidate}
            min={1}
            onChange={(event) => setMemoryIntervalMinutes(event.target.value)}
            type="number"
            value={memoryIntervalMinutes}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-medium text-sm">{t('web.studio.agentEditor.memory.title')}</h3>
          <p className="mt-0.5 text-muted-foreground text-xs">{t('web.studio.agentEditor.memory.hint')}</p>
        </div>
        <Badge variant={status ? 'secondary' : 'outline'}>
          {status?.backend ?? t('web.studio.agentEditor.memory.unavailable')}
        </Badge>
      </div>
      <div className="flex gap-2">
        <Input
          aria-label={t('web.studio.agentEditor.memory.newFact')}
          name="memory-fact"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add();
          }}
          placeholder={t('web.studio.agentEditor.memory.placeholder')}
          value={draft}
        />
        <Button
          disabled={adding || !draft.trim()}
          onClick={() => void add()}
          size="sm"
        >
          <HugeiconsIcon icon={PlusSignIcon} />
          {t('web.studio.agentEditor.memory.add')}
        </Button>
      </div>
      {isLoading ? <p className="text-muted-foreground text-xs">{t('web.studio.agentEditor.memory.loading')}</p> : null}
      {!isLoading && facts.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-muted-foreground text-xs">
          {t('web.studio.agentEditor.memory.empty')}
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {facts.map((fact) => (
            <li
              className="flex min-h-12 items-center gap-3 px-3 py-2"
              key={fact.id}
            >
              <span className="min-w-0 flex-1 break-words text-sm">{fact.content}</span>
              <Button
                aria-label={t('web.studio.agentEditor.memory.forgetAria', { content: fact.content })}
                onClick={() => {
                  setForgetFailed(false);
                  setConfirmForget(fact.id);
                }}
                size="icon"
                variant="ghost"
              >
                <HugeiconsIcon icon={Delete02Icon} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <a
        className="inline-flex min-h-9 items-center text-primary text-sm hover:underline"
        href={studioPath('memory')}
      >
        {t('web.studio.agentEditor.memory.openSettings')}
      </a>
      <Confirm
        cancelLabel={t('web.common.cancel')}
        confirmLabel={t('web.studio.agentEditor.memory.forget')}
        confirmVariant="destructive"
        description={t('web.studio.agentEditor.memory.forgetDescription')}
        error={forgetFailed ? t('web.studio.agentEditor.memory.forgetFailed') : undefined}
        onConfirm={() => {
          if (!confirmForget) return;
          setForgetFailed(false);
          void forgetFact({ ...scope, id: confirmForget })
            .unwrap()
            .then(() => setConfirmForget(null))
            .catch(() => setForgetFailed(true));
        }}
        onOpenChange={(open) => {
          if (!open) setConfirmForget(null);
        }}
        open={confirmForget !== null}
        pending={forgetting}
        pendingLabel={t('web.studio.agentEditor.memory.forgetting')}
        title={t('web.studio.agentEditor.memory.forgetTitle')}
      />
    </div>
  );
}
