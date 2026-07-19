import type { ApprovalInboxItem, InboxItem } from '@monad/protocol';

import { useApproveMeshSessionMutation, useApproveToolMutation, useListMentionInboxQuery } from '@monad/client-rtk';
import { cn } from '@monad/ui';
import { MentionText } from '@monad/ui/components/MentionText';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { PanelLoading } from '#/components/PanelLoading';
import { projectSessionPath } from '#/features/shell/routing/paths';
import { pushShellUrl } from '#/hooks/use-shell-location';

function itemTarget(item: InboxItem): string {
  const base = item.projectId ? projectSessionPath(item.projectId, item.sessionId) : `/sessions/${item.sessionId}`;
  if (item.kind !== 'mention') return base;
  return `${base}?msg=${encodeURIComponent(item.message.id)}`;
}

function formatInboxTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function approvalPreview(item: ApprovalInboxItem): string {
  if (item.text) return item.text;
  if (item.tool) return item.tool;
  return item.approvalKind === 'mesh-agent' ? 'External agent approval' : 'Tool approval';
}

function InboxItemRow({
  item,
  resolving,
  onResolve
}: {
  item: InboxItem;
  resolving: boolean;
  onResolve: (item: ApprovalInboxItem, allow: boolean) => void;
}) {
  const t = useT();
  const title = item.projectName ?? item.sessionTitle ?? t('web.inbox.unknownContext');
  const actor =
    item.kind === 'mention' ? item.agentName : item.approvalKind === 'mesh-agent' ? item.provider : item.tool;
  const subtitle = [item.sessionTitle, actor ? `@${actor}` : null].filter(Boolean).join(' · ');
  const body = (
    <>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-sm">{title}</div>
          {subtitle ? <div className="truncate text-muted-foreground text-xs">{subtitle}</div> : null}
        </div>
        <time className="shrink-0 text-muted-foreground text-xs">{formatInboxTime(item.createdAt)}</time>
      </div>
      <div className="line-clamp-2 text-muted-foreground text-sm leading-relaxed">
        {item.kind === 'mention' ? <MentionText text={item.message.text} /> : approvalPreview(item)}
      </div>
    </>
  );
  const className = cn(
    'group flex w-full flex-col gap-2 rounded-(--radius-md) border border-border/60 bg-card/70 px-4 py-3 text-left transition',
    'hover:border-border hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
  );

  if (item.kind === 'mention') {
    return (
      <button
        className="flex w-full flex-col gap-3 rounded-(--radius-md) border border-border/60 bg-card px-4 py-4 text-left shadow-[0_1px_2px_rgb(0_0_0/0.035)] transition-colors hover:border-border hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={() => pushShellUrl(itemTarget(item))}
        type="button"
      >
        <div className="line-clamp-3 text-[0.9375rem] text-foreground leading-relaxed">
          <MentionText text={item.message.text} />
        </div>
        <div className="flex min-w-0 items-center justify-between gap-3 border-border/50 border-t pt-2.5 text-xs">
          <div className="min-w-0 truncate text-muted-foreground">
            <span className="font-medium text-foreground">{actor ?? t('web.inbox.unknownContext')}</span>
            <span> in {title}</span>
          </div>
          <time className="shrink-0 text-muted-foreground">{formatInboxTime(item.createdAt)}</time>
        </div>
      </button>
    );
  }

  return (
    <div className={className}>
      {body}
      <div className="mt-1 flex items-center justify-end gap-2">
        <button
          className="rounded-(--radius-sm) px-2.5 py-1.5 text-muted-foreground text-xs hover:bg-accent"
          onClick={() => pushShellUrl(itemTarget(item))}
          type="button"
        >
          Open session
        </button>
        <button
          className="rounded-(--radius-sm) border border-destructive/30 px-2.5 py-1.5 text-destructive text-xs hover:bg-destructive/10"
          disabled={resolving}
          onClick={() => onResolve(item, false)}
          type="button"
        >
          Reject
        </button>
        <button
          className="rounded-(--radius-sm) bg-primary px-2.5 py-1.5 text-primary-foreground text-xs hover:bg-primary/90"
          disabled={resolving}
          onClick={() => onResolve(item, true)}
          type="button"
        >
          Approve
        </button>
      </div>
    </div>
  );
}

export function InboxRoute() {
  const t = useT();
  const { data, error, isLoading, isFetching, refetch } = useListMentionInboxQuery({ limit: 100 });
  const [approveTool] = useApproveToolMutation();
  const [approveMeshSession] = useApproveMeshSessionMutation();
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const items = data?.items ?? [];

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
        if (!result.ok) throw new Error('The approval is no longer pending.');
      }
      await refetch();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Unable to resolve approval.');
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
          className="rounded-(--radius-sm) px-2.5 py-1.5 text-muted-foreground text-sm transition hover:bg-accent hover:text-foreground"
          disabled={isFetching}
          onClick={() => void refetch()}
          type="button"
        >
          {isFetching ? t('web.inbox.refreshing') : t('web.refresh')}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {actionError ? (
          <div className="mb-3 rounded-(--radius-md) border border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive text-sm">
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
              <InboxItemRow
                item={item}
                key={item.id}
                onResolve={(approval, allow) => void resolveApproval(approval, allow)}
                resolving={resolvingId === item.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
