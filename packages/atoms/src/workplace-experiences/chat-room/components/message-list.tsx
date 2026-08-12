import type { ChannelIcon, MessageId, UIMessageOutlineItem } from '@monad/protocol';
import type { Message, MessageAttachment, TypingIndicator } from '../../experience/types.ts';
import type { WorkplaceExperienceHostAction } from '../../host-context.tsx';
import type { MessageRowLabels } from './message-row.tsx';

import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { projectMemberIdSchema, sessionIdSchema } from '@monad/protocol';
import { activeMessageOutlineIds, MessageOutline, type MessageOutlineItem } from '@monad/ui/components/MessageOutline';
import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { isMessageAttachmentRef } from '../../experience/types.ts';
import { useWorkplaceExperienceHost } from '../../host-context.tsx';
import { projectSessionUiKey, useChatRoomExperienceStore } from '../store.ts';
import { uniqueImageAttachments } from '../utils/local-file-reference.ts';
import { AttachmentChip } from './attachment-chip.tsx';
import { MarkdownWithMentions, MessageRow } from './message-row.tsx';
import { shouldSuppressReplyPreview } from './reply-preview.tsx';
import { TypingRow } from './transcript-skeleton.tsx';

const HEADER_SPACER = <div style={{ height: 24 }} />;
const COMPOSER_CLEARANCE = 'calc(var(--chat-room-composer-clearance, 132px) + 24px)';
// Shared content column: rows and the composer cap at the same width and center together, matching
// the plain-chat `session-content-column` (800px). The column shrinks freely below the cap.
const CONTENT_COLUMN_MAX_WIDTH = 800;
const MESSAGE_ROW_WRAP_STYLE = {
  boxSizing: 'border-box',
  margin: '0 auto',
  maxWidth: CONTENT_COLUMN_MAX_WIDTH,
  padding: '0 16px',
  width: '100%'
} satisfies CSSProperties;
const messageRenderKey = (m: Message): string => m.renderKey ?? m.id;

const MESSAGE_CHROME_HEIGHT = 72;
const MESSAGE_LINE_HEIGHT = 24;
const MESSAGE_CHARS_PER_LINE = 64;

/**
 * A guess at a message's rendered height, from its text alone. The virtual list picks its render
 * window from these, so a flat guess makes every long message mount only once it is already at
 * the viewport edge — and the scroll correction that follows its real measurement then lands in
 * view and drags the passage being read. Text length is a crude proxy but keeps the error within
 * a small factor instead of the ~30x a constant gives a code-heavy transcript.
 */
export function estimateMessageHeight(message: Message): number {
  const text = message.text ?? '';
  const wrapped = text
    .split('\n')
    .reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / MESSAGE_CHARS_PER_LINE)), 0);
  return MESSAGE_CHROME_HEIGHT + wrapped * MESSAGE_LINE_HEIGHT;
}
export type WorkspaceMessageOutlineItem = MessageOutlineItem & { preview: string };

function formatRelativeOutlineTime(message: Message, timeUnavailable: string): string {
  if (!message.orderKey) return timeUnavailable;
  const timestamp = Date.parse(message.orderKey);
  if (Number.isNaN(timestamp)) return message.time.trim() || message.orderKey;
  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (absSeconds < 60) return relative.format(diffSeconds, 'second');
  if (absSeconds < 3600) return relative.format(Math.round(diffSeconds / 60), 'minute');
  if (absSeconds <= 3600) return relative.format(Math.round(diffSeconds / 3600), 'hour');
  return (
    message.time.trim() ||
    new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
      day: 'numeric'
    }).format(new Date(timestamp))
  );
}

export function workspaceMessageOutlineItems(
  messages: Message[],
  timeUnavailable: string
): WorkspaceMessageOutlineItem[] {
  return messages.flatMap((message, index) => {
    if (message.kind !== 'human') return [];
    const preview = message.text.trim().replace(/\s+/g, ' ');
    return [
      {
        id: message.id,
        index,
        label: preview || `Message ${index + 1}`,
        preview: message.text,
        time: formatRelativeOutlineTime(message, timeUnavailable)
      }
    ];
  });
}

