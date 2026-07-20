import type { ApprovalInboxItem, HitlInboxItem, InboxFilter, InboxItem } from '@monad/protocol';

import {
  useApproveMeshSessionMutation,
  useApproveToolMutation,
  useClarifyRespondMutation,
  useListInboxQuery,
  useMarkInboxReadMutation
} from '@monad/client-rtk';
import { cn } from '@monad/ui';
import { MentionText } from '@monad/ui/components/MentionText';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOnInView } from 'react-intersection-observer';

import { useT } from '#/components/I18nProvider';
import { PanelLoading } from '#/components/PanelLoading';
import { projectSessionPath } from '#/features/shell/routing/paths';
import { pushShellUrl } from '#/hooks/use-shell-location';
import { createInboxExposureTracker } from './exposure';

function itemTarget(item: InboxItem): string {
  const base = item.projectId ? projectSessionPath(item.projectId, item.sessionId) : `/sessions/${item.sessionId}`;
  return item.kind === 'mention' ? `${base}?msg=${encodeURIComponent(item.message.id)}` : base;
}

function formatInboxTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function ExposedInboxItem({
  item,
  onSeen,
  children
}: {
  item: InboxItem;
  onSeen: (key: string) => void;
  children: React.ReactNode;
}) {
  const tracker = useMemo(() => createInboxExposureTracker({ dwellMs: 500, onSeen }), [onSeen]);
  const observe = useOnInView((inView) => tracker.setVisible(item.itemKey, inView), {
    threshold: 0.5,
    trackVisibility: true,
    delay: 100
  });

  useEffect(() => {
    const update = () => tracker.setPageVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      tracker.dispose();
    };
  }, [tracker]);

  return <div ref={observe}>{children}</div>;
}

function ApprovalActions({
  item,
  resolving,
  onResolve
}: {
  item: ApprovalInboxItem;
  resolving: boolean;
  onResolve: (allow: boolean) => void;
}) {
  const t = useT();
  if (item.actionState !== 'needs-response') return null;
  return (
    <div className="mt-1 flex items-center justify-end gap-2">
      <button
        className="rounded-(--radius-sm) border border-destructive/30 px-2.5 py-1.5 text-destructive text-xs hover:bg-destructive/10"
        disabled={resolving}
        onClick={() => onResolve(false)}
        type="button"
      >
        {t('web.inbox.reject')}
      </button>
      <button
        className="rounded-(--radius-sm) bg-primary px-2.5 py-1.5 text-primary-foreground text-xs hover:bg-primary/90"
        disabled={resolving}
        onClick={() => onResolve(true)}
        type="button"
      >
        {t('web.inbox.approve')}
      </button>
    </div>
  );
}

