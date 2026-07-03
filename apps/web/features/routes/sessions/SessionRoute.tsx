'use client';

import type { Session, SessionId, UIItem } from '@monad/protocol';
import type { ComponentProps, KeyboardEventHandler, Ref } from 'react';
import type { VirtualListHandle } from '@/components/ui/VirtualList';

import {
  Activity01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  BoxIcon,
  Cancel01Icon,
  CheckIcon,
  GitBranchIcon,
  HelpCircleIcon,
  ShieldQuestionMarkIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useProvenanceQuery } from '@monad/client-rtk';
import { Button, cn, ScrollArea, Textarea } from '@monad/ui';
import { memo, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { VirtualList } from '@/components/ui/VirtualList';
import { AgentLoopInspector } from '@/features/session/AgentLoopInspector';
import { Message } from '@/features/session/ChatMessage';
import { ComposerShell } from '@/features/session/ComposerShell';
import {
  isCompactCommandItem,
  isMemorySummaryItem,
  isToolItem,
  type ViewItem
} from '@/features/session/chat-view-items';
import { MemorySummaryDivider } from '@/features/session/MemorySummaryDivider';
import { ToolStepView } from '@/features/session/ToolStepView';
import { renderableIconText } from '@/lib/renderable-icon-text';

export interface SessionCommandMenuItem {
  badge?: string;
  dismissAfter?: boolean;
  executeOnSelect?: boolean;
  hint?: string;
  icon?: string;
  insert: string;
  key: string;
  label: string;
  replace?: { start: number; end: number };
  typeBadge?: string;
  version?: string;
}

interface PendingApproval {
  input?: unknown;
  key?: string;
  requestId: string;
  tool: string;
}

interface PendingClarification {
  options?: string[];
  question: string;
  requestId: string;
}

type ComposerProps = ComponentProps<typeof ComposerShell>;

interface SessionRouteProps {
  accessMode: 'auto' | 'ask';
  activeInputSkillToken?: ComposerProps['skillToken'];
  activeSkill: number;
  atBottom: boolean;
  contextUsage?: ComposerProps['contextUsage'];
  currentSession: Session | null;
  currentSessionId: SessionId;
  disabled: boolean;
  firstItemIndex: number;
  inspectorItems: UIItem[];
  isBusy: boolean;
  isReadOnly: boolean;
  menuItems: SessionCommandMenuItem[];
  messageQueue: string[];
  model: ComposerProps['model'];
  onAccessModeChange: (mode: 'auto' | 'ask') => void;
  onApproval: (
    approval: PendingApproval,
    allow: boolean,
    scope: 'once' | 'session' | 'global',
    reason?: string
  ) => void;
  onBranch: (messageId: string) => void;
  onClarifyAnswer: (requestId: string, answer: string) => void;
  onClearQueue: () => void;
  onCommandItemApply: (item: SessionCommandMenuItem) => void;
  onCommandItemHover: (index: number) => void;
  onInputChange: (value: string) => void;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
  onAtBottomChange: (atBottom: boolean) => void;
  onEndReached: () => void;
  onStartReached: () => void;
  onRestore: (messageId: string) => void;
  onScrollToBottom: (behavior?: 'smooth' | 'auto') => void;
  onSelectSession: (sessionId: SessionId) => void;
  onSkillPreview: (id: string) => void;
  onStop: () => void;
  onSubmit: () => void;
  onToggleInspector: () => void;
  onVoiceSettingsClick: () => void;
  onVoiceText: (text: string) => void;
  onVoiceTranscribe: (audio: Blob) => Promise<string>;
  pendingApprovals: PendingApproval[];
  pendingClarifications: PendingClarification[];
  showInspector: boolean;
  skillMenuOpen: boolean;
  transcriptRef: Ref<VirtualListHandle>;
  value: string;
  voiceModelConfigured: boolean;
  viewMessages: ViewItem[];
}

export function SessionRoute({
  accessMode,
  activeInputSkillToken,
  activeSkill,
  atBottom,
  contextUsage,
  currentSession,
  currentSessionId,
  disabled,
  firstItemIndex,
  inspectorItems,
  isBusy,
  isReadOnly,
  menuItems,
  messageQueue,
  model,
  onAccessModeChange,
  onApproval,
  onBranch,
  onClarifyAnswer,
  onClearQueue,
  onCommandItemApply,
  onCommandItemHover,
  onInputChange,
  onAtBottomChange,
  onEndReached,
  onStartReached,
  onKeyDown,
  onRestore,
  onScrollToBottom,
  onSelectSession,
  onSkillPreview,
  onStop,
  onSubmit,
  onToggleInspector,
  onVoiceSettingsClick,
  onVoiceText,
  onVoiceTranscribe,
  pendingApprovals,
  pendingClarifications,
  showInspector,
  skillMenuOpen,
  transcriptRef,
  value,
  voiceModelConfigured,
  viewMessages
}: SessionRouteProps) {
  const t = useT();

  return (
    <>
      <SessionLineage
        onSelect={onSelectSession}
        sessionId={currentSessionId}
      />
      <div className="flex items-center justify-between gap-2.5 border-border/70 border-b px-4 py-2">
        <div className="min-w-0">
          <div className="truncate font-medium text-sm">{currentSession?.title ?? t('web.chat.assistant')}</div>
          <div className="text-muted-foreground text-xs">{t('web.inspector.sessionRuntime')}</div>
        </div>
        <Button
          aria-pressed={showInspector}
          className="gap-1.5"
          onClick={onToggleInspector}
          size="sm"
          variant={showInspector ? 'secondary' : 'ghost'}
        >
          <HugeiconsIcon
            className="size-3.5"
            icon={Activity01Icon}
          />
          {t('web.inspector.toggle')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 lg:flex">
        <div className="transcript-grid relative min-h-0 flex-1">
          <VirtualList
            ariaLive="polite"
            controlRef={transcriptRef}
            firstItemIndex={firstItemIndex}
            footer={
              pendingApprovals.length + pendingClarifications.length > 0 ? (
                <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 pb-5">
                  {pendingApprovals.map((approval) => (
                    <ApprovalCard
                      approval={approval}
                      key={approval.requestId}
                      onApproval={onApproval}
                    />
                  ))}
                  {pendingClarifications.map((clarification) => (
                    <ClarifyPrompt
                      key={clarification.requestId}
                      onAnswer={(answer) => onClarifyAnswer(clarification.requestId, answer)}
                      options={clarification.options}
                      question={clarification.question}
                    />
                  ))}
                </div>
              ) : (
                <div className="h-5" />
              )
            }
            getKey={(message) => message.id}
            header={
              viewMessages.length === 0 ? (
                <div className="mx-auto w-full max-w-4xl px-6 pt-5">
                  <div className="gradient-spotlight-card flex flex-col items-start gap-2.5 px-5 py-5">
                    <span className="label-mono">{t('web.chat.sessionReady')}</span>
                    <p className="poster-heading text-foreground text-xl">{t('web.chat.start')}</p>
                    <p className="max-w-xl text-muted-foreground text-sm">{t('web.chat.hint')}</p>
                  </div>
                </div>
              ) : (
                <div className="h-5" />
              )
            }
            items={viewMessages}
            onAtBottomChange={onAtBottomChange}
            onEndReached={onEndReached}
            onStartReached={onStartReached}
            renderItem={(message) => (
              <div className="mx-auto w-full max-w-4xl px-6 pb-5">
                {isToolItem(message) ? (
                  <ToolStepView step={message} />
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
                    msg={message}
                    onBranch={onBranch}
                    onRestore={onRestore}
                    onSkillPreview={onSkillPreview}
                  />
                )}
              </div>
            )}
            role="log"
            stickToBottom
            style={{ height: '100%' }}
          />

          {!atBottom &&
            (pendingApprovals.length + pendingClarifications.length > 0 ? (
              <Button
                className="absolute bottom-3 left-1/2 -translate-x-1/2 gap-1.5 rounded-full shadow-md"
                onClick={() => onScrollToBottom('smooth')}
                size="sm"
                variant="secondary"
              >
                <HugeiconsIcon
                  className="size-3.5"
                  icon={ArrowDown01Icon}
                />
                {t('web.chat.pendingActions', {
                  count: pendingApprovals.length + pendingClarifications.length
                })}
              </Button>
            ) : (
              <Button
                aria-label={t('web.chat.scrollBottom')}
                className="absolute bottom-3 left-1/2 size-8 -translate-x-1/2 rounded-full shadow-md"
                onClick={() => onScrollToBottom('smooth')}
                size="icon"
                variant="secondary"
              >
                <HugeiconsIcon
                  className="size-4"
                  icon={ArrowDown01Icon}
                />
              </Button>
            ))}
        </div>
        {showInspector ? <AgentLoopInspector items={inspectorItems} /> : null}
      </div>

      <div className="border-border/70 border-t px-4 py-3">
        {isReadOnly ? (
          <div className="mx-auto flex max-w-4xl items-center justify-center gap-2 py-2 text-muted-foreground text-sm">
            <span className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
              {currentSession?.origin?.client ?? currentSession?.origin?.surface}
            </span>
            <span>{t('web.chat.readOnly')}</span>
          </div>
        ) : null}
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          {!isReadOnly && messageQueue.length > 0 ? (
            <div className="panel-subtle flex items-center gap-1.5 border-dashed px-3 py-2 text-muted-foreground text-xs">
              <span className="tabular-nums">{t('web.chat.queued', { count: messageQueue.length })}</span>
              <span className="text-muted-foreground/40">·</span>
              <kbd className="rounded border bg-background px-1 font-mono text-[10px]">⌥⌘↵</kbd>
              <span>{t('web.chat.steer')}</span>
              <button
                className="ml-auto rounded p-0.5 hover:bg-accent hover:text-accent-foreground"
                onClick={onClearQueue}
                title={t('web.chat.clearQueue')}
                type="button"
              >
                <HugeiconsIcon
                  className="size-3"
                  icon={Cancel01Icon}
                />
              </button>
            </div>
          ) : null}
          <div className="flex items-end gap-2.5">
            <div className="relative flex-1">
              {skillMenuOpen && !isReadOnly ? (
                <CommandMenu
                  activeSkill={activeSkill}
                  items={menuItems}
                  onApply={onCommandItemApply}
                  onHover={onCommandItemHover}
                />
              ) : null}
              <ComposerShell
                access={{
                  mode: isReadOnly ? 'ask' : accessMode,
                  onChange: onAccessModeChange
                }}
                ariaLabel="Message monad"
                busy={isBusy}
                contextUsage={contextUsage}
                disabled={disabled}
                model={model}
                onChange={onInputChange}
                onKeyDown={onKeyDown}
                onStop={onStop}
                onSubmit={onSubmit}
                onVoiceText={onVoiceText}
                placeholder={t('web.chat.placeholder')}
                skillToken={activeInputSkillToken}
                value={value}
                voice={{
                  modelConfigured: voiceModelConfigured,
                  onSettingsClick: onVoiceSettingsClick,
                  transcribeAudio: onVoiceTranscribe
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ApprovalCard({
  approval,
  onApproval
}: {
  approval: PendingApproval;
  onApproval: (
    approval: PendingApproval,
    allow: boolean,
    scope: 'once' | 'session' | 'global',
    reason?: string
  ) => void;
}) {
  const t = useT();

  return (
    <div className="panel-subtle flex max-w-170 flex-col gap-2 self-start border-warning/40 bg-warning/10 px-4 py-4">
      <div className="flex items-center gap-2 font-medium text-sm text-warning">
        <HugeiconsIcon
          className="size-4"
          icon={ShieldQuestionMarkIcon}
        />
        {approval.tool === 'fs_path_access' ? (
          t('web.chat.pathAccessTitle')
        ) : (
          <>
            {t('web.chat.approveTitle')}: <code className="font-mono">{approval.tool}</code>
          </>
        )}
      </div>
      {approval.tool === 'fs_path_access' && approval.key ? (
        <div className="flex items-baseline gap-1.5 text-muted-foreground text-xs">
          <span className="shrink-0">{t('web.chat.pathAccessDir')}:</span>
          <code className="min-w-0 break-all font-mono">{approval.key}</code>
        </div>
      ) : approval.input !== undefined ? (
        <pre className="max-h-32 overflow-auto rounded-(--radius-md) bg-background/60 p-3 text-muted-foreground text-xs">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => onApproval(approval, true, 'once')}
          size="sm"
        >
          <HugeiconsIcon icon={CheckIcon} /> {t('web.chat.approveOnce')}
        </Button>
        <Button
          onClick={() => onApproval(approval, true, 'session')}
          size="sm"
          variant={approval.key === 'host-control' ? undefined : 'outline'}
        >
          {t('web.chat.approveSession')}
        </Button>
        {approval.key !== 'host-control' && (
          <Button
            onClick={() => onApproval(approval, true, 'global')}
            size="sm"
            variant="outline"
          >
            {t('web.chat.approveAlways')}
          </Button>
        )}
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

function CommandMenu({
  activeSkill,
  items,
  onApply,
  onHover
}: {
  activeSkill: number;
  items: SessionCommandMenuItem[];
  onApply: (item: SessionCommandMenuItem) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className="glass-surface absolute bottom-full left-0 z-10 mb-3 w-full overflow-hidden text-popover-foreground">
      <ScrollArea className="max-h-60">
        <div className="p-1">
          {items.map((item, index) => (
            <button
              className={cn(
                'flex w-full flex-col items-start gap-0.5 rounded-(--radius-md) px-3 py-2 text-left',
                index === Math.min(activeSkill, items.length - 1)
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50'
              )}
              key={item.key}
              onMouseDown={(event) => {
                event.preventDefault();
                onApply(item);
              }}
              onMouseEnter={() => onHover(index)}
              type="button"
            >
              <span className="flex w-full items-center gap-1.5">
                {item.icon && (item.icon.startsWith('http://') || item.icon.startsWith('https://')) ? (
                  <span className="grid size-5 shrink-0 place-items-center rounded border bg-background text-xs">
                    <span
                      className="size-full rounded bg-center bg-cover"
                      style={{ backgroundImage: `url(${item.icon})` }}
                    />
                  </span>
                ) : renderableIconText(item.icon) ? (
                  <span className="grid size-5 shrink-0 place-items-center rounded border bg-background text-xs">
                    {renderableIconText(item.icon)}
                  </span>
                ) : item.typeBadge === 'Skill' ? (
                  <HugeiconsIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    icon={BoxIcon}
                  />
                ) : null}
                <span className="font-medium font-mono text-xs">{item.label}</span>
                {item.version ? (
                  <span className="label-mono rounded-full border border-border/70 px-2 py-1">v{item.version}</span>
                ) : null}
                {item.typeBadge && (
                  <span className="label-mono rounded-full border border-border/70 bg-muted/60 px-2 py-1">
                    {item.typeBadge}
                  </span>
                )}
                {item.badge && (
                  <span className="label-mono rounded-full border border-border/70 px-2 py-1">{item.badge}</span>
                )}
              </span>
              {item.hint && <span className="line-clamp-1 text-muted-foreground text-xs">{item.hint}</span>}
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

const SessionLineage = memo(function SessionLineage({
  sessionId,
  onSelect
}: {
  sessionId: SessionId;
  onSelect: (id: SessionId) => void;
}) {
  const t = useT();
  const { data } = useProvenanceQuery(sessionId);
  const parent = data?.ancestors.at(-1);
  const branches = data?.descendants ?? [];
  if (!parent && branches.length === 0) return null;

  return (
    <div className="flex items-center gap-2 border-b px-4 py-1.5 text-muted-foreground text-xs">
      {parent && (
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground"
          onClick={() => onSelect(parent.id)}
          type="button"
        >
          <HugeiconsIcon
            className="size-3"
            icon={GitBranchIcon}
          />
          <span className="text-muted-foreground/70">{t('web.chat.lineageParent')}</span>
          <span className="max-w-40 truncate font-medium text-foreground">{parent.title}</span>
        </button>
      )}
      {branches.length > 0 && (
        <span className="flex items-center gap-1">
          <span className="text-muted-foreground/40">·</span>
          {t('web.chat.lineageBranches', { count: branches.length })}
        </span>
      )}
    </div>
  );
});

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
