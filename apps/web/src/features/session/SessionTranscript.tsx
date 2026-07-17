import type { SessionId } from '@monad/protocol';
import type { ViewItem } from './chat-view-items';
import type { SessionTranscriptModel } from './session-route-contract';

import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn, MorphChevron, Skeleton } from '@monad/ui';
import { activeMessageOutlineIds, MessageOutline } from '@monad/ui/components/MessageOutline';
import { VirtualList } from '@monad/ui/components/VirtualList';
import { useFirstItemIndex } from '@monad/ui/hooks/use-first-item-index';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { Message } from './ChatMessage';
import {
  branchSnapshotItems,
  isBranchSourceItem,
  isCompactCommandItem,
  isExternalAgentLoginItem,
  isMemorySummaryItem,
  isSummaryTranscriptTurnItem,
  isToolItem,
  type SummaryTranscriptTurnViewItem,
  summaryTranscriptTurns
} from './chat-view-items';
import { ExternalAgentLoginCard } from './ExternalAgentLoginCard';
import { MemorySummaryDivider } from './MemorySummaryDivider';
import { MessageBody } from './MessageBody';
import { ApprovalCard, ClarifyPrompt } from './SessionActionCards';
import { useSessionContext } from './session-context';
import { sessionMessageOutlineItems } from './session-message-outline';
import { useSessionUiStore } from './session-ui-store';
import { ToolStepView } from './ToolStepView';

const sessionMessageKey = (message: ViewItem): string => message.id;
const COMPOSER_CLEARANCE = 'calc(var(--session-composer-clearance, 132px) + 24px)';

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
  const branchHistoryExpanded = expandedBranchSessionId === identity.currentSessionId;
  const visibleMessages = useMemo(
    () => branchSnapshotItems(model.viewMessages, branchHistoryExpanded),
    [branchHistoryExpanded, model.viewMessages]
  );
  const renderedMessages = useMemo(
    () => (renderMode === 'summary' ? summaryTranscriptTurns(visibleMessages) : visibleMessages),
    [renderMode, visibleMessages]
  );
  const firstItemIndex = useFirstItemIndex(renderedMessages, sessionMessageKey);
  const pendingActionCount = model.pendingApprovals.length + model.pendingClarifications.length;
  const outlineItems = useMemo(
    () =>
      sessionMessageOutlineItems(
        renderedMessages,
        (number) => t('web.chat.messageNumber', { number }),
        t('web.chat.timeUnavailable')
      ),
    [renderedMessages, t]
  );
  const activeOutlineIds = useMemo(
    () => activeMessageOutlineIds(outlineItems, visibleRange, firstItemIndex, renderedMessages.length),
    [firstItemIndex, outlineItems, renderedMessages.length, visibleRange]
  );

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
  const footer = useMemo(
    () =>
      pendingActionCount > 0 ? (
        <div className={cn('session-content-column', 'flex flex-col gap-5 pb-5')}>
          {model.pendingApprovals.map((approval) => (
            <ApprovalCard
              approval={approval}
              key={approval.requestId}
              onApproval={model.onApproval}
            />
          ))}
          {model.pendingClarifications.map((clarification) => (
            <ClarifyPrompt
              key={clarification.requestId}
              onAnswer={(answer) => model.onClarifyAnswer(clarification.requestId, answer)}
              options={clarification.options}
              question={clarification.question}
            />
          ))}
          <div
            aria-hidden="true"
            style={{ height: COMPOSER_CLEARANCE }}
          />
        </div>
      ) : (
        <div style={{ height: COMPOSER_CLEARANCE }} />
      ),
    [model.onApproval, model.onClarifyAnswer, model.pendingApprovals, model.pendingClarifications, pendingActionCount]
  );
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
          message.id === model.highlightedMessageId && 'message-deep-link-target'
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
        ) : isExternalAgentLoginItem(message) ? (
          <ExternalAgentLoginCard item={message} />
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
            onRestore={model.onRestore}
            sessionId={identity.currentSessionId}
          />
        ) : (
          <Message
            assistantLabel={identity.assistantLabel}
            msg={message}
            onBranch={model.onBranch}
            onRestore={model.onRestore}
          />
        )}
      </div>
    ),
    [
      identity.assistantLabel,
      identity.currentSessionId,
      branchHistoryExpanded,
      model.highlightedMessageId,
      model.onBranch,
      model.onRestore,
      t
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
        onSelect={(id) => model.transcriptRef.current?.scrollToKey(id, { align: 'start', behavior: 'smooth' })}
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
        firstItemIndex={firstItemIndex}
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
        stickToBottom={!model.highlightedMessageId}
        style={{ height: '100%' }}
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
  onRestore,
  sessionId
}: {
  assistantLabel: string;
  item: SummaryTranscriptTurnViewItem;
  onBranch?: (messageId: string) => void;
  onRestore?: (messageId: string, text: string) => Promise<boolean>;
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
          ) : isExternalAgentLoginItem(detail) ? (
            <ExternalAgentLoginCard
              item={detail}
              key={detail.id}
            />
          ) : isSummaryTranscriptTurnItem(detail) || isBranchSourceItem(detail) ? null : (
            <Message
              assistantLabel={assistantLabel}
              key={detail.id}
              msg={detail}
              onBranch={onBranch}
              onRestore={onRestore}
            />
          )
        )}
      </div>
    </details>
  );
}