function HitlActions({
  item,
  resolving,
  onAnswer
}: {
  item: HitlInboxItem;
  resolving: boolean;
  onAnswer: (answer: string) => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState('');
  if (item.actionState !== 'needs-response') {
    return item.answer ? (
      <div className="rounded-(--radius-sm) bg-muted/60 px-3 py-2 text-sm">{item.answer}</div>
    ) : null;
  }
  const multiple = item.mode === 'multiple';
  const hasAnswer = selected.length > 0 || other.trim().length > 0;
  const answer = multiple
    ? JSON.stringify([...selected, ...(other.trim() ? [other.trim()] : [])])
    : other.trim() || selected[0] || '';
  const toggle = (option: string) => {
    setSelected((current) =>
      multiple
        ? current.includes(option)
          ? current.filter((value) => value !== option)
          : [...current, option]
        : [option]
    );
    if (!multiple) setOther('');
  };
  return (
    <div className="flex flex-col gap-2">
      {item.options?.length ? (
        <div className="flex flex-wrap gap-2">
          {item.options.map((option) => (
            <button
              aria-pressed={selected.includes(option)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs transition',
                selected.includes(option)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:bg-accent'
              )}
              key={option}
              onClick={() => toggle(option)}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {item.allowOther !== false || !item.options?.length ? (
        <textarea
          className="min-h-20 resize-y rounded-(--radius-sm) border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          onChange={(event) => setOther(event.target.value)}
          placeholder={t('web.inbox.answerPlaceholder')}
          value={other}
        />
      ) : null}
      <div className="flex justify-end">
        <button
          className="rounded-(--radius-sm) bg-primary px-3 py-1.5 text-primary-foreground text-xs disabled:opacity-50"
          disabled={resolving || !hasAnswer}
          onClick={() => onAnswer(answer)}
          type="button"
        >
          {t('web.inbox.sendAnswer')}
        </button>
      </div>
    </div>
  );
}

function InboxItemRow({
  item,
  resolving,
  onResolveApproval,
  onAnswer
}: {
  item: InboxItem;
  resolving: boolean;
  onResolveApproval: (item: ApprovalInboxItem, allow: boolean) => void;
  onAnswer: (item: HitlInboxItem, answer: string) => void;
}) {
  const t = useT();
  const title = item.projectName ?? item.sessionTitle ?? t('web.inbox.unknownContext');
  const actor =
    item.kind === 'mention'
      ? item.agentName
      : item.kind === 'hitl'
        ? item.asker?.name
        : item.approvalKind === 'mesh-agent'
          ? item.provider
          : item.tool;
  const preview =
    item.kind === 'mention' ? (
      <MentionText text={item.message.text} />
    ) : item.kind === 'hitl' ? (
      item.question
    ) : (
      (item.text ?? item.tool ?? t('web.inbox.approvalRequest'))
    );
  return (
    <article
      className={cn(
        'relative flex w-full flex-col gap-3 rounded-(--radius-md) border bg-card px-4 py-4 text-left shadow-[0_1px_2px_rgb(0_0_0/0.035)]',
        item.readAt ? 'border-border/60' : 'border-primary/35'
      )}
    >
      {!item.readAt ? (
        <>
          <span className="sr-only">{t('web.inbox.unread')}</span>
          <span
            aria-hidden="true"
            className="absolute top-4 left-1.5 size-1.5 rounded-full bg-primary"
          />
        </>
      ) : null}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-sm">{title}</div>
          {actor ? <div className="truncate text-muted-foreground text-xs">@{actor}</div> : null}
        </div>
        <time className="shrink-0 text-muted-foreground text-xs">{formatInboxTime(item.createdAt)}</time>
      </div>
      <div className="text-[0.9375rem] text-foreground leading-relaxed">{preview}</div>
      {item.kind === 'approval' ? (
        <ApprovalActions
          item={item}
          onResolve={(allow) => onResolveApproval(item, allow)}
          resolving={resolving}
        />
      ) : null}
      {item.kind === 'hitl' ? (
        <HitlActions
          item={item}
          onAnswer={(answer) => onAnswer(item, answer)}
          resolving={resolving}
        />
      ) : null}
      <button
        className="self-start text-muted-foreground text-xs hover:text-foreground"
        onClick={() => pushShellUrl(itemTarget(item))}
        type="button"
      >
        {t('web.inbox.openSession')}
      </button>
    </article>
  );
}

const FILTERS: InboxFilter[] = ['all', 'needs-response', 'unread', 'completed'];

export function InboxRoute() {
  const t = useT();
  const [filter, setFilter] = useState<InboxFilter>('all');
  const { data, error, isLoading, isFetching, refetch } = useListInboxQuery({ filter, limit: 100 });
  const [approveTool] = useApproveToolMutation();
  const [approveMeshSession] = useApproveMeshSessionMutation();
  const [clarifyRespond] = useClarifyRespondMutation();
  const [markRead] = useMarkInboxReadMutation();
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pendingRead = useRef(new Set<string>());
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const items = data?.items ?? [];

  const reportSeen = useCallback(
    (itemKey: string) => {
      pendingRead.current.add(itemKey);
      if (readTimer.current) return;
      readTimer.current = setTimeout(() => {
        const itemKeys = [...pendingRead.current];
        pendingRead.current.clear();
        readTimer.current = null;
        if (itemKeys.length) void markRead({ itemKeys });
      }, 200);
    },
    [markRead]
  );

  useEffect(
    () => () => {
      if (readTimer.current) clearTimeout(readTimer.current);
    },
    []
  );

  const resolveApproval = async (item: ApprovalInboxItem, allow: boolean) => {
    setResolvingId(item.id);
    setActionError(null);
    try {
      if (item.approvalKind === 'mesh-agent' && item.meshSessionId) {
        await approveMeshSession({
          id: item.meshSessionId,
          transcriptTargetId: item.sessionId,
          requestId: item.id,
          allow,
          ...(allow ? {} : { reason: 'denied from Inbox' })
        }).unwrap();
      } else {
        const result = await approveTool({
          requestId: item.id,
          allow,
          scope: 'once',
          ...(allow ? {} : { reason: 'denied from Inbox' })
        }).unwrap();
        if (!result.ok) throw new Error(t('web.inbox.noLongerPending'));
      }
      await refetch();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('web.inbox.actionError'));
    } finally {
      setResolvingId(null);
    }
  };

  const answerHitl = async (item: HitlInboxItem, answer: string) => {
    setResolvingId(item.id);
    setActionError(null);
    try {
      const result = await clarifyRespond({ requestId: item.requestId, answer }).unwrap();
      if (result.status !== 'answered') throw new Error(t('web.inbox.noLongerPending'));
      await refetch();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('web.inbox.actionError'));
    } finally {
      setResolvingId(null);
    }
  };

  if (isLoading) return <PanelLoading />;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex flex-none items-center justify-between border-border/60 border-b px-6 py-4">
        <div className="min-w-0">
          <h1 className="font-semibold text-lg">{t('web.inbox.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('web.inbox.subtitle')}</p>
        </div>
        <button
          className="rounded-(--radius-sm) px-2.5 py-1.5 text-muted-foreground text-sm hover:bg-accent"
          disabled={isFetching}
          onClick={() => void refetch()}
          type="button"
        >
          {isFetching ? t('web.inbox.refreshing') : t('web.refresh')}
        </button>
      </header>
      <div className="flex flex-none gap-1 border-border/60 border-b px-6 py-2">
        {FILTERS.map((value) => (
          <button
            aria-pressed={filter === value}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs',
              filter === value ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent'
            )}
            key={value}
            onClick={() => setFilter(value)}
            type="button"
          >
            {t(`web.inbox.filter.${value}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {actionError ? (
          <div className="mx-auto mb-3 max-w-3xl rounded-(--radius-md) border border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive text-sm">
            {actionError}
          </div>
        ) : null}
        {error ? (
          <div className="rounded-(--radius-md) border border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive text-sm">
            {t('web.inbox.loadError')}
          </div>
        ) : items.length === 0 ? (
          <div className="flex min-h-80 flex-col items-center justify-center text-center">
            <div className="font-medium text-sm">{t('web.inbox.empty')}</div>
            <div className="mt-1 max-w-sm text-muted-foreground text-sm">{t('web.inbox.emptyHint')}</div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            {items.map((item) => (
              <ExposedInboxItem
                item={item}
                key={item.itemKey}
                onSeen={reportSeen}
              >
                <InboxItemRow
                  item={item}
                  onAnswer={(hitl, answer) => void answerHitl(hitl, answer)}
                  onResolveApproval={(approval, allow) => void resolveApproval(approval, allow)}
                  resolving={resolvingId === item.id}
                />
              </ExposedInboxItem>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
