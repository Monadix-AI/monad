import type { ApprovalScope, SessionId } from '@monad/protocol';
import type { ViewItem } from './chat-view-items';
import type { PendingApproval, SessionIdentityModel, SessionTranscriptModel } from './session-route-contract';

import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  CheckIcon,
  GitBranchIcon,
  HelpCircleIcon,
  ShieldQuestionMarkIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useProvenanceQuery } from '@monad/client-rtk';
import { Button, cn, Textarea } from '@monad/ui';
import { activeMessageOutlineIds, MessageOutline } from '@monad/ui/components/MessageOutline';
import { VirtualList } from '@monad/ui/components/VirtualList';
import { useFirstItemIndex } from '@monad/ui/hooks/use-first-item-index';
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ApprovalDisplayCard } from './ApprovalDisplayCard';
import { approvalActionScopes } from './approval-display';
import { Message } from './ChatMessage';
import {
  branchSourceSessionName,
  type CompactTranscriptTurnViewItem,
  compactTranscriptTurns,
  isBranchSourceItem,
  isCompactCommandItem,
  isCompactTranscriptTurnItem,
  isMemorySummaryItem,
  isToolItem
} from './chat-view-items';
import { MemorySummaryDivider } from './MemorySummaryDivider';
import { MessageBody } from './MessageBody';
import { SESSION_CONTENT_CLASS } from './session-layout';
import { sessionMessageOutlineItems } from './session-message-outline';
import { useSessionUiStore } from './session-ui-store';
import { ToolStepView } from './ToolStepView';

const sessionMessageKey = (message: ViewItem): string => message.id;
const COMPOSER_CLEARANCE = 'calc(var(--session-composer-clearance, 132px) + 24px)';
export const SESSION_TRANSCRIPT_CONTENT_CLASS = SESSION_CONTENT_CLASS;

