import type { MemoryScopeQuery } from '@monad/protocol';

import { DatabaseIcon, Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  factSelectors,
  skipToken,
  useAddMemoryFactMutation,
  useForgetMemoryFactMutation,
  useGetMemoryCoreQuery,
  useGetMemoryStatusQuery,
  useListMemoryFactsQuery,
  usePutMemoryCoreMutation
} from '@monad/client-rtk';
import { Badge, Button, Input, MorphChevron, Textarea } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { DataEmpty } from './DataEmpty';

export function ScopedFactsView({ readOnly, scope }: { readOnly: boolean; scope: MemoryScopeQuery }) {
  const t = useT();
  const { data: status } = useGetMemoryStatusQuery();
  const isMem0 = (status?.backend ?? 'builtin') === 'mem0';
  const factsQuery = useListMemoryFactsQuery(scope);
  const facts = factSelectors.selectAll(factsQuery.data?.facts ?? { ids: [], entities: {} });
  const [draft, setDraft] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const coreQuery = useGetMemoryCoreQuery(!readOnly && rawOpen && !isMem0 ? scope : skipToken);
  const [addFact, { isLoading: adding }] = useAddMemoryFactMutation();
  const [forgetFact] = useForgetMemoryFactMutation();
  const [putCore, { isLoading: saving }] = usePutMemoryCoreMutation();
  const rawValue = rawDraft ?? coreQuery.data?.core ?? '';

  const submitAdd = async () => {
    const content = draft.trim();
    if (!content) return;
    await addFact({ ...scope, content }).unwrap();
    setDraft('');
  };

  if (factsQuery.isLoading) {
    return <p className="p-6 text-muted-foreground text-sm">{t('web.memory.factsLoading')}</p>;
  }

  if (factsQuery.isError) {
    return (
      <DataEmpty
        action={
          <Button
            onClick={() => void factsQuery.refetch()}
            size="sm"
            variant="outline"
          >
            {t('web.memory.retry')}
          </Button>
        }
        icon={DatabaseIcon}
        title={t('web.memory.factsError')}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
      {!readOnly ? (
        <div className="flex items-center gap-2">
          <Input
            className="h-9"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitAdd();
            }}
            placeholder={t('web.memory.factPlaceholder')}
            value={draft}
          />
          <Button
            disabled={adding || !draft.trim()}
            onClick={() => void submitAdd()}
            size="sm"
          >
            <HugeiconsIcon icon={PlusSignIcon} />
            {t('web.memory.factAdd')}
          </Button>
        </div>
      ) : null}

      {facts.length === 0 ? (
        <DataEmpty
          hint={t('web.memory.noFactsHint')}
          icon={DatabaseIcon}
          title={t('web.memory.noFacts')}
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {facts.map((fact) => (
            <li
              className="group flex items-center justify-between gap-3 px-3 py-2.5"
              key={fact.id}
            >
              <span className="min-w-0 flex-1 break-words text-sm">{fact.content}</span>
              <div className="flex shrink-0 items-center gap-2">
                <Badge
                  className="font-normal"
                  variant={fact.provClass === 'user' ? 'secondary' : 'outline'}
                >
                  {t(fact.provClass === 'user' ? 'web.memory.factUser' : 'web.memory.factAutomatic')}
                </Badge>
                {!readOnly ? (
                  <Button
                    aria-label={t('web.memory.ariaForget')}
                    className="size-7 text-muted-foreground opacity-60 transition-opacity hover:text-destructive group-hover:opacity-100"
                    onClick={() => void forgetFact({ ...scope, id: fact.id })}
                    size="icon"
                    variant="ghost"
                  >
                    <HugeiconsIcon icon={Delete02Icon} />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!readOnly && !isMem0 ? (
        <div>
          <button
            className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
            onClick={() => setRawOpen((value) => !value)}
            type="button"
          >
            <MorphChevron
              className="size-3.5"
              expanded={rawOpen}
            />
            {t('web.memory.editRaw')}
          </button>
          {rawOpen ? (
            <div className="mt-2 flex flex-col gap-2">
              <Textarea
                className="min-h-48 font-code text-xs"
                onChange={(event) => setRawDraft(event.target.value)}
                value={rawValue}
              />
              <div className="flex justify-end">
                <Button
                  disabled={saving || rawDraft === null}
                  onClick={() =>
                    void putCore({ ...scope, core: rawValue })
                      .unwrap()
                      .then(() => setRawDraft(null))
                  }
                  size="sm"
                >
                  {t('web.common.save')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
