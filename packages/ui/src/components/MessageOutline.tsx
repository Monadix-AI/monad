import type { CSSProperties, FocusEvent, MouseEvent, ReactNode } from 'react';

import { useEffect, useRef, useState } from 'react';

const ITEM_HEIGHT = 8;
const ITEM_GAP = 1;
const PADDING_TOP = 6;
const PREVIEW_GUTTER = 32;
const SIGMA = 22;

export type MessageOutlineItem = {
  id: string;
  index: number;
  label: string;
  time: string;
};

export type MessageOutlineProps<T extends MessageOutlineItem = MessageOutlineItem> = {
  activeIds: ReadonlySet<string>;
  ariaLabel: string;
  goToLabel: (item: T) => string;
  items: T[];
  onSelect: (id: string) => void;
  renderPreview: (item: T) => ReactNode;
};

export function activeMessageOutlineIds(
  items: MessageOutlineItem[],
  visibleRange: { endIndex: number; startIndex: number } | null,
  totalItemCount: number
): Set<string> {
  if (items.length === 0) return new Set();
  if (!visibleRange) return new Set([items.at(-1)?.id].filter((id): id is string => Boolean(id)));
  const start = Math.max(0, visibleRange.startIndex);
  const end = Math.min(totalItemCount - 1, visibleRange.endIndex);
  return new Set(
    items
      .filter((item, index) => {
        const next = items[index + 1];
        const sectionEnd = (next?.index ?? totalItemCount) - 1;
        return item.index <= end && sectionEnd >= start;
      })
      .map((item) => item.id)
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function gaussian(distance: number): number {
  return Math.exp(-(distance * distance) / (2 * SIGMA * SIGMA));
}

export function MessageOutline<T extends MessageOutlineItem>({
  activeIds,
  ariaLabel,
  goToLabel,
  items,
  onSelect,
  renderPreview
}: MessageOutlineProps<T>): ReactNode {
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
      const contentHeight = items.length * ITEM_HEIGHT + Math.max(0, items.length - 1) * ITEM_GAP + PADDING_TOP + 8;
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

  if (items.length <= 5) return null;

  const itemCenter = (index: number) =>
    outlineCenterOffset + PADDING_TOP + index * (ITEM_HEIGHT + ITEM_GAP) + ITEM_HEIGHT / 2 - scrollTop;
  const hoveredItem = hoveredId ? items.find((item) => item.id === hoveredId) : undefined;
  const hoveredIndex = hoveredItem ? items.indexOf(hoveredItem) : -1;
  const previewTop =
    hoveredIndex >= 0
      ? clamp(
          itemCenter(hoveredIndex),
          PREVIEW_GUTTER,
          Math.max(PREVIEW_GUTTER, (outlineRef.current?.clientHeight ?? 0) - PREVIEW_GUTTER)
        )
      : 0;

  const showPreview = (event: FocusEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>, item: T) => {
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
      aria-label={ariaLabel}
      className="chat-message-outline"
      data-interacting={pointerY !== null}
      onMouseLeave={clearInteraction}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPointerY(event.clientY - rect.top);
      }}
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
          const opacity = active ? Math.max(0.78, 0.45 + influence * 0.55) : 0.34 + influence * 0.62;
          const ink = Math.round(active ? 92 : 36 + influence * 56);
          return (
            <button
              aria-current={active ? 'location' : undefined}
              aria-label={goToLabel(item)}
              className="chat-message-outline__item"
              data-active={active}
              key={item.id}
              onBlur={clearInteraction}
              onClick={() => onSelect(item.id)}
              onFocus={(event) => showPreview(event, item)}
              onMouseEnter={(event) => showPreview(event, item)}
              style={
                {
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
          <div className="chat-message-outline__preview-body">{renderPreview(hoveredItem)}</div>
        </div>
      ) : null}
    </nav>
  );
}