export function completeWorkspaceMessageOutlineItems(
  messageOutline: readonly UIMessageOutlineItem[],
  renderedItems: WorkspaceMessageOutlineItem[],
  timeUnavailable: string
): WorkspaceMessageOutlineItem[] {
  const renderedById = new Map(renderedItems.map((item) => [item.id, item]));
  const items = messageOutline.map((item, index) => {
    const rendered = renderedById.get(item.id);
    const preview = item.text.trim().replace(/\s+/g, ' ');
    return {
      id: item.id,
      index,
      label: preview || `Message ${index + 1}`,
      preview: item.text,
      time: rendered?.time ?? timeUnavailable
    };
  });
  const knownIds = new Set(messageOutline.map((item) => item.id));
  for (const item of renderedItems) {
    if (!knownIds.has(item.id)) items.push({ ...item, index: items.length });
  }
  return items;
}

/**
 * The list follows appends and in-place growth by itself while the reader is at the bottom, so the
 * only jump left to force is the reader's OWN message: sending from a scrolled-up position should
 * bring them back to see it. Once per message — a later `sending` -> `sent` transition on the same
 * message must not yank a reader who has since scrolled up to re-read something.
 */
export function shouldJumpToOwnMessage(
  messageKey: string | undefined,
  alreadyJumpedKey: string | undefined,
  localStatus?: Message['localStatus']
): boolean {
  return Boolean(messageKey) && messageKey !== alreadyJumpedKey && Boolean(localStatus);
}

export type ChatMessageListRoom = {
  activeSessionId: string | null;
  actions?: readonly WorkplaceExperienceHostAction[];
  /** Brand marks by channel type, for a message's delivery-origin badge. */
  channelIcons?: ReadonlyMap<string, ChannelIcon>;
  jumpToLive: () => void;
  /** Load newer rows; returns false when no load started so the scroll edge stays armed. */
  loadNewer: () => boolean;
  /** Load older rows; returns false when no load started so the scroll edge stays armed. */
  loadOlder: () => boolean;
  messageOutline: readonly UIMessageOutlineItem[];
  messages: Message[];
  onReply?: (message: Message) => void;
  onRequestedMessageResolved?: () => void;
  openAgentCard?: (id: string) => void;
  openAtMessage?: (messageId: MessageId, options?: { targetVisible?: boolean }) => Promise<boolean>;
  projectId: string;
  replyTargets: ReadonlyMap<string, Message | null>;
  requestedMessageId?: string | null;
  transcriptMode: 'history' | 'live';
  typing: TypingIndicator | null;
};

