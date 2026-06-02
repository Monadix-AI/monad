import type { ApprovalInboxItem, HitlInboxItem, InboxFilter, InboxItem } from '@monad/protocol';

import { CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useApproveMeshSessionMutation,
  useApproveToolMutation,
  useClarifyRespondMutation,
  useGetInboxSummaryQuery,
  useListInboxQuery,
  useMarkAllInboxReadMutation,
  useMarkInboxReadMutation,
  useMarkInboxUnreadMutation
} from '@monad/client-rtk';
import { cn } from '@monad/ui';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOnInView } from 'react-intersection-observer';

import { useT } from '#/components/I18nProvider';
import { PanelLoading } from '#/components/PanelLoading';
import { RefreshButton } from '#/components/RefreshButton';
import { PanelShellHeader } from '#/components/ui/panel-shell';
import { INBOX_FILTERS } from '#/features/shell/routing/paths';
import { createInboxExposureTracker } from './exposure';
import { InboxItemRow } from './InboxItemRow';
import {
  createUnreadSnapshot,
  markUnreadSnapshotRead,
  markUnreadSnapshotUnread,
  reconcileUnreadSnapshot
} from './unread-snapshot';

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

export function InboxRoute({ filter }: { filter: InboxFilter }) {
  const t = useT();
  const { currentData, error, isLoading, isFetching, refetch } = useListInboxQuery({ filter, limit: 100 });
  const { data: summary } = useGetInboxSummaryQuery();
  const [approveTool] = useApproveToolMutation();
  const [approveMeshSession] = useApproveMeshSessionMutation();
  const [clarifyRespond] = useClarifyRespondMutation();
  const [markRead] = useMarkInboxReadMutation();
  const [markAllRead, { isLoading: markingAllRead }] = useMarkAllInboxReadMutation();
  const [markUnread] = useMarkInboxUnreadMutation();
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [markingUnreadKey, setMarkingUnreadKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [unreadSnapshot, setUnreadSnapshot] = useState<InboxItem[] | null>(null);
  const pendingRead = useRef(new Set<string>());
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const items = filter === 'unread' ? (unreadSnapshot ?? currentData?.items ?? []) : (currentData?.items ?? []);

  const markSnapshotRead = useCallback((itemKeys: string[], readAt: string) => {
    setUnreadSnapshot((current) => (current ? markUnreadSnapshotRead(current, itemKeys, readAt) : current));
  }, []);

  useEffect(() => {
    if (filter !== 'unread') {
      setUnreadSnapshot(null);
      return;
    }
    if (isFetching || !currentData) return;
    setUnreadSnapshot((current) =>
      current ? reconcileUnreadSnapshot(current, currentData.items) : createUnreadSnapshot(currentData.items)
    );
  }, [currentData, filter, isFetching]);

  const reportSeen = useCallback(
    (itemKey: string) => {
      pendingRead.current.add(itemKey);
      if (readTimer.current) return;
      readTimer.current = setTimeout(() => {
        const itemKeys = [...pendingRead.current];
        pendingRead.current.clear();
        readTimer.current = null;
        if (!itemKeys.length) return;
        void markRead({ itemKeys })
          .unwrap()
          .then((result) => markSnapshotRead(result.itemKeys, result.readAt))
          .catch((cause: unknown) => {
            setActionError(cause instanceof Error ? cause.message : t('web.inbox.actionError'));
          });
      }, 200);
    },
    [markRead, markSnapshotRead, t]
  );

  useEffect(
    () => () => {
      if (readTimer.current) clearTimeout(readTimer.current);
    },
    []
  );

  const refreshInbox = async () => {
    const result = await refetch();
    if (filter === 'unread' && result.data) setUnreadSnapshot(createUnreadSnapshot(result.data.items));
  };

  const markEveryItemRead = async () => {
    setActionError(null);
    try {
      const result = await markAllRead().unwrap();
      setUnreadSnapshot((current) =>
        current
          ? markUnreadSnapshotRead(
              current,
              current.map((item) => item.itemKey),
              result.readAt
            )
          : current
      );
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('web.inbox.actionError'));
    }
  };

  const markItemUnread = async (item: InboxItem) => {
    setMarkingUnreadKey(item.itemKey);
    setActionError(null);
    try {
      const result = await markUnread({ itemKeys: [item.itemKey] }).unwrap();
      setUnreadSnapshot((current) => (current ? markUnreadSnapshotUnread(current, result.itemKeys) : current));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('web.inbox.actionError'));
    } finally {
      setMarkingUnreadKey(null);
    }
  };

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
      <PanelShellHeader
        actions={
          <>
            <button
              className="inline-flex items-center gap-1.5 rounded-(--radius-sm) px-2.5 py-1.5 text-muted-foreground text-sm hover:bg-accent disabled:opacity-50"
              disabled={markingAllRead || !summary?.unreadCount}
              onClick={() => void markEveryItemRead()}
              type="button"
            >
              <HugeiconsIcon
                aria-hidden="true"
                className="size-3.5 shrink-0"
                icon={CheckmarkCircle02Icon}
              />
              {markingAllRead ? t('web.inbox.markingAllRead') : t('web.inbox.markAllRead')}
            </button>
            <RefreshButton
              className="px-2.5 py-1.5"
              loading={isFetching}
              onClick={() => void refreshInbox()}
            />
          </>
        }
        leading={INBOX_FILTERS.map((value) => (
          <Link
            aria-pressed={filter === value}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs',
              filter === value ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent'
            )}
            key={value}
            params={{ filter: value }}
            to="/inbox/$filter"
          >
            {t(`web.inbox.filter.${value}`)}
          </Link>
        ))}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {actionError ? (
          <div className="mx-auto mb-3 max-w-4xl rounded-(--radius-md) border border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive text-sm">
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
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
            {items.map((item) => (
              <ExposedInboxItem
                item={item}
                key={item.itemKey}
                onSeen={reportSeen}
              >
                <InboxItemRow
                  item={item}
                  markingUnread={markingUnreadKey === item.itemKey}
                  onAnswer={(hitl, answer) => void answerHitl(hitl, answer)}
                  onMarkUnread={(candidate) => void markItemUnread(candidate)}
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
