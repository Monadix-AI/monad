import type { CommandItem } from '@monad/protocol';

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
  cn,
  Message as ElementsMessage,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger
} from '@monad/ui';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

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
  seq?: string;
  /** This assistant segment is still streaming — render a live cursor. */
  streaming?: boolean;
  type?: string;
  data?: unknown;
}

type ReasoningFollowEvent = 'content-appended' | 'user-scroll';

export function nextReasoningFollowState(following: boolean, event: ReasoningFollowEvent): boolean {
  return event === 'user-scroll' ? false : following;
}

const REASONING_SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' ']);

const ReasoningBubble = memo(function ReasoningBubble({ text, streaming }: { text: string; streaming: boolean }) {
  const t = useT();
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const programmaticScrollRef = useRef(false);

  const stopFollowing = useCallback(() => {
    followingRef.current = nextReasoningFollowState(followingRef.current, 'user-scroll');
  }, []);

  useEffect(() => {
    if (!text || !streaming || !followingRef.current || !contentRef.current) return;
    const content = contentRef.current;
    programmaticScrollRef.current = true;
    content.scrollTop = content.scrollHeight;
    const frame = requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [streaming, text]);

  return (
    <Reasoning
      className="mb-1 w-full px-1"
      defaultOpen={false}
      isStreaming={streaming}
    >
      <ReasoningTrigger
        data-virtual-list-anchor="true"
        labels={{
          thinking: t('web.reasoning.thinking'),
          thoughtFew: t('web.reasoning.thoughtFew'),
          thoughtSeconds: (seconds) => t('web.reasoning.thoughtSeconds', { seconds })
        }}
      />
      <ReasoningContent
        className="max-h-48 overflow-y-auto overscroll-contain"
        onKeyDown={(event) => {
          if (REASONING_SCROLL_KEYS.has(event.key)) stopFollowing();
        }}
        onScroll={() => {
          if (!programmaticScrollRef.current) stopFollowing();
        }}
        onTouchMove={stopFollowing}
        onWheel={stopFollowing}
        ref={contentRef}
        tabIndex={0}
      >
        {text}
      </ReasoningContent>
    </Reasoning>
  );
});

export function shouldRenderDirectiveAsMarkdown({
  data,
  role,
  type
}: {
  data: unknown;
  role: Msg['role'];
  type?: string;
}): boolean {
  return (
    type === 'directive' &&
    role === 'assistant' &&
    typeof data === 'object' &&
    data !== null &&
    'effect' in data &&
    typeof data.effect === 'object' &&
    data.effect !== null &&
    'type' in data.effect &&
    data.effect.type === 'help'
  );
}

export const Message = memo(function Message({
  msg,
  assistantLabel,
  onBranch,
  onRestore,
  commands,
  onSkillPreview
}: {
  msg: Msg;
  commands?: CommandItem[];
  assistantLabel: string;
  onBranch?: (messageId: string, role: Msg['role']) => void;
  onRestore?: (messageId: string, text: string) => void;
  onSkillPreview?: (id: string) => void;
}) {
  const t = useT();
  const isUser = msg.role === 'user';
  const label = msg.label ?? assistantLabel;
  const [copied, setCopied] = useState(false);
  const rendersMarkdownDirective = shouldRenderDirectiveAsMarkdown({
    data: msg.data,
    role: msg.role,
    type: msg.type
  });

  const copy = () => {
    void navigator.clipboard?.writeText(msg.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  // Branch/restore target persisted messages, so offer them only on settled (non-streaming) ones.
  const canEdit = !msg.pending && !msg.streaming && !msg.error && msg.type !== 'directive';

  if (msg.type === 'directive' && !rendersMarkdownDirective) {
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
      {!isUser && !msg.pending ? <span className="label-mono px-1">{label}</span> : null}
      {!isUser && msg.reasoning && (
        <ReasoningBubble
          streaming={Boolean(msg.streaming)}
          text={msg.reasoning}
        />
      )}
      {!msg.pending &&
        (msg.error ? (
          <MessageContent className="w-full overflow-visible rounded-(--radius-lg) border border-destructive/25 bg-destructive/[0.06] px-4 py-3 text-foreground">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
                <HugeiconsIcon
                  className="size-4"
                  icon={AlertCircleIcon}
                />
              </span>
              <div className="min-w-0 flex-1 text-foreground/85 text-sm leading-6">
                <MessageBody
                  commands={commands}
                  data={msg.data}
                  isUser={isUser}
                  onSkillPreview={onSkillPreview}
                  text={msg.text}
                  type={msg.type}
                />
              </div>
            </div>
          </MessageContent>
        ) : (
          <MessageContent
            className={cn(
              'wrap-break-word text-[0.95rem] leading-7',
              isUser
                ? 'rounded-(--radius-xl) rounded-br-(--radius-xs) border border-primary/16 bg-accent px-4 py-3 text-foreground shadow-xs'
                : 'w-full overflow-visible rounded-none bg-transparent px-1 py-0 text-foreground',
              msg.type &&
                msg.type !== 'text' &&
                msg.type !== 'markdown' &&
                !rendersMarkdownDirective &&
                !isUser &&
                'rounded-(--radius-lg) border border-border/75 bg-card px-4 py-3 shadow-xs'
            )}
          >
            {msg.type && msg.type !== 'text' && msg.type !== 'markdown' ? (
              <MessageBody
                commands={commands}
                data={msg.data}
                isUser={isUser}
                onSkillPreview={onSkillPreview}
                text={msg.text}
                type={msg.type}
              />
            ) : isUser ? (
              <MessageBody
                commands={commands}
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
        ))}
      {!msg.pending && msg.text && (
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
              onClick={() => onBranch(msg.id, msg.role)}
              tooltip={t('web.chat.branchHere')}
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={GitBranchIcon}
              />
            </MessageAction>
          )}
          {isUser && canEdit && onRestore && (
            <MessageAction
              className="size-6"
              onClick={() => onRestore(msg.id, msg.text)}
              tooltip={t('web.chat.restoreHere')}
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={RotateLeft01Icon}
              />
            </MessageAction>
          )}
        </MessageActions>
      )}
    </ElementsMessage>
  );
});