export function ChatMessageList({
  room,
  labels
}: {
  room: ChatMessageListRoom;
  labels: MessageRowLabels & {
    goToMessage: (label: string) => string;
    jumpLatest: string;
    messageOutline: string;
    timeUnavailable: string;
  };
}): React.ReactElement {
  const { resolveAgentIdentity } = useWorkplaceExperienceHost();
  const shellRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VirtualListHandle>(null);
  const jumpedMessageKeyRef = useRef<string | undefined>(undefined);
  const [atBottom, setAtBottom] = useState(true);
  const [visibleRange, setVisibleRange] = useState<{ endIndex: number; startIndex: number } | null>(null);
  const [outlineTop, setOutlineTop] = useState<string>('50%');
  const [localRequestedMessageId, setLocalRequestedMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedMessageIdRef = useRef<string | null>(null);
  const lastMessage = room.messages.at(-1);
  const uiKey = projectSessionUiKey(room.projectId, room.activeSessionId);
  const openFilePreview = useChatRoomExperienceStore((state) => state.openFilePreview);
  const sessionAttachments = useMemo(
    () => room.messages.flatMap((message) => message.attachments ?? []),
    [room.messages]
  );
  const imageGallery = useMemo(() => uniqueImageAttachments(sessionAttachments), [sessionAttachments]);
  const onOpenAttachment = useCallback(
    (attachment: MessageAttachment, line?: number) => {
      if (isMessageAttachmentRef(attachment))
        openFilePreview(uiKey, {
          target: { attachmentId: attachment.id },
          attachment,
          ...(attachment.mime.startsWith('image/') ? { gallery: imageGallery } : {}),
          line
        });
    },
    [imageGallery, openFilePreview, uiKey]
  );
  const onOpenFilePath = useCallback(
    (path: string, authorId: string, line?: number) => {
      if (!room.activeSessionId) return;
      const projectMemberId = projectMemberIdSchema.safeParse(authorId);
      const sessionId = sessionIdSchema.safeParse(room.activeSessionId);
      if (!projectMemberId.success || !sessionId.success) return;
      openFilePreview(uiKey, {
        target: {
          path,
          sessionId: sessionId.data,
          projectMemberId: projectMemberId.data
        },
        line
      });
    },
    [openFilePreview, room.activeSessionId, uiKey]
  );
  const lastMessageKey = lastMessage ? messageRenderKey(lastMessage) : undefined;
  const messagesById = useMemo(() => new Map(room.messages.map((message) => [message.id, message])), [room.messages]);
  const previousMessageIds = useMemo(
    () => new Map(room.messages.map((message, index) => [message.id, room.messages[index - 1]?.id])),
    [room.messages]
  );
  const renderedOutlineItems = useMemo(
    () => workspaceMessageOutlineItems(room.messages, labels.timeUnavailable),
    [labels.timeUnavailable, room.messages]
  );
  const outlineItems = useMemo(
    () => completeWorkspaceMessageOutlineItems(room.messageOutline, renderedOutlineItems, labels.timeUnavailable),
    [labels.timeUnavailable, renderedOutlineItems, room.messageOutline]
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
    if (typeof ResizeObserver === 'undefined') {
      return () => window.removeEventListener('resize', updateOutlineTop);
    }
    const observer = new ResizeObserver(updateOutlineTop);
    observer.observe(shell);
    return () => {
      window.removeEventListener('resize', updateOutlineTop);
      observer.disconnect();
    };
  }, []);
  const activeOutlineIds = useMemo(
    () => activeMessageOutlineIds(renderedOutlineItems, visibleRange, room.messages.length),
    [renderedOutlineItems, room.messages.length, visibleRange]
  );
  const requestedMessageId = room.requestedMessageId ?? localRequestedMessageId;
  useEffect(() => {
    if (!requestedMessageId) {
      openedMessageIdRef.current = null;
      return;
    }
    const target = messagesById.get(requestedMessageId);
    if (!target) {
      if (openedMessageIdRef.current !== requestedMessageId) {
        openedMessageIdRef.current = requestedMessageId;
        const openAtMessage = room.openAtMessage;
        if (!openAtMessage) {
          openedMessageIdRef.current = null;
          setLocalRequestedMessageId(null);
          room.onRequestedMessageResolved?.();
          return;
        }
        void openAtMessage(requestedMessageId as MessageId).then((opened) => {
          if (opened || openedMessageIdRef.current !== requestedMessageId) return;
          openedMessageIdRef.current = null;
          setLocalRequestedMessageId(null);
          room.onRequestedMessageResolved?.();
        });
      }
      return;
    }
    void room.openAtMessage?.(requestedMessageId as MessageId, { targetVisible: true });
    const key = messageRenderKey(target);
    setHighlightedMessageId(requestedMessageId);
    const scroll = () => listRef.current?.scrollToKey(key, { align: 'center' });
    scroll();
    const firstFrame = requestAnimationFrame(() => {
      scroll();
      requestAnimationFrame(scroll);
    });
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1400);
    setLocalRequestedMessageId(null);
    room.onRequestedMessageResolved?.();
    return () => cancelAnimationFrame(firstFrame);
  }, [messagesById, requestedMessageId, room]);
  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    []
  );
  const renderMessageItem = useCallback(
    (msg: Message) => {
      const replyToMessageId = msg.replyToMessageId;
      const replyTarget = replyToMessageId
        ? (messagesById.get(replyToMessageId) ?? room.replyTargets.get(replyToMessageId))
        : undefined;
      const replyResolutionKnown = Boolean(
        replyToMessageId && (messagesById.has(replyToMessageId) || room.replyTargets.has(replyToMessageId))
      );
      const showReplyPreview = !shouldSuppressReplyPreview(replyToMessageId, previousMessageIds.get(msg.id));
      return (
        <div
          className={`chat-room-message-row-wrap ${highlightedMessageId === msg.id ? 'message-deep-link-target' : ''}`}
          style={MESSAGE_ROW_WRAP_STYLE}
        >
          <MessageRow
            Attachment={AttachmentChip}
            actions={room.actions}
            channelIcons={room.channelIcons}
            labels={labels}
            linkAttachments={sessionAttachments}
            msg={msg}
            onAgentClick={room.openAgentCard}
            onOpenAttachment={onOpenAttachment}
            onOpenFilePath={(path, line) => onOpenFilePath(path, msg.authorId, line)}
            onOpenReplyTarget={
              showReplyPreview && replyTarget ? () => setLocalRequestedMessageId(replyTarget.id) : undefined
            }
            onReply={room.onReply}
            replyTarget={showReplyPreview && replyResolutionKnown ? (replyTarget ?? null) : undefined}
            resolveAgentIdentity={resolveAgentIdentity}
          />
        </div>
      );
    },
    [
      highlightedMessageId,
      labels,
      sessionAttachments,
      room.channelIcons,
      messagesById,
      onOpenAttachment,
      onOpenFilePath,
      previousMessageIds,
      room.actions,
      room.onReply,
      room.openAgentCard,
      room.replyTargets,
      resolveAgentIdentity
    ]
  );
  useLayoutEffect(() => {
    if (!shouldJumpToOwnMessage(lastMessageKey, jumpedMessageKeyRef.current, lastMessage?.localStatus)) return;
    jumpedMessageKeyRef.current = lastMessageKey;
    listRef.current?.scrollToBottom('auto');
  }, [lastMessage?.localStatus, lastMessageKey]);
  const footer = useMemo(
    () => (
      <>
        {room.typing ? (
          <div style={{ boxSizing: 'border-box', padding: '0 16px', width: '100%' }}>
            <TypingRow typing={room.typing} />
          </div>
        ) : null}
        <div style={{ height: COMPOSER_CLEARANCE }} />
      </>
    ),
    [room.typing]
  );

  return (
    <div
      className="chat-message-list-shell"
      ref={shellRef}
      style={
        {
          position: 'relative',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          '--chat-message-outline-top': outlineTop
        } as CSSProperties
      }
    >
      <MessageOutline
        activeIds={activeOutlineIds}
        ariaLabel={labels.messageOutline}
        goToLabel={(item) => labels.goToMessage(item.label)}
        items={outlineItems}
        onSelect={setLocalRequestedMessageId}
        renderPreview={(item) => <MarkdownWithMentions text={item.preview} />}
      />
      <VirtualList
        ariaLive="polite"
        className="scwf-scroll"
        controlRef={listRef}
        estimateRowHeight={estimateMessageHeight}
        footer={footer}
        getKey={messageRenderKey}
        header={HEADER_SPACER}
        items={room.messages}
        // Remount per session: the list instance holds scroll state (sticky detach, settle-on-load,
        // paging arms) that describes ONE transcript. switchSession swaps room.messages in this
        // same mounted component, and a detach carried over from the previous session would leave
        // the new one's live tail unfollowed with no gesture to clear it.
        key={uiKey}
        onAtBottomChange={setAtBottom}
        onEndReached={room.transcriptMode === 'history' ? room.loadNewer : undefined}
        onRangeChange={setVisibleRange}
        onStartReached={room.loadOlder}
        renderItem={renderMessageItem}
        role="log"
        settleAtBottomOnLoad
        stickToBottom
        style={{ boxSizing: 'border-box', flex: 1, overflowX: 'hidden' }}
        viewportOverlay={
          <div
            style={{
              background:
                'linear-gradient(to top, rgb(var(--backgroundColor-primary) / 1) 0%, rgb(var(--backgroundColor-primary) / 1) calc(100% - 64px), rgb(var(--backgroundColor-primary) / 0) 100%)',
              height: 'var(--chat-room-composer-clearance, 132px)',
              pointerEvents: 'none'
            }}
          />
        }
      />
      {atBottom && room.transcriptMode === 'live' ? null : (
        <button
          aria-label={labels.jumpLatest}
          className="workplace-action"
          onClick={() => {
            if (room.transcriptMode === 'history') room.jumpToLive();
            // Always drive the list too, even leaving history mode: jumpToLive only swaps the item
            // window, and the shrink-clamp that lands the viewport at the new bottom is upward —
            // invisible to the re-attach path. scrollToBottom is what re-arms following.
            listRef.current?.scrollToBottom('smooth');
          }}
          style={{
            position: 'absolute',
            bottom: 'calc(var(--chat-room-composer-clearance, 132px) + 12px)',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 38,
            height: 38,
            padding: 0,
            borderRadius: 999,
            border: `1px solid ${'var(--border)'}`,
            background: 'var(--card)',
            boxShadow: '0 10px 28px -18px rgb(0 0 0 / 0.45), var(--shadow-sm)',
            color: 'var(--foreground)'
          }}
          title={labels.jumpLatest}
          type="button"
        >
          <HugeiconsIcon
            aria-hidden="true"
            icon={ArrowDown01Icon}
            size={18}
            strokeWidth={2.2}
          />
        </button>
      )}
    </div>
  );
}
