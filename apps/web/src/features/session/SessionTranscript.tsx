import type { SessionId } from '@monad/protocol';
import type { ViewItem } from './chat-view-items';

import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { atomPackSelectors, useListAtomPacksQuery } from '@monad/client-rtk';
import { Button, cn, MorphChevron, Skeleton } from '@monad/ui';
import { activeMessageOutlineIds, MessageOutline } from '@monad/ui/components/MessageOutline';
import { VirtualList } from '@monad/ui/components/VirtualList';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useLocale, useT } from '#/components/I18nProvider';
import { installedChannelOptions } from '#/features/studio/channels-settings/installed-channel-options';
import { Message, type MessageSentFrom, type Msg } from './ChatMessage';
import {
  branchSnapshotItems,
  isBranchSourceItem,
  isCompactCommandItem,
  isMemorySummaryItem,
  isMeshAgentLoginItem,
  isSummaryTranscriptTurnItem,
  isToolItem,
  renderedViewItemKeyForTarget,
  type SummaryTranscriptTurnViewItem,
  summaryTranscriptTurns,
  viewItemContainsTargetId
} from './chat-view-items';
import { MemorySummaryDivider } from './MemorySummaryDivider';
import { MeshAgentLoginCard } from './MeshAgentLoginCard';
import { MessageBody } from './MessageBody';
import { messageSentFrom } from './message-sent-from';
import { formatMessageTimestamp } from './message-time';
import { useSessionContext } from './session-context';
import { completeSessionMessageOutlineItems, sessionMessageOutlineItems } from './session-message-outline';
import { sessionReplyPreviewTargetId } from './session-reply-preview';
import { type SessionTranscriptModel, sessionUsesProjectMessageRoute } from './session-route-contract';
import { useSessionUiStore } from './session-ui-store';
import { ToolStepView } from './ToolStepView';

const sessionMessageKey = (message: ViewItem): string => message.id;
const COMPOSER_CLEARANCE = 'calc(var(--session-composer-clearance, 132px) + 24px)';

export function sessionReplyHandler(
  isReadOnly: boolean,
  onReply: (messageId: string) => void
): ((message: Msg) => void) | undefined {
  return isReadOnly ? undefined : (message) => onReply(message.id);
}

export function sessionTranscriptHeaderState(
  isLoading: boolean,
  showLoadingSkeleton: boolean,
  messageCount: number
): 'loading' | 'skeleton' | 'empty' | 'content' {
  if (isLoading) return showLoadingSkeleton ? 'skeleton' : 'loading';
  return messageCount === 0 ? 'empty' : 'content';
}

