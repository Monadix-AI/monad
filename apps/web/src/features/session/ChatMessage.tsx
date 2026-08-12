import type { ChannelIcon, CommandItem, MessageOrigin } from '@monad/protocol';
import type { ChannelOriginDetail } from '@monad/ui';
import type { MessageAttachmentView } from './message-attachment-view';

import {
  AlertCircleIcon,
  ArrowUp01Icon,
  Cancel01Icon,
  CheckIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  GitBranchIcon,
  MessageCircleReplyIcon,
  RotateLeft01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Button,
  ChannelOriginBadge,
  ComposerAttachmentStrip,
  cn,
  Message as ElementsMessage,
  faviconMarkdownComponents,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  Textarea
} from '@monad/ui';
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { useLocale, useT } from '#/components/I18nProvider';
import { MessageBody } from './MessageBody';
import { MessageReplyPreview } from './MessageReplyPreview';
import { formatMessageTimestamp } from './message-time';
import { nextReasoningFollowState } from './reasoning-follow';

export interface Msg {
  attachments?: MessageAttachmentView[];
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  pending?: boolean;
  label?: string;
  error?: boolean;
  seq?: string;
  /** Ingress provenance of the write that carried this message (absent on legacy rows). */
  origin?: MessageOrigin;
  serverEchoOrdinal?: number;
  replyToMessageId?: string;
  replyable?: boolean;
  retrySend?: () => void;
  /** This assistant segment is still streaming — render a live cursor. */
  streaming?: boolean;
  type?: string;
  data?: unknown;
}

/** Where a user message came from — rendered as the source channel's mark with a hover popover. */
export interface MessageSentFrom {
  label: string;
  icon?: ChannelIcon;
  details: ChannelOriginDetail[];
}

