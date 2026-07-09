'use client';

import type { MemoryScopeQuery, ScopeKind } from '@monad/protocol';

import {
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  Delete02Icon,
  PlusSignIcon
} from '@hugeicons/core-free-icons';
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
import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea
} from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { DataEmpty } from './DataEmpty';
import { Segmented } from './Segmented';

// L1 facts: browse/add/forget the durable facts the agent has saved, per scope. The built-in backend
// also exposes the raw MEMORY.md behind a disclosure. Pulled out of Settings so config and data
// stay separate — this is the L1 sibling of the Graph (L2) and Laws (L3) tabs.
export function FactsView() {
  const t = useT();
  const { data: status } = useGetMemoryStatusQuery();
  const isMem0 = (status?.backend ?? 'builtin') === 'mem0';

  const [scopeKind, setScopeKind] = useState<ScopeKind>('global');
  const [scopeId, setScopeId] = useState('');
  const [draft, setDraft] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const [rawDraft, setRawDraft] = useState<string | null>(null);

  const effectiveId = (scopeKind === 'global' ? '*' : scopeId.trim()) as MemoryScopeQuery['scopeId'];
  const ready = scopeKind === 'global' || effectiveId.length > 0;
  const query = ready ? { scopeKind, scopeId: effectiveId } : skipToken;

  const { data: factData } = useListMemoryFactsQuery(query);
  const facts = factSelectors.selectAll(factData?.facts ?? { ids: [], entities: {} });
  const { data: core } = useGetMemoryCoreQuery(
    rawOpen && ready && !isMem0 ? { scopeKind, scopeId: effectiveId } : skipToken
  );
  const [addFact, { isLoading: adding }] = useAddMemoryFactMutation();
  const [forgetFact] = useForgetMemoryFactMutation();
  const [putCore, { isLoading: saving }] = usePutMemoryCoreMutation();

  const rawValue = rawDraft ?? core?.core ?? '';
  const submitAdd = () => {
    const content = draft.trim();
    if (!content || !ready) return;
    void addFact({ scopeKind, scopeId: effectiveId, content }).then(() => setDraft(''));
  };

  const SCOPES: { value: ScopeKind; label: string }[] = [
    { value: 'global', label: t('web.memory.scopeGlobal') },
    { value: 'project', label: t('web.memory.scopeProject') },
    { value: 'agent', label: t('web.memory.scopeAgent') },
    { value: 'session', label: t('web.memory.scopeSession') }
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
        <Segmented
          onChange={(v) => {
            setScopeKind(v);
            setRawDraft(null);
            setRawOpen(false);
          }}
          options={SCOPES}
          value={scopeKind}
        />
        {scopeKind === 'project' ? (
          <Select
            onValueChange={setScopeId}
            value={scopeId}
          >
            <SelectTrigger className="h-8 w-64">
              <SelectValue placeholder={t('web.memory.pickProject')} />
            </SelectTrigger>
            <SelectContent>
              {(status?.projects ?? []).map((p) => (
                <SelectItem
                  key={p.key}
                  value={p.key}
                >
                  {p.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : scopeKind === 'agent' || scopeKind === 'session' ? (
          <Input
            className="h-8 w-56 font-mono text-xs"
            onChange={(e) => setScopeId(e.target.value)}
            placeholder={scopeKind === 'agent' ? 'agt_…' : 'ses_…'}
            value={scopeId}
          />
        ) : null}
      </div>

      {ready ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
          <div className="flex items-center gap-2">
            <Input
              className="h-9"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAdd();
              }}
              placeholder={t('web.memory.factPlaceholder')}
              value={draft}
            />
            <Button
              disabled={adding || !draft.trim()}
              onClick={submitAdd}
              size="sm"
            >
              <HugeiconsIcon
                className="size-4"
                icon={PlusSignIcon}
              />{' '}
              {t('web.memory.factAdd')}
            </Button>
          </div>

          {facts.length === 0 ? (
            <DataEmpty
              hint={t('web.memory.noFactsHint')}
              icon={DatabaseIcon}
              title={t('web.memory.noFacts')}
            />
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {facts.map((f) => (
                <li
                  className="group flex items-center justify-between gap-3 px-3 py-2.5"
                  key={f.id}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{f.content}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge
                      className="font-normal"
                      variant={f.provClass === 'user' ? 'secondary' : 'outline'}
                    >
                      {f.provClass === 'user' ? 'you' : 'auto'}
                    </Badge>
                    <Button
                      aria-label={t('web.memory.ariaForget')}
                      className="size-7 text-muted-foreground opacity-60 transition-opacity hover:text-destructive group-hover:opacity-100"
                      onClick={() => void forgetFact({ scopeKind, scopeId: effectiveId, id: f.id })}
                      size="icon"
                      variant="ghost"
                    >
                      <HugeiconsIcon
                        className="size-4"
                        icon={Delete02Icon}
                      />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {!isMem0 ? (
            <div>
              <button
                className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
                onClick={() => setRawOpen((v) => !v)}
                type="button"
              >
                {rawOpen ? (
                  <HugeiconsIcon
                    className="size-3.5"
                    icon={ChevronDownIcon}
                  />
                ) : (
                  <HugeiconsIcon
                    className="size-3.5"
                    icon={ChevronRightIcon}
                  />
                )}
                {t('web.memory.editRaw')}
              </button>
              {rawOpen ? (
                <div className="mt-2 flex flex-col gap-2">
                  <Textarea
                    className="min-h-48 font-mono text-xs"
                    onChange={(e) => setRawDraft(e.target.value)}
                    value={rawValue}
                  />
                  <div className="flex justify-end">
                    <Button
                      disabled={saving || rawDraft === null}
                      onClick={() =>
                        void putCore({ scopeKind, scopeId: effectiveId, core: rawValue }).then(() => setRawDraft(null))
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
      ) : (
        <DataEmpty
          icon={DatabaseIcon}
          title={
            scopeKind === 'project'
              ? t('web.memory.pickProject')
              : scopeKind === 'agent'
                ? t('web.memory.enterScopeAgent')
                : t('web.memory.enterScopeSession')
          }
        />
      )}
    </div>
  );
}
