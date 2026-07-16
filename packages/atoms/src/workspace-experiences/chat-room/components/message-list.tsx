import type { Message, TypingIndicator } from '../../experience/types.ts';
import type { MessageRowLabels } from './message-row.tsx';

import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { activeMessageOutlineIds, MessageOutline, type MessageOutlineItem } from '@monad/ui/components/MessageOutline';
import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { useFirstItemIndex } from '@monad/ui/hooks/use-first-item-index';
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { AttachmentChip } from './attachment-chip.tsx';
import { MarkdownWithMentions, MessageRow } from './message-row.tsx';
import { TypingRow } from './transcript-skeleton.tsx';

const HEADER_SPACER = <div style={{ height: 24 }} />;
const COMPOSER_CLEARANCE = 'calc(var(--chat-room-composer-clearance, 132px) + 24px)';
const MESSAGE_ROW_WRAP_STYLE = { boxSizing: 'border-box', padding: '0 16px', width: '100%' } satisfies CSSProperties;
const messageRenderKey = (m: Message): string => m.renderKey ?? m.id;
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

export function shouldFollowLatestMessage(atBottom: boolean, localStatus?: Message['localStatus']): boolean {
  return atBottom || Boolean(localStatus);
}

export type ChatMessageListRoom = {
  loadOlder: () => void;
  messages: Message[];
  openAgentCard?: (id: string) => void;
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
  const shellRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VirtualListHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [visibleRange, setVisibleRange] = useState<{ endIndex: number; startIndex: number } | null>(null);
  const [outlineTop, setOutlineTop] = useState<string>('50%');
  const firstItemIndex = useFirstItemIndex(room.messages, messageRenderKey);
  const lastMessage = room.messages.at(-1);
  const lastMessageKey = lastMessage ? messageRenderKey(lastMessage) : undefined;
  const outlineItems = useMemo(
    () => workspaceMessageOutlineItems(room.messages, labels.timeUnavailable),
    [labels.timeUnavailable, room.messages]
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
    () => activeMessageOutlineIds(outlineItems, visibleRange, firstItemIndex, room.messages.length),
    [firstItemIndex, outlineItems, room.messages.length, visibleRange]
  );
  const scrollToOutlineItem = useCallback((id: string) => {
    listRef.current?.scrollToKey(id, { align: 'start', behavior: 'smooth' });
  }, []);
  const renderMessageItem = useCallback(
    (msg: Message) => (
      <div
        className="chat-room-message-row-wrap"
        style={MESSAGE_ROW_WRAP_STYLE}
      >
        <MessageRow
          Attachment={AttachmentChip}
          labels={labels}
          msg={msg}
          onAgentClick={room.openAgentCard}
        />
      </div>
    ),
    [labels, room.openAgentCard]
  );
  useLayoutEffect(() => {
    if (!lastMessageKey) return;
    if (shouldFollowLatestMessage(atBottom, lastMessage?.localStatus)) listRef.current?.scrollToBottom('auto');
  }, [atBottom, lastMessage?.localStatus, lastMessageKey]);
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
        onSelect={scrollToOutlineItem}
        renderPreview={(item) => <MarkdownWithMentions text={item.preview} />}
      />
      <VirtualList
        ariaLive="polite"
        bounce
        className="scwf-scroll"
        controlRef={listRef}
        firstItemIndex={firstItemIndex}
        footer={footer}
        getKey={messageRenderKey}
        header={HEADER_SPACER}
        items={room.messages}
        onAtBottomChange={setAtBottom}
        onRangeChange={setVisibleRange}
        onStartReached={room.loadOlder}
        renderItem={renderMessageItem}
        role="log"
        stickToBottom
        style={{ boxSizing: 'border-box', flex: 1, overflowX: 'hidden' }}
      />
      {atBottom ? null : (
        <button
          aria-label={labels.jumpLatest}
          className="workplace-action"
          onClick={() => listRef.current?.scrollToBottom('smooth')}
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