function MessageAttachments({ attachments }: { attachments: readonly MessageAttachmentView[] }) {
  const t = useT();
  return (
    <ComposerAttachmentStrip
      attachments={attachments.map((attachment) => ({
        contentType: attachment.mime,
        id: attachment.id,
        imageSrc: attachment.imageSrc,
        name: attachment.name,
        size: attachment.bytes
      }))}
      labels={{
        attachments: t('web.chat.attachments'),
        open: (name) => t('web.chat.openAttachment', { name })
      }}
    />
  );
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
      className="mb-0 w-full"
      defaultOpen={false}
      isStreaming={streaming}
    >
      <ReasoningTrigger
        className="min-h-7 w-fit max-w-full justify-start gap-2 p-0.5 font-ui text-[0.95rem] leading-6"
        iconClassName="size-4 shrink-0"
        labels={{
          thinking: t('web.reasoning.thinking'),
          thoughtFew: t('web.reasoning.thoughtFew'),
          thoughtSeconds: (seconds) => t('web.reasoning.thoughtSeconds', { count: seconds })
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

type RewindEditorState = {
  draft: string;
  mode: 'idle' | 'editing' | 'submitting';
};

type RewindEditorEvent =
  | { type: 'open'; text: string }
  | { type: 'change'; text: string }
  | { type: 'cancel' | 'failed' | 'submit' | 'succeeded' };

export function rewindEditorReducer(state: RewindEditorState, event: RewindEditorEvent): RewindEditorState {
  switch (event.type) {
    case 'open':
      return { draft: event.text, mode: 'editing' };
    case 'change':
      return { ...state, draft: event.text };
    case 'cancel':
    case 'succeeded':
      return { ...state, mode: 'idle' };
    case 'submit':
      return state.draft.trim() ? { ...state, mode: 'submitting' } : state;
    case 'failed':
      return { ...state, mode: 'editing' };
  }
}

export const Message = memo(function Message({
  msg,
  assistantLabel,
  onBranch,
  onOpenReplyTarget,
  onReply,
  replyTarget,
  onRestore,
  commands,
  onSkillPreview,
  sentFrom
}: {
  msg: Msg;
  commands?: CommandItem[];
  assistantLabel: string;
  onBranch?: (messageId: string) => void;
  onOpenReplyTarget?: () => void;
  onReply?: (message: Msg) => void;
  replyTarget?: (Msg & { label?: string }) | null;
  onRestore?: (messageId: string, text: string) => Promise<boolean>;
  onSkillPreview?: (id: string) => void;
  sentFrom?: MessageSentFrom;
}) {
  const t = useT();
  const locale = useLocale();
  const isUser = msg.role === 'user';
  // Constant for the message's lifetime; recomputing per streamed token would re-parse the same ISO
  // string on every frame of the active message.
  const timeLabel = useMemo(() => formatMessageTimestamp(msg.seq, locale), [locale, msg.seq]);
  const label = msg.label ?? assistantLabel;
  const [copied, setCopied] = useState(false);
  const [rewindEditor, dispatchRewindEditor] = useReducer(rewindEditorReducer, { draft: '', mode: 'idle' });
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
  const canReply = Boolean(msg.replyable && canEdit && onReply);
  const isEditing = rewindEditor.mode !== 'idle';
  const isSubmitting = rewindEditor.mode === 'submitting';

  const submitRewind = async () => {
    const text = rewindEditor.draft.trim();
    if (!onRestore || rewindEditor.mode !== 'editing' || !text) return;
    dispatchRewindEditor({ type: 'submit' });
    const succeeded = await onRestore(msg.id, text).catch(() => false);
    dispatchRewindEditor({ type: succeeded ? 'succeeded' : 'failed' });
  };

  if (msg.type === 'directive' && !rendersMarkdownDirective) {
    return (
      <div className="flex items-center gap-3 self-stretch py-1 text-[10px] text-muted-foreground/50">
        <span className="h-px flex-1 bg-border/40" />
        <span className="label-ui flex items-center gap-1">
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
      {!isUser ? (
        <span
          aria-live={msg.pending ? 'polite' : undefined}
          className={cn('label-ui px-1', msg.pending && 'agent-name-shimmer')}
          data-pending={msg.pending || undefined}
        >
          {label}
        </span>
      ) : null}
      {!isUser && msg.reasoning && (
        <ReasoningBubble
          streaming={Boolean(msg.streaming)}
          text={msg.reasoning}
        />
      )}
      {replyTarget !== undefined ? (
        <MessageReplyPreview
          className={cn(isUser ? 'bg-accent/60' : 'max-w-2xl bg-muted/40')}
          onOpen={() => onOpenReplyTarget?.()}
          target={replyTarget}
          unavailableLabel={t('web.chat.replyUnavailable')}
        />
      ) : null}
      {!msg.pending &&
        (msg.error ? (
          <MessageContent className="w-full overflow-visible rounded-lg border border-destructive/25 bg-destructive/6 px-4 py-3 text-foreground">
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
                {msg.attachments?.length ? <MessageAttachments attachments={msg.attachments} /> : null}
              </div>
            </div>
          </MessageContent>
        ) : (
          <MessageContent
            className={cn(
              'wrap-break-word text-[0.95rem] leading-7',
              isUser
                ? 'rounded-xl rounded-br-xs border border-primary/16 bg-accent px-4 py-3 text-foreground shadow-xs'
                : 'w-full overflow-visible rounded-none bg-transparent px-1 py-0 text-foreground',
              msg.type &&
                msg.type !== 'text' &&
                msg.type !== 'markdown' &&
                !rendersMarkdownDirective &&
                !isUser &&
                'rounded-lg border border-border/75 bg-card px-4 py-3 shadow-xs',
              isEditing && 'w-[min(70vw,42rem)] min-w-64'
            )}
          >
            {isUser && isEditing ? (
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitRewind();
                }}
              >
                <Textarea
                  aria-label={t('web.chat.rewindEdit')}
                  autoFocus
                  className="min-h-24 resize-y bg-background text-sm leading-6"
                  disabled={isSubmitting}
                  onChange={(event) => dispatchRewindEditor({ type: 'change', text: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    void submitRewind();
                  }}
                  value={rewindEditor.draft}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    disabled={isSubmitting}
                    onClick={() => dispatchRewindEditor({ type: 'cancel' })}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} />
                    {t('web.common.cancel')}
                  </Button>
                  <Button
                    disabled={isSubmitting || !rewindEditor.draft.trim()}
                    size="sm"
                    type="submit"
                  >
                    <HugeiconsIcon icon={ArrowUp01Icon} />
                    {t('web.chat.send')}
                  </Button>
                </div>
              </form>
            ) : msg.type && msg.type !== 'text' && msg.type !== 'markdown' ? (
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
              <MessageResponse components={faviconMarkdownComponents}>{msg.text}</MessageResponse>
            )}
            {msg.attachments?.length ? <MessageAttachments attachments={msg.attachments} /> : null}
          </MessageContent>
        ))}
      {!msg.pending && (msg.text || msg.attachments?.length) && !isEditing && (
        <MessageActions
          className={cn(
            'message-actions opacity-0 transition-none focus-within:opacity-100 group-hover:opacity-100 [&_*]:transition-none [@media_(hover:none),(pointer:coarse)]:opacity-100',
            isUser && 'justify-end'
          )}
        >
          {isUser && timeLabel ? (
            <span className="self-center whitespace-nowrap px-1 font-ui text-[10px] text-muted-foreground/70">
              {timeLabel}
            </span>
          ) : null}
          {canReply ? (
            <MessageAction
              className="size-6"
              onClick={() => onReply?.(msg)}
              tooltip={t('web.chat.reply')}
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={MessageCircleReplyIcon}
              />
            </MessageAction>
          ) : null}
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
          {msg.error && msg.retrySend ? (
            <MessageAction
              className="size-6"
              onClick={msg.retrySend}
              tooltip={t('web.chat.retry')}
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={RotateLeft01Icon}
              />
            </MessageAction>
          ) : null}
          {isUser && canEdit && onBranch && (
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
          {isUser && canEdit && onRestore && (
            <MessageAction
              className="size-6"
              onClick={() => dispatchRewindEditor({ type: 'open', text: msg.text })}
              tooltip={t('web.chat.restoreHere')}
            >
              <HugeiconsIcon
                className="size-3.5"
                icon={RotateLeft01Icon}
              />
            </MessageAction>
          )}
          {isUser && sentFrom ? (
            <ChannelOriginBadge
              ariaLabel={`${t('web.chat.sentFrom')} ${sentFrom.label}`}
              className="ml-0.5 self-center"
              details={sentFrom.details}
              icon={sentFrom.icon}
              name={sentFrom.label}
            />
          ) : null}
          {!isUser && timeLabel ? (
            <span className="self-center whitespace-nowrap px-1 font-ui text-[10px] text-muted-foreground/70">
              {timeLabel}
            </span>
          ) : null}
        </MessageActions>
      )}
    </ElementsMessage>
  );
});
