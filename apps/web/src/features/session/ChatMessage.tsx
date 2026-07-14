import {
  AlertCircleIcon,
  CheckIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  GitBranchIcon,
  RotateLeft01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Button,
  cn,
  Message as ElementsMessage,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  Shimmer
} from '@monad/ui';
import { memo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { MessageBody } from './MessageBody';

export interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  pending?: boolean;
  label?: string;
  error?: boolean;
  /** This assistant segment is still streaming — render a live cursor. */
  streaming?: boolean;
  type?: string;
  data?: unknown;
}

const ReasoningBubble = memo(function ReasoningBubble({ text, streaming }: { text: string; streaming: boolean }) {
  const t = useT();
  return (
    <Reasoning
      className="mb-1 w-full px-1"
      isStreaming={streaming}
    >
      <ReasoningTrigger
        labels={{
          thinking: t('web.reasoning.thinking'),
          thoughtFew: t('web.reasoning.thoughtFew'),
          thoughtSeconds: (seconds) => t('web.reasoning.thoughtSeconds', { seconds })
        }}
      />
      <ReasoningContent className="max-h-48 overflow-y-auto">{text}</ReasoningContent>
    </Reasoning>
  );
});

export const Message = memo(function Message({
  msg,
  assistantLabel,
  onBranch,
  onRestore,
  onSkillPreview
}: {
  msg: Msg;
  assistantLabel: string;
  onBranch?: (messageId: string) => void;
  onRestore?: (messageId: string) => void;
  onSkillPreview?: (id: string) => void;
}) {
  const t = useT();
  const isUser = msg.role === 'user';
  const label = msg.label ?? assistantLabel;
  const [copied, setCopied] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(msg.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  // Branch/restore target persisted messages, so offer them only on settled (non-streaming) ones.
  const canEdit = !msg.pending && !msg.streaming && !msg.error && msg.type !== 'directive';

  if (msg.type === 'directive') {
    return (
      <div className="flex items-center gap-3 self-stretch py-1 text-[10px] text-muted-foreground/50">
        <span className="h-px flex-1 bg-border/40" />
        <span className="label-mono flex items-center gap-1">
          <HugeiconsIcon
            className="size-2.5"
            icon={ComputerTerminal01Icon}
          />
          {msg.text}
        </span>
        <span className="h-px flex-1 bg-border/40" />
      </div>
    );
  }

  return (
    <ElementsMessage
      className={cn('gap-2', isUser ? 'max-w-[min(82%,42rem)] items-end self-end' : 'max-w-3xl items-start self-start')}
      from={msg.role}
    >
      <span
        className={cn('label-mono px-1', isUser && 'text-right')}
        data-message-pending={msg.pending ? 'true' : undefined}
      >
        {isUser ? (
          t('web.chat.you')
        ) : msg.pending ? (
          <Shimmer
            as="span"
            duration={1.35}
          >
            {label}
          </Shimmer>
        ) : (
          label
        )}
      </span>
      {!isUser && msg.reasoning && (
        <ReasoningBubble
          streaming={Boolean(msg.streaming)}
          text={msg.reasoning}
        />
      )}
      {!msg.pending && (
        <MessageContent
          className={cn(
            'wrap-break-word text-[0.95rem] leading-7',
            isUser
              ? 'rounded-(--radius-xl) rounded-br-(--radius-xs) border border-primary/16 bg-accent px-4 py-3 text-foreground shadow-xs'
              : 'w-full overflow-visible rounded-none bg-transparent px-1 py-0 text-foreground',
            msg.type &&
              msg.type !== 'text' &&
              msg.type !== 'markdown' &&
              !isUser &&
              'rounded-(--radius-lg) border border-border/75 bg-card px-4 py-3 shadow-xs',
            msg.error &&
              'rounded-(--radius-lg) border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive'
          )}
        >
          {msg.error ? (
            <div className="flex items-start gap-2">
              <HugeiconsIcon
                className="mt-0.5 size-4 shrink-0"
                icon={AlertCircleIcon}
              />
              <MessageBody
                data={msg.data}
                isUser={isUser}
                onSkillPreview={onSkillPreview}
                text={msg.text}
                type={msg.type}
              />
            </div>
          ) : msg.type && msg.type !== 'text' && msg.type !== 'markdown' ? (
            <MessageBody
              data={msg.data}
              isUser={isUser}
              onSkillPreview={onSkillPreview}
              text={msg.text}
              type={msg.type}
            />
          ) : isUser ? (
            <MessageBody
              data={msg.data}
              isUser={isUser}
              onSkillPreview={onSkillPreview}
              text={msg.text}
              type={msg.type}
            />
          ) : (
            <MessageResponse>{msg.text}</MessageResponse>
          )}
        </MessageContent>
      )}
      {!msg.pending &&
        msg.text &&
        (confirmRestore ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t('web.chat.restoreConfirm')}</span>
            <Button
              className="h-6"
              onClick={() => {
                setConfirmRestore(false);
                onRestore?.(msg.id);
              }}
              size="sm"
              variant="destructive"
            >
              {t('web.chat.restoreHere')}
            </Button>
            <Button
              className="h-6"
              onClick={() => setConfirmRestore(false)}
              size="sm"
              variant="ghost"
            >
              {t('web.cancel')}
            </Button>
          </div>
        ) : (
          <MessageActions
            className={cn(
              'message-actions opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media_(hover:none),_(pointer:coarse)]:opacity-100',
              isUser && 'justify-end'
            )}
          >
            <MessageAction
              className="size-6"
              onClick={copy}
              tooltip={t('web.chat.copyMsg')}
            >
              {copied ? (
                <HugeiconsIcon
                  className="size-3.5"
                  icon={CheckIcon}
                />
              ) : (
                <HugeiconsIcon
                  className="size-3.5"
                  icon={Copy01Icon}
                />
              )}
            </MessageAction>
            {canEdit && onBranch && (
              <MessageAction
                className="size-6"
                onClick={() => onBranch(msg.id)}
                tooltip={t('web.chat.branchHere')}
              >
                <HugeiconsIcon
                  className="size-3.5"
                  icon={GitBranchIcon}
                />
              </MessageAction>
            )}
            {canEdit && onRestore && (
              <MessageAction
                className="size-6"
                onClick={() => setConfirmRestore(true)}
                tooltip={t('web.chat.restoreHere')}
              >
                <HugeiconsIcon
                  className="size-3.5"
                  icon={RotateLeft01Icon}
                />
              </MessageAction>
            )}
          </MessageActions>
        ))}
    </ElementsMessage>
  );
});