export function SessionTranscript({
  identity,
  model,
  onSkillPreview
}: {
  identity: SessionIdentityModel;
  model: SessionTranscriptModel;
  onSkillPreview: (id: string) => void;
}) {
  const t = useT();
  const shellRef = useRef<HTMLDivElement>(null);
  const { data: provenance } = useProvenanceQuery(identity.currentSessionId, { skip: identity.isDraft });
  const atBottom = useSessionUiStore((state) => state.atBottom);
  const setAtBottom = useSessionUiStore((state) => state.setAtBottom);
  const [visibleRange, setVisibleRange] = useState<{ endIndex: number; startIndex: number } | null>(null);
  const [outlineTop, setOutlineTop] = useState('50%');
  const pendingActionCount = model.pendingApprovals.length + model.pendingClarifications.length;
  const outlineItems = useMemo(
    () =>
      sessionMessageOutlineItems(
        model.viewMessages,
        (number) => t('web.chat.messageNumber', { number }),
        t('web.chat.timeUnavailable')
      ),
    [model.viewMessages, t]
  );
  const activeOutlineIds = useMemo(
    () => activeMessageOutlineIds(outlineItems, visibleRange, model.firstItemIndex, model.viewMessages.length),
    [model.firstItemIndex, model.viewMessages.length, outlineItems, visibleRange]
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
        <div className={cn(SESSION_TRANSCRIPT_CONTENT_CLASS, 'flex flex-col gap-5 pb-5')}>
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
  const header = useMemo(
    () =>
      model.viewMessages.length === 0 ? (
        <div className={cn(SESSION_TRANSCRIPT_CONTENT_CLASS, 'pt-5')}>
          <div className="gradient-spotlight-card flex flex-col items-start gap-2.5 px-5 py-5">
            <span className="label-mono">{t('web.chat.sessionReady')}</span>
            <p className="poster-heading text-foreground text-xl">{t('web.chat.start')}</p>
            <p className="max-w-xl text-muted-foreground text-sm">{t('web.chat.hint')}</p>
          </div>
        </div>
      ) : (
        <div className="h-5" />
      ),
    [model.viewMessages.length, t]
  );
  const renderedMessages = useMemo(
    () => (model.renderMode === 'compact' ? compactTranscriptTurns(model.viewMessages) : model.viewMessages),
    [model.renderMode, model.viewMessages]
  );
  const firstItemIndex = useFirstItemIndex(renderedMessages, sessionMessageKey);
  const renderItem = useCallback(
    (message: ViewItem) => (
      <div
        className={cn(
          SESSION_TRANSCRIPT_CONTENT_CLASS,
          'pb-5',
          message.id === model.highlightedMessageId && 'message-deep-link-target'
        )}
        data-message-id={message.id}
      >
        {isBranchSourceItem(message) ? (
          <button
            className="flex items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
            onClick={() => model.onOpenBranchSource(message)}
            type="button"
          >
            <HugeiconsIcon
              className="size-3.5"
              icon={GitBranchIcon}
            />
            {t('web.chat.lineageParent')}{' '}
            <span className="text-foreground/80">{branchSourceSessionName(message, provenance?.ancestors)}</span>
          </button>
        ) : isToolItem(message) ? (
          <ToolStepView
            sessionId={identity.currentSessionId}
            step={message}
          />
        ) : isMemorySummaryItem(message) ? (
          <MemorySummaryDivider item={message} />
        ) : isCompactCommandItem(message) ? (
          <MemorySummaryDivider
            compactStatus={message.status}
            item={message.summary ? { summary: message.summary } : undefined}
            pending={message.status === 'pending'}
          />
        ) : isCompactTranscriptTurnItem(message) ? (
          <CompactTranscriptTurn
            assistantLabel={identity.assistantLabel}
            item={message}
            onBranch={model.onBranch}
            onRestore={model.onRestore}
            onSkillPreview={onSkillPreview}
            sessionId={identity.currentSessionId}
          />
        ) : (
          <Message
            assistantLabel={identity.assistantLabel}
            commands={model.commands}
            msg={message}
            onBranch={model.onBranch}
            onRestore={model.onRestore}
            onSkillPreview={onSkillPreview}
          />
        )}
      </div>
    ),
    [
      identity.assistantLabel,
      identity.currentSessionId,
      provenance?.ancestors,
      model.commands,
      model.highlightedMessageId,
      model.onBranch,
      model.onOpenBranchSource,
      model.onRestore,
      onSkillPreview,
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
            commands={model.commands}
            isUser
            onSkillPreview={onSkillPreview}
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

function CompactTranscriptTurn({
  assistantLabel,
  item,
  onBranch,
  onRestore,
  onSkillPreview,
  sessionId
}: {
  assistantLabel: string;
  item: CompactTranscriptTurnViewItem;
  onBranch?: (messageId: string, role: 'user' | 'assistant') => void;
  onRestore?: (messageId: string, text: string) => void;
  onSkillPreview: (id: string) => void;
  sessionId: SessionId;
}) {
  const running = item.status === 'running';
  return (
    <details className="rounded-lg border bg-card">
      <summary className="grid cursor-pointer gap-2 px-4 py-3 marker:text-muted-foreground">
        <span className="font-mono text-muted-foreground text-xs uppercase">
          {running ? 'Running' : 'Completed'} for {item.durationLabel}
          {running ? '…' : ''}
        </span>
        {item.summary ? <span className="whitespace-pre-wrap text-sm">{item.summary}</span> : null}
      </summary>
      <div className="grid gap-4 border-t px-4 py-4">
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
          ) : isCompactTranscriptTurnItem(detail) || isBranchSourceItem(detail) ? null : (
            <Message
              assistantLabel={assistantLabel}
              key={detail.id}
              msg={detail}
              onBranch={onBranch}
              onRestore={onRestore}
              onSkillPreview={onSkillPreview}
            />
          )
        )}
      </div>
    </details>
  );
}

function ApprovalCard({
  approval,
  onApproval
}: {
  approval: PendingApproval;
  onApproval: (approval: PendingApproval, allow: boolean, scope: ApprovalScope, reason?: string) => void;
}) {
  const t = useT();
  const scopes = approvalActionScopes(approval.display).filter(
    (scope) => approval.key !== 'host-control' || scope !== 'global'
  );

  return (
    <div className="panel-subtle flex max-w-170 flex-col gap-2 self-start border-warning/40 bg-warning/10 px-4 py-4">
      <div className="flex items-center gap-2 font-medium text-sm text-warning">
        <HugeiconsIcon
          className="size-4"
          icon={ShieldQuestionMarkIcon}
        />
        {approval.display?.kind === 'resource-approval' ? (
          approval.display.resource === 'path' ? (
            t('web.chat.pathAccessTitle')
          ) : (
            'Network access'
          )
        ) : approval.tool === 'path_access' ? (
          t('web.chat.pathAccessTitle')
        ) : (
          <>
            {t('web.chat.approveTitle')}: <code className="font-mono">{approval.tool}</code>
          </>
        )}
      </div>
      {approval.display?.kind === 'resource-approval' ? (
        <ApprovalDisplayCard display={approval.display} />
      ) : approval.tool === 'path_access' && approval.key ? (
        <div className="flex items-baseline gap-1.5 text-muted-foreground text-xs">
          <span className="shrink-0">{t('web.chat.pathAccessDir')}:</span>
          <code className="min-w-0 break-all font-mono">{approval.key}</code>
        </div>
      ) : approval.input !== undefined ? (
        <pre className="max-h-32 overflow-auto rounded-md bg-background/60 p-3 text-muted-foreground text-xs">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {scopes.map((scope, index) => (
          <Button
            key={scope}
            onClick={() => onApproval(approval, true, scope)}
            size="sm"
            variant={index === 0 ? undefined : 'outline'}
          >
            {index === 0 ? <HugeiconsIcon icon={CheckIcon} /> : null}
            {approvalScopeLabel(scope, t)}
          </Button>
        ))}
        <Button
          onClick={() => onApproval(approval, false, 'once', 'denied by operator')}
          size="sm"
          variant="outline"
        >
          <HugeiconsIcon icon={Cancel01Icon} /> {t('web.chat.deny')}
        </Button>
      </div>
    </div>
  );
}

function approvalScopeLabel(scope: ApprovalScope, t: ReturnType<typeof useT>): string {
  if (scope === 'once') return t('web.chat.approveOnce');
  if (scope === 'session') return t('web.chat.approveSession');
  if (scope === 'global') return t('web.chat.approveAlways');
  return 'This agent';
}

const ClarifyPrompt = memo(function ClarifyPrompt({
  question,
  options,
  onAnswer
}: {
  question: string;
  options?: string[];
  onAnswer: (answer: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState('');
  const submit = (answer: string) => {
    const trimmed = answer.trim();
    if (trimmed) onAnswer(trimmed);
  };

  return (
    <div className="flex max-w-170 flex-col gap-2 self-start rounded-lg border border-info/40 bg-info/10 px-3.5 py-3">
      <div className="flex items-center gap-2 font-medium text-info text-sm">
        <HugeiconsIcon
          className="size-4"
          icon={HelpCircleIcon}
        />
        {t('web.chat.clarifyTitle')}
      </div>
      <p className="whitespace-pre-wrap text-foreground text-sm">{question}</p>
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option}
              onClick={() => submit(option)}
              size="sm"
              variant="outline"
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          className="min-h-9 flex-1 resize-none"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit(value);
            }
          }}
          placeholder={t('web.chat.clarifyPlaceholder')}
          rows={1}
          value={value}
        />
        <Button
          disabled={!value.trim()}
          onClick={() => submit(value)}
          size="sm"
        >
          <HugeiconsIcon
            className="size-4"
            icon={ArrowUp01Icon}
          />
          {t('web.chat.clarifySend')}
        </Button>
      </div>
    </div>
  );
});
