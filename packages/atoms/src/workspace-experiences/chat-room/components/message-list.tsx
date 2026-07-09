import type { NativeAgentDeliveryId } from '@monad/protocol';
import type { Message, TypingIndicator } from '../../experience/types.ts';
import type { MessageRowLabels } from './message-row.tsx';

import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { useFirstItemIndex } from '@monad/ui/hooks/use-first-item-index';
import {
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';

import { AttachmentChip } from './attachment-chip.tsx';
import { MarkdownWithMentions, MessageRow } from './message-row.tsx';
import { TypingRow } from './transcript-skeleton.tsx';

const HEADER_SPACER = <div style={{ height: 24 }} />;
const COMPOSER_CLEARANCE = 'calc(var(--chat-room-composer-clearance, 132px) + 24px)';
const MESSAGE_ROW_WRAP_STYLE = { boxSizing: 'border-box', padding: '0 16px', width: '100%' } satisfies CSSProperties;
const messageRenderKey = (m: Message): string => m.renderKey ?? m.id;
const OUTLINE_ITEM_HEIGHT = 8;
const OUTLINE_ITEM_GAP = 1;
const OUTLINE_PADDING_TOP = 6;
const OUTLINE_SIGMA = 22;
const OUTLINE_PREVIEW_GUTTER = 32;
const MESSAGE_OUTLINE_STYLE = `
  .chat-message-list-shell {
    position: relative;
  }

  .chat-message-outline {
    position: absolute;
    top: var(--chat-message-outline-top, 50%);
    left: 6px;
    z-index: 12;
    width: 44px;
    height: min(52%, calc(100% - 64px));
    opacity: 0.42;
    pointer-events: auto;
    transition: opacity 140ms ease;
    transform: translateY(-50%);
  }

  .chat-message-outline[data-interacting="true"] {
    opacity: 1;
  }

  .chat-message-outline__scroll {
    display: flex;
    min-height: 100%;
    max-height: 100%;
    flex-direction: column;
    gap: 1px;
    align-items: flex-start;
    overflow-y: auto;
    padding: calc(6px + var(--outline-center-offset, 0px)) 6px 8px 8px;
    scrollbar-width: none;
  }

  .chat-message-outline__scroll::-webkit-scrollbar {
    display: none;
  }

  .chat-message-outline__item {
    position: relative;
    display: flex;
    flex: 0 0 8px;
    width: 30px;
    height: 8px;
    align-items: center;
    justify-content: flex-start;
    border: 0;
    background: transparent;
    padding: 0;
  }

  .chat-message-outline__mark {
    display: block;
    width: var(--outline-mark-width, 6px);
    height: var(--outline-mark-height, 2px);
    border-radius: 999px;
    background: color-mix(in srgb, var(--foreground) var(--outline-mark-ink, 35%), transparent);
    opacity: var(--outline-mark-opacity, 0.55);
    transition:
      width 105ms cubic-bezier(0.2, 1.45, 0.38, 1),
      opacity 90ms ease-out;
  }

  .chat-message-outline__item:focus-visible {
    outline: none;
  }

  .chat-message-outline__item:focus-visible .chat-message-outline__mark {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 24%, transparent);
  }

  .chat-message-outline__preview {
    position: absolute;
    left: 46px;
    width: min(34vw, 320px);
    transform: translateY(-50%);
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--popover, var(--background));
    box-shadow: 0 12px 24px -20px rgb(0 0 0 / 0.5);
    color: var(--foreground);
    font-family: var(--font-sans, system-ui);
    line-height: 1.45;
    padding: 10px 12px;
    pointer-events: none;
    text-align: left;
  }

  .chat-message-outline__preview-time {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted-foreground);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .chat-message-outline__preview-body {
    margin-top: 6px;
    max-height: 4.4em;
    overflow: hidden;
    color: var(--foreground);
    font-size: 13px;
    line-height: 1.45;
    pointer-events: none;
  }

  .chat-message-outline__preview-body .workplace-message-markdown {
    display: block;
  }

  .chat-message-outline__preview-body .workplace-message-markdown :where(p, ul, ol, blockquote, pre) {
    margin-block: 0;
  }

  @media (max-width: 760px) {
    .chat-message-outline {
      display: none;
    }
  }
`;

type MessageOutlineItem = {
  id: string;
  index: number;
  label: string;
  preview: string;
  time: string;
};

function formatRelativeOutlineTime(message: Message): string {
  if (!message.orderKey) return 'Time unavailable';
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function gaussian(distance: number, sigma = OUTLINE_SIGMA): number {
  return Math.exp(-(distance * distance) / (2 * sigma * sigma));
}

export function shouldFollowLatestMessage(atBottom: boolean, localStatus?: Message['localStatus']): boolean {
  return atBottom || Boolean(localStatus);
}

export type ChatMessageListRoom = {
  followExternalAgentSession?: (id: string, deliveryId?: NativeAgentDeliveryId) => void;
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
  labels: MessageRowLabels & { jumpLatest: string };
}): React.ReactElement {
  const shellRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VirtualListHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [visibleRange, setVisibleRange] = useState<{ endIndex: number; startIndex: number } | null>(null);
  const [outlineTop, setOutlineTop] = useState<string>('50%');
  const firstItemIndex = useFirstItemIndex(room.messages, messageRenderKey);
  const lastMessage = room.messages.at(-1);
  const lastMessageKey = lastMessage ? messageRenderKey(lastMessage) : undefined;
  const outlineItems = useMemo<MessageOutlineItem[]>(
    () =>
      room.messages.flatMap((message, index) => {
        if (message.kind !== 'human') return [];
        const preview = message.text.trim().replace(/\s+/g, ' ');
        return [
          {
            id: message.id,
            index,
            label: preview || `Message ${index + 1}`,
            preview: message.text,
            time: formatRelativeOutlineTime(message)
          }
        ];
      }),
    [room.messages]
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
  const activeOutlineIds = useMemo(() => {
    if (outlineItems.length === 0) return new Set<string>();
    if (!visibleRange) return new Set([outlineItems.at(-1)?.id].filter((id): id is string => Boolean(id)));
    const offset = firstItemIndex ?? 0;
    const start = Math.max(0, visibleRange.startIndex - offset);
    const end = Math.min(room.messages.length - 1, visibleRange.endIndex - offset);
    return new Set(
      outlineItems
        .filter((item, index) => {
          const next = outlineItems[index + 1];
          const sectionStart = item.index;
          const sectionEnd = (next?.index ?? room.messages.length) - 1;
          return sectionStart <= end && sectionEnd >= start;
        })
        .map((item) => item.id)
    );
  }, [firstItemIndex, outlineItems, room.messages.length, visibleRange]);
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
          onFollowExternalAgentSession={room.followExternalAgentSession}
        />
      </div>
    ),
    [labels, room.followExternalAgentSession, room.openAgentCard]
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
      className={
        outlineItems.length > 0 ? 'chat-message-list-has-outline chat-message-list-shell' : 'chat-message-list-shell'
      }
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
      <style>{MESSAGE_OUTLINE_STYLE}</style>
      <ChatMessageOutline
        activeIds={activeOutlineIds}
        items={outlineItems}
        onSelect={scrollToOutlineItem}
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

function ChatMessageOutline({
  activeIds,
  items,
  onSelect
}: {
  activeIds: ReadonlySet<string>;
  items: MessageOutlineItem[];
  onSelect: (id: string) => void;
}): React.ReactElement | null {
  const outlineRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pointerY, setPointerY] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [outlineScrollable, setOutlineScrollable] = useState(false);
  const [outlineCenterOffset, setOutlineCenterOffset] = useState(0);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const updateGeometry = () => {
      const contentHeight =
        items.length * OUTLINE_ITEM_HEIGHT + Math.max(0, items.length - 1) * OUTLINE_ITEM_GAP + OUTLINE_PADDING_TOP + 8;
      const scrollable = scroll.scrollHeight > scroll.clientHeight + 1 || contentHeight > scroll.clientHeight + 1;
      setOutlineScrollable(scrollable);
      setOutlineCenterOffset(scrollable ? 0 : Math.max(0, (scroll.clientHeight - contentHeight) / 2));
    };
    updateGeometry();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateGeometry);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [items.length]);
  if (items.length === 0) return null;

  const itemCenter = (index: number) =>
    outlineCenterOffset +
    OUTLINE_PADDING_TOP +
    index * (OUTLINE_ITEM_HEIGHT + OUTLINE_ITEM_GAP) +
    OUTLINE_ITEM_HEIGHT / 2 -
    scrollTop;
  const hoveredItem = hoveredId ? items.find((item) => item.id === hoveredId) : undefined;
  const hoveredIndex = hoveredItem ? items.indexOf(hoveredItem) : -1;
  const previewTop =
    hoveredIndex >= 0
      ? clamp(
          itemCenter(hoveredIndex),
          OUTLINE_PREVIEW_GUTTER,
          Math.max(OUTLINE_PREVIEW_GUTTER, (outlineRef.current?.clientHeight ?? 0) - OUTLINE_PREVIEW_GUTTER)
        )
      : 0;

  const updatePointerY = (event: MouseEvent<HTMLElement>) => {
    const outlineRect = event.currentTarget.getBoundingClientRect();
    setPointerY(event.clientY - outlineRect.top);
  };
  const showPreview = (
    event: FocusEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>,
    item: MessageOutlineItem
  ) => {
    const itemRect = event.currentTarget.getBoundingClientRect();
    const outlineRect = event.currentTarget.closest('.chat-message-outline')?.getBoundingClientRect();
    setPointerY(outlineRect ? itemRect.top - outlineRect.top + itemRect.height / 2 : itemRect.height / 2);
    setHoveredId(item.id);
  };
  const clearInteraction = () => {
    setPointerY(null);
    setHoveredId(null);
  };

  return (
    <nav
      aria-label="User message outline"
      className="chat-message-outline"
      data-interacting={pointerY !== null}
      onMouseLeave={clearInteraction}
      onMouseMove={updatePointerY}
      ref={outlineRef}
    >
      <div
        className="chat-message-outline__scroll"
        data-scrollable={outlineScrollable}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        ref={scrollRef}
        style={{ '--outline-center-offset': `${outlineCenterOffset}px` } as CSSProperties}
      >
        {items.map((item, index) => {
          const active = activeIds.has(item.id);
          const distance = pointerY === null ? Number.POSITIVE_INFINITY : itemCenter(index) - pointerY;
          const influence = pointerY === null ? 0 : gaussian(distance);
          const markWidth = Math.round(6 + influence * 14 + (active ? 2 : 0));
          const markHeight = 2;
          const opacity = active ? Math.max(0.78, 0.45 + influence * 0.55) : 0.34 + influence * 0.62;
          const ink = Math.round(active ? 92 : 36 + influence * 56);
          return (
            <button
              aria-current={active ? 'location' : undefined}
              aria-label={`Go to ${item.label}`}
              className="chat-message-outline__item"
              data-active={active}
              key={item.id}
              onBlur={() => {
                setPointerY(null);
                setHoveredId(null);
              }}
              onClick={() => onSelect(item.id)}
              onFocus={(event) => showPreview(event, item)}
              onMouseEnter={(event) => showPreview(event, item)}
              style={
                {
                  '--outline-mark-height': `${markHeight}px`,
                  '--outline-mark-ink': `${ink}%`,
                  '--outline-mark-opacity': opacity,
                  '--outline-mark-width': `${markWidth}px`
                } as CSSProperties
              }
              type="button"
            >
              <span className="chat-message-outline__mark" />
            </button>
          );
        })}
      </div>
      {hoveredItem ? (
        <div
          className="chat-message-outline__preview"
          style={{ top: previewTop }}
        >
          <span className="chat-message-outline__preview-time">{hoveredItem.time}</span>
          <div className="chat-message-outline__preview-body">
            <MarkdownWithMentions text={hoveredItem.preview} />
          </div>
        </div>
      ) : null}
    </nav>
  );
}
