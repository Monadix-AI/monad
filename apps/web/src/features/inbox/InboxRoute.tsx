'use client';

import type { MentionInboxItem } from '@monad/protocol';

import { useListMentionInboxQuery } from '@monad/client-rtk';
import { cn } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { PanelLoading } from '#/components/PanelLoading';
import { projectSessionPath } from '#/features/shell/routing/paths';
import { pushShellUrl } from '#/hooks/use-shell-location';

function itemTarget(item: MentionInboxItem): string {
  const base = item.projectId ? projectSessionPath(item.projectId, item.sessionId) : `/sessions/${item.sessionId}`;
  if (!item.triggerMessageId) return base;
  return `${base}?msg=${encodeURIComponent(item.triggerMessageId)}`;
}

function formatInboxTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function messagePreview(item: MentionInboxItem): string {
  const text = item.message.text.trim();
  if (text) return text;
  return item.message.type;
}

function InboxItemRow({ item }: { item: MentionInboxItem }) {
  const t = useT();
  const title = item.projectName ?? item.sessionTitle ?? t('web.inbox.unknownContext');
  const subtitle = [item.sessionTitle, item.memberInstanceId ? `@${item.memberInstanceId}` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      className={cn(
        'group flex w-full flex-col gap-2 rounded-(--radius-md) border border-border/60 bg-card/70 px-4 py-3 text-left transition',
        'hover:border-border hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
      )}
      onClick={() => pushShellUrl(itemTarget(item))}
      type="button"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-sm">{title}</div>
          {subtitle ? <div className="truncate text-muted-foreground text-xs">{subtitle}</div> : null}
        </div>
        <time className="shrink-0 text-muted-foreground text-xs">{formatInboxTime(item.createdAt)}</time>
      </div>
      <div className="line-clamp-2 text-muted-foreground text-sm leading-relaxed">{messagePreview(item)}</div>
    </button>
  );
}

export function InboxRoute() {
  const t = useT();
  const { data, error, isLoading, isFetching, refetch } = useListMentionInboxQuery({ limit: 100 });
  const items = data?.items ?? [];

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
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
