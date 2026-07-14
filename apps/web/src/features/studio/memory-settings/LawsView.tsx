import type { LawView } from '@monad/protocol';

import {
  Alert01Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  HistoryIcon,
  JusticeScaleIcon,
  NeuralNetworkIcon,
  QuoteUpIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useGetLawsQuery } from '@monad/client-rtk';
import { Badge, Button, Skeleton } from '@monad/ui';
import { useMemo, useState } from 'react';

import { type TFn, useT } from '#/components/I18nProvider';
import { DataEmpty } from './DataEmpty';
import { scopeLabel } from './scope';

function LawsSkeleton() {
  return (
    <div
      aria-busy="true"
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-4"
    >
      {Array.from({ length: 2 }, (_, section) => `laws-section-${section}`).map((key) => (
        <section
          className="flex flex-col gap-2"
          key={key}
        >
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-28 rounded" />
            <Skeleton className="h-5 w-8 rounded-full" />
          </div>
          <ul className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, row) => `${key}-row-${row}`).map((rowKey) => (
              <li
                className="rounded-lg border p-3"
                key={rowKey}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-full rounded" />
                    <Skeleton className="h-4 w-3/4 rounded" />
                  </div>
                  <Skeleton className="h-5 w-10 rounded-full" />
                </div>
                <Skeleton className="mt-2 h-3 w-32 rounded" />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// One law + its grounding, expandable. The grounding is the "why do you believe X" chain: the L1
// facts the law generalizes and the L2 relations it rests on, resolved server-side from the law's
// stored id refs (so it points at real, current facts/edges — not the model's paraphrase).
function LawRow({ law, t }: { law: LawView; t: TFn }) {
  const [open, setOpen] = useState(false);
  const { facts, edges } = law.grounding;
  const count = facts.length + edges.length;

  return (
    <li className="rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <p className={law.contradictedBy ? 'text-muted-foreground text-sm line-through' : 'text-sm'}>{law.statement}</p>
        <Badge
          className="shrink-0 tabular-nums"
          title={
            law.effectiveConfidence < law.confidence - 0.005
              ? t('web.laws.decayedFrom', { peak: String(Math.round(law.confidence * 100)) })
              : undefined
          }
          variant="outline"
        >
          {Math.round(law.effectiveConfidence * 100)}%
        </Badge>
      </div>
      {law.contradictedBy ? (
        <div className="mt-1.5 flex items-start gap-1.5 text-destructive text-xs">
          <HugeiconsIcon
            className="mt-0.5 size-3.5 shrink-0"
            icon={Alert01Icon}
          />
          <span className="min-w-0 break-words">{t('web.laws.contradicted', { fact: law.contradictedBy })}</span>
        </div>
      ) : law.stale ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-muted-foreground text-xs">
          <HugeiconsIcon
            className="size-3.5 shrink-0"
            icon={HistoryIcon}
          />
          <span>{t('web.laws.stale')}</span>
        </div>
      ) : null}
      {count > 0 ? (
        <>
          <button
            className="mt-1.5 flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
            type="button"
          >
            {open ? (
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
            {t('web.laws.basedOn', { count: String(count) })}
          </button>
          {open ? (
            <ul className="mt-1.5 flex flex-col gap-1 border-t pt-1.5">
              {facts.map((f) => (
                <li
                  className="flex items-start gap-1.5 text-muted-foreground text-xs"
                  key={f.id}
                >
                  <HugeiconsIcon
                    className="mt-0.5 size-3 shrink-0 opacity-60"
                    icon={QuoteUpIcon}
                  />
                  <span className="min-w-0 break-words">{f.content}</span>
                </li>
              ))}
              {edges.map((e) => (
                <li
                  className="flex items-start gap-1.5 text-muted-foreground text-xs"
                  key={e.id}
                >
                  <HugeiconsIcon
                    className="mt-0.5 size-3 shrink-0 opacity-60"
                    icon={NeuralNetworkIcon}
                  />
                  <span className="min-w-0 break-words">{e.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

// Read-only view of the L3 inferred laws, grouped by scope (the daemon orders by scope then
// confidence). Laws are injected into recall; this is where a user sees what the agent generalized
// and why. Re-derive with /consolidate at memory level 3, then refresh.
export function LawsView() {
  const t = useT();
  const { data, isLoading, isFetching, refetch } = useGetLawsQuery();

  const byScope = useMemo(() => {
    const groups = new Map<string, LawView[]>();
    for (const law of data?.laws ?? []) {
      const list = groups.get(law.scope) ?? [];
      list.push(law);
      groups.set(law.scope, list);
    }
    return [...groups.entries()];
  }, [data]);

  const empty = !isLoading && byScope.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-6 py-2">
        <span className="text-muted-foreground text-xs tabular-nums">{data ? data.laws.length : ''}</span>
        <Button
          className="ml-auto"
          disabled={isFetching}
          onClick={() => refetch()}
          size="sm"
          variant="ghost"
        >
          {t('web.graph.refresh')}
        </Button>
      </div>
      {isLoading ? (
        <LawsSkeleton />
      ) : empty ? (
        <DataEmpty
          hint={t('web.laws.empty')}
          icon={JusticeScaleIcon}
          title={t('web.laws.emptyTitle')}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-4">
          {byScope.map(([scope, laws]) => (
            <section
              className="flex flex-col gap-2"
              key={scope}
            >
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-sm">{scopeLabel(scope)}</h3>
                <Badge variant="secondary">{laws.length}</Badge>
              </div>
              <ul className="flex flex-col gap-2">
                {laws.map((law) => (
                  <LawRow
                    key={law.id}
                    law={law}
                    t={t}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