export function SessionTranscript({ model }: { model: SessionTranscriptModel }) {
  const t = useT();
  const { identity } = useSessionContext();
  const shellRef = useRef<HTMLDivElement>(null);
  const atBottom = useSessionUiStore((state) => state.atBottom);
  const renderMode = useSessionUiStore((state) => state.transcriptRenderMode);
  const setAtBottom = useSessionUiStore((state) => state.setAtBottom);
  const [visibleRange, setVisibleRange] = useState<{ endIndex: number; startIndex: number } | null>(null);
  const [outlineTop, setOutlineTop] = useState('50%');
  const [expandedBranchSessionId, setExpandedBranchSessionId] = useState<SessionId | null>(null);
  const [activeHighlightedMessageId, setActiveHighlightedMessageId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const branchHistoryExpanded = expandedBranchSessionId === identity.currentSessionId;
  const visibleMessages = useMemo(
    () => branchSnapshotItems(model.viewMessages, branchHistoryExpanded),
    [branchHistoryExpanded, model.viewMessages]
  );
  const renderedMessages = useMemo(
    () => (renderMode === 'summary' ? summaryTranscriptTurns(visibleMessages) : visibleMessages),
    [renderMode, visibleMessages]
  );
  const transcriptMessagesById = useMemo(
    () => new Map(visibleMessages.flatMap((item) => ('role' in item ? [[item.id, item] as const] : []))),
    [visibleMessages]
  );
  const previousVisibleItemIds = useMemo(
    () => new Map(visibleMessages.map((item, index) => [item.id, visibleMessages[index - 1]?.id])),
    [visibleMessages]
  );
  const isProjectSession = identity.currentSession ? sessionUsesProjectMessageRoute(identity.currentSession) : false;
  const replyTargetFor = useCallback(
    (message: Extract<ViewItem, { role: unknown }>) => {
      const targetId = sessionReplyPreviewTargetId({
        isProjectSession,
        message,
        previousVisibleItemId: previousVisibleItemIds.get(message.id)
      });
      if (!targetId) return undefined;
      const visibleTarget = transcriptMessagesById.get(targetId);
      if (visibleTarget) {
        return {
          ...visibleTarget,
          label: visibleTarget.label ?? (visibleTarget.role === 'user' ? t('web.chat.you') : identity.assistantLabel)
        };
      }
      return model.replyTargets.has(targetId) ? (model.replyTargets.get(targetId) ?? null) : undefined;
    },
    [identity.assistantLabel, isProjectSession, model.replyTargets, previousVisibleItemIds, t, transcriptMessagesById]
  );
  const onReply = useMemo(
    () => sessionReplyHandler(identity.isReadOnly, model.onReply),
    [identity.isReadOnly, model.onReply]
  );
  const pendingActionCount = model.pendingApprovals.length + model.pendingClarifications.length;
  const locale = useLocale();
  const formatOutlineTime = useCallback(
    (iso: string | undefined) => formatMessageTimestamp(iso, locale) ?? t('web.chat.timeUnavailable'),
    [locale, t]
  );
  const renderedOutlineItems = useMemo(
    () =>
      sessionMessageOutlineItems(
        renderedMessages,
        (number) => t('web.chat.messageNumber', { number }),
        formatOutlineTime
      ),
    [formatOutlineTime, renderedMessages, t]
  );
  const outlineItems = useMemo(
    () =>
      completeSessionMessageOutlineItems(
        model.messageOutline,
        renderedOutlineItems,
        (number) => t('web.chat.messageNumber', { number }),
        formatOutlineTime
      ),
    [formatOutlineTime, model.messageOutline, renderedOutlineItems, t]
  );
  const activeOutlineIds = useMemo(
    () => activeMessageOutlineIds(renderedOutlineItems, visibleRange, renderedMessages.length),
    [renderedOutlineItems, renderedMessages.length, visibleRange]
  );
  const highlightedMessageId = model.highlightedMessageId ?? activeHighlightedMessageId;
  const atomPacksQuery = useListAtomPacksQuery();
  const channelOptions = useMemo(
    () =>
      atomPacksQuery.data
        ? installedChannelOptions(
            atomPackSelectors.selectAll(atomPacksQuery.data.atomPacks),
            atomPacksQuery.data.conflicts
          )
        : undefined,
    [atomPacksQuery.data]
  );
  // Resolved per distinct origin, not per message: the transcript re-renders on every streamed
  // token, and a freshly-built badge object each time would break memo(Message)'s prop compare for
  // every visible user row. Messages from one conversation share one origin, so the cache is tiny.
  const sentFromFor = useMemo(() => {
    const labels = {
      conversation: t('web.chat.originConversation'),
      directMessage: t('web.chat.originDirectMessage'),
      group: t('web.chat.originGroup'),
      channel: t('web.chat.originChannel'),
      sender: t('web.chat.originSender'),
      thread: t('web.chat.originThread'),
      instance: t('web.chat.originInstance'),
      version: t('web.chat.originVersion')
    };
    const cache = new Map<string, MessageSentFrom | undefined>();
    return (message: Msg): MessageSentFrom | undefined => {
      if (message.role !== 'user' || !message.origin) return undefined;
      const key = JSON.stringify(message.origin);
      if (!cache.has(key)) cache.set(key, messageSentFrom(message.origin, channelOptions, labels));
      return cache.get(key);
    };
  }, [channelOptions, t]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const updateOutlineTop = () => {
      const rect = shell.getBoundingClientRect();
      setOutlineTop(`${window.innerHeight / 2 - rect.top}px`);
    };
    updateOutlineTop();
    window.addEventListener('resize', updateOutlineTop);
    if (typeof ResizeObserver === 'undefined') return () => window.removeEventListener('resize', updateOutlineTop);
    const observer = new ResizeObserver(updateOutlineTop);
    observer.observe(shell);
    return () => {
      window.removeEventListener('resize', updateOutlineTop);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!model.highlightedMessageId) return;
    setActiveHighlightedMessageId(model.highlightedMessageId);
  }, [model.highlightedMessageId]);

  useEffect(() => {
    const targetId = model.highlightedMessageId;
    if (!targetId) return;
    const renderedKey = renderedViewItemKeyForTarget(renderedMessages, targetId);
    if (!renderedKey) return;

    let firstFrame = 0;
    let secondFrame = 0;
    const scroll = () => model.transcriptRef.current?.scrollToKey(renderedKey, { align: 'center' });
    scroll();
    firstFrame = requestAnimationFrame(() => {
      scroll();
      secondFrame = requestAnimationFrame(() => {
        scroll();
        model.onHighlightedMessageResolved?.(targetId);
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => {
          setActiveHighlightedMessageId((current) => (current === targetId ? null : current));
          highlightTimerRef.current = null;
        }, 1400);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [model.highlightedMessageId, model.onHighlightedMessageResolved, model.transcriptRef, renderedMessages]);

  const footer = useMemo(() => <div style={{ height: COMPOSER_CLEARANCE }} />, []);
  const header = useMemo(() => {
    const state = sessionTranscriptHeaderState(model.isLoading, model.showLoadingSkeleton, model.viewMessages.length);
    if (state === 'skeleton') return <SessionTranscriptSkeleton />;
    if (state === 'loading') return null;
    return state === 'empty' ? (
      <div className={cn('session-content-column', 'pt-5')}>
        <div className="gradient-spotlight-card flex flex-col items-start gap-2.5 px-5 py-5">
          <span className="label-mono">{t('web.chat.sessionReady')}</span>
          <p className="poster-heading text-foreground text-xl">{t('web.chat.start')}</p>
          <p className="max-w-xl text-muted-foreground text-sm">{t('web.chat.hint')}</p>
        </div>
      </div>
    ) : (
      <div className="h-5" />
    );
  }, [model.isLoading, model.showLoadingSkeleton, model.viewMessages.length, t]);
  const renderItem = useCallback(
    (message: ViewItem) => (
      <div
        className={cn(
          'session-content-column',
          'pb-5',
          highlightedMessageId && viewItemContainsTargetId(message, highlightedMessageId) && 'message-deep-link-target'
        )}
        data-message-id={message.id}
      >
        {isBranchSourceItem(message) ? (
          <button
            aria-expanded={branchHistoryExpanded}
            className="flex items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
            onClick={() => setExpandedBranchSessionId(branchHistoryExpanded ? null : identity.currentSessionId)}
            type="button"
          >
            {t('web.chat.lineageParent')}
            {message.sessionTitle ? <span className="text-foreground/80">{message.sessionTitle}</span> : null}
            <MorphChevron
              className="size-3.5"
              expanded={branchHistoryExpanded}
            />
          </button>
        ) : isToolItem(message) ? (
          <ToolStepView
            sessionId={identity.currentSessionId}
            step={message}
          />
        ) : isMeshAgentLoginItem(message) ? (
          <MeshAgentLoginCard item={message} />
        ) : isMemorySummaryItem(message) ? (
          <MemorySummaryDivider item={message} />
        ) : isCompactCommandItem(message) ? (
          <MemorySummaryDivider
            compactStatus={message.status}
            item={message.summary ? { summary: message.summary } : undefined}
            pending={message.status === 'pending'}
          />
        ) : isSummaryTranscriptTurnItem(message) ? (
          <SummaryTranscriptTurn
            assistantLabel={identity.assistantLabel}
            item={message}
            onBranch={model.onBranch}
            onOpenMessage={model.onOpenMessage}
            onReply={onReply}
            onRestore={model.onRestore}
            replyTargetFor={replyTargetFor}
            sentFromFor={sentFromFor}
            sessionId={identity.currentSessionId}
          />
        ) : (
          <Message
            assistantLabel={identity.assistantLabel}
            msg={message}
            onBranch={model.onBranch}
            onOpenReplyTarget={
              message.replyToMessageId && replyTargetFor(message)
                ? () => model.onOpenMessage(message.replyToMessageId as string)
                : undefined
            }
            onReply={onReply}
            onRestore={model.onRestore}
            replyTarget={replyTargetFor(message)}
            sentFrom={sentFromFor(message)}
          />
        )}
      </div>
    ),
    [
      identity.assistantLabel,
      identity.currentSessionId,
      branchHistoryExpanded,
      model.onBranch,
      model.onOpenMessage,
      onReply,
      model.onRestore,
      replyTargetFor,
      sentFromFor,
      t,
      highlightedMessageId
    ]
  );

  return (
    <div
      className="transcript-grid relative min-h-0 flex-1"
      ref={shellRef}
      style={{ '--chat-message-outline-top': outlineTop } as CSSProperties}
    >
      <MessageOutline
        activeIds={activeOutlineIds}
        ariaLabel={t('web.chat.messageOutline')}
        goToLabel={(item) => t('web.chat.goToMessage', { message: item.label })}
        items={outlineItems}
        onSelect={model.onOpenMessage}
        renderPreview={(item) => (
          <MessageBody
            isUser
            text={item.preview}
          />
        )}
      />
      <VirtualList
        ariaLive="polite"
        controlRef={model.transcriptRef}
        footer={footer}
        getKey={sessionMessageKey}
        header={header}
        items={renderedMessages}
        onAtBottomChange={setAtBottom}
        onEndReached={model.onEndReached}
        onRangeChange={setVisibleRange}
        onStartReached={model.onStartReached}
        renderItem={renderItem}
        role="log"
        stickToBottom={!highlightedMessageId}
        style={{ height: '100%' }}
        viewportOverlay={
          <div
            className="pointer-events-none"
            style={{
              background:
                'linear-gradient(to top, var(--app-main-frame-solid) 0%, var(--app-main-frame-solid) calc(100% - 64px), transparent 100%)',
              height: 'var(--session-composer-clearance, 132px)'
            }}
          />
        }
      />
      {!atBottom &&
        (pendingActionCount > 0 ? (
          <Button
            className="absolute left-1/2 -translate-x-1/2 gap-1.5 rounded-full shadow-md"
            onClick={() => model.onScrollToBottom('smooth')}
            size="sm"
            style={{ bottom: 'calc(var(--session-composer-clearance, 132px) + 12px)' }}
            variant="secondary"
          >
            <HugeiconsIcon
              className="size-3.5"
              icon={ArrowDown01Icon}
            />
            {t('web.chat.pendingActions', { count: pendingActionCount })}
          </Button>
        ) : (
          <Button
            aria-label={t('web.chat.scrollBottom')}
            className="absolute left-1/2 size-8 -translate-x-1/2 rounded-full shadow-md"
            onClick={() => model.onScrollToBottom('smooth')}
            size="icon"
            style={{ bottom: 'calc(var(--session-composer-clearance, 132px) + 12px)' }}
            variant="secondary"
          >
            <HugeiconsIcon
              className="size-4"
              icon={ArrowDown01Icon}
            />
          </Button>
        ))}
    </div>
  );
}

function SessionTranscriptSkeleton() {
  return (
    <div
      aria-hidden="true"
      className={cn('session-content-column', 'grid gap-8 pt-6')}
      data-session-transcript-skeleton
    >
      <div className="ml-auto grid w-[min(72%,36rem)] gap-2">
        <Skeleton className="ml-auto h-3 w-20" />
        <Skeleton className="h-16 w-full" />
      </div>
      <div className="grid w-[min(78%,40rem)] gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-[88%]" />
        <Skeleton className="h-3 w-[64%]" />
      </div>
      <div className="ml-auto grid w-[min(58%,30rem)] gap-2">
        <Skeleton className="ml-auto h-3 w-16" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}

export function SummaryTranscriptTurn({
  assistantLabel,
  item,
  onBranch,
  onOpenMessage,
  onReply,
  onRestore,
  replyTargetFor,
  sentFromFor,
  sessionId
}: {
  assistantLabel: string;
  item: SummaryTranscriptTurnViewItem;
  onBranch?: (messageId: string) => void;
  onOpenMessage?: (messageId: string) => void;
  onReply?: (message: import('./ChatMessage').Msg) => void;
  onRestore?: (messageId: string, text: string) => Promise<boolean>;
  replyTargetFor?: (
    message: import('./ChatMessage').Msg
  ) => (import('./ChatMessage').Msg & { label?: string }) | null | undefined;
  sentFromFor?: (message: import('./ChatMessage').Msg) => import('./ChatMessage').MessageSentFrom | undefined;
  sessionId: SessionId;
}) {
  const running = item.status === 'running';
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="group w-full"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      open={expanded}
    >
      <summary className="flex w-full cursor-pointer list-none items-center gap-1 border-b py-2 [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-muted-foreground text-xs uppercase">
          {running ? 'Running' : 'Completed'} for {item.durationLabel}
          {running ? '…' : ''}
        </span>
        <MorphChevron
          className="size-3.5"
          expanded={expanded}
        />
      </summary>
      <div className="mt-4 grid w-full gap-5">
        {item.details.map((detail) =>
          isToolItem(detail) ? (
            <ToolStepView
              key={detail.id}
              sessionId={sessionId}
              step={detail}
            />
          ) : isMemorySummaryItem(detail) ? (
            <MemorySummaryDivider
              item={detail}
              key={detail.id}
            />
          ) : isCompactCommandItem(detail) ? (
            <MemorySummaryDivider
              compactStatus={detail.status}
              item={detail.summary ? { summary: detail.summary } : undefined}
              key={detail.id}
              pending={detail.status === 'pending'}
            />
          ) : isMeshAgentLoginItem(detail) ? (
            <MeshAgentLoginCard
              item={detail}
              key={detail.id}
            />
          ) : isSummaryTranscriptTurnItem(detail) || isBranchSourceItem(detail) ? null : (
            <Message
              assistantLabel={assistantLabel}
              key={detail.id}
              msg={detail}
              onBranch={onBranch}
              onOpenReplyTarget={
                detail.replyToMessageId && replyTargetFor?.(detail)
                  ? () => onOpenMessage?.(detail.replyToMessageId as string)
                  : undefined
              }
              onReply={onReply}
              onRestore={onRestore}
              replyTarget={replyTargetFor?.(detail)}
              sentFrom={sentFromFor?.(detail)}
            />
          )
        )}
      </div>
    </details>
  );
}
