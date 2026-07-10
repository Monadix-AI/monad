'use client';

import type { ApprovalScope } from '@monad/protocol';
import type { ViewItem } from './chat-view-items';
import type { PendingApproval, SessionIdentityModel, SessionTranscriptModel } from './session-route-contract';

import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  CheckIcon,
  HelpCircleIcon,
  ShieldQuestionMarkIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Textarea } from '@monad/ui';
import { VirtualList } from '@monad/ui/components/VirtualList';
import { memo, useCallback, useMemo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ApprovalDisplayCard } from './ApprovalDisplayCard';
import { approvalActionScopes } from './approval-display';
import { Message } from './ChatMessage';
import { isCompactCommandItem, isMemorySummaryItem, isToolItem } from './chat-view-items';
import { MemorySummaryDivider } from './MemorySummaryDivider';
import { useSessionUiStore } from './session-ui-store';
import { ToolStepView } from './ToolStepView';

const sessionMessageKey = (message: ViewItem): string => message.id;
const COMPOSER_CLEARANCE = 'calc(var(--session-composer-clearance, 132px) + 24px)';

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
  const atBottom = useSessionUiStore((state) => state.atBottom);
  const setAtBottom = useSessionUiStore((state) => state.setAtBottom);
  const pendingActionCount = model.pendingApprovals.length + model.pendingClarifications.length;
  const footer = useMemo(
    () =>
      pendingActionCount > 0 ? (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 pb-5">
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
        <div className="mx-auto w-full max-w-4xl px-6 pt-5">
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
  const renderItem = useCallback(
    (message: ViewItem) => (
      <div className="mx-auto w-full max-w-4xl px-6 pb-5">
        {isToolItem(message) ? (
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
        ) : (
          <Message
            assistantLabel={identity.assistantLabel}
            msg={message}
            onBranch={model.onBranch}
            onRestore={model.onRestore}
            onSkillPreview={onSkillPreview}
          />
        )}
      </div>
    ),
    [identity.assistantLabel, identity.currentSessionId, model.onBranch, model.onRestore, onSkillPreview]
  );

  return (
    <div className="transcript-grid relative min-h-0 flex-1">
      <VirtualList
        ariaLive="polite"
        controlRef={model.transcriptRef}
        firstItemIndex={model.firstItemIndex}
        footer={footer}
        getKey={sessionMessageKey}
        header={header}
        items={model.viewMessages}
        onAtBottomChange={setAtBottom}
        onEndReached={model.onEndReached}
        onStartReached={model.onStartReached}
        renderItem={renderItem}
        role="log"
        stickToBottom
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
