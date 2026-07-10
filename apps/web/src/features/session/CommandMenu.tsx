'use client';

import type { SessionCommandMenuItem } from './command-menu';

import { PackageIcon, TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from '@monad/ui';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { renderableIconText } from '#/lib/renderable-icon-text';

const MENU_WIDTH = 288;
const DETAIL_WIDTH = 280;
const MENU_MAX_HEIGHT = 224;
const MENU_GAP = 10;
const VIEWPORT_PADDING = 12;

type CommandMenuLayout = {
  bottom: number;
  detailSide: 'left' | 'right';
  left: number;
  maxHeight: number;
};

export function CommandMenu({
  activeSkill,
  items,
  loading,
  onApply,
  onHover
}: {
  activeSkill: number;
  items: SessionCommandMenuItem[];
  loading: boolean;
  onApply: (item: SessionCommandMenuItem) => void;
  onHover: (index: number) => void;
}) {
  const skeletonRows = ['one', 'two', 'three', 'four'];
  const renderedItems = items.map((item, index) => {
    const previous = items[index - 1];
    const showSection = item.section && item.section !== previous?.section;
    return { index, item, showSection };
  });
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const [detailTop, setDetailTop] = useState(0);
  const [layout, setLayout] = useState<CommandMenuLayout>({
    bottom: VIEWPORT_PADDING,
    detailSide: 'right',
    left: VIEWPORT_PADDING,
    maxHeight: MENU_MAX_HEIGHT
  });
  const activeIndex = items.length > 0 ? Math.min(activeSkill, items.length - 1) : 0;
  const activeItem = items[activeIndex] ?? null;
  const detailSideClass = layout.detailSide === 'right' ? 'left-full ml-2' : 'right-full mr-2';
  const menuStyle = useMemo(
    () => ({
      bottom: layout.bottom,
      left: layout.left,
      maxHeight: layout.maxHeight,
      width: MENU_WIDTH
    }),
    [layout.bottom, layout.left, layout.maxHeight]
  );
  const updateDetailTop = useCallback(() => {
    if (!activeItem?.hint) {
      setDetailTop(0);
      return;
    }
    const menu = menuRef.current;
    const row = rowRefs.current.get(activeIndex);
    if (!menu || !row) return;
    const menuRect = menu.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const detailHeight = detailRef.current?.getBoundingClientRect().height ?? 0;
    const maxTop = Math.max(0, Math.min(layout.maxHeight, menuRect.height) - detailHeight);
    const nextTop = Math.round(Math.min(Math.max(0, rowRect.top - menuRect.top), maxTop));
    setDetailTop((current) => (current === nextTop ? current : nextTop));
  }, [activeIndex, activeItem?.hint, layout.maxHeight]);

  useLayoutEffect(() => {
    const updateLayout = () => {
      const anchor = anchorRef.current?.parentElement;
      if (!anchor || typeof window === 'undefined') return;
      const rect = caretAnchorRect(anchor) ?? anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = MENU_WIDTH;
      const aboveSpace = Math.max(1, rect.top - VIEWPORT_PADDING - MENU_GAP);
      const maxHeight = Math.min(MENU_MAX_HEIGHT, aboveSpace);
      const bottom = Math.max(VIEWPORT_PADDING, viewportHeight - rect.top + MENU_GAP);
      const idealLeft = Math.min(rect.left - 2, viewportWidth - width - VIEWPORT_PADDING);
      const left = Math.max(VIEWPORT_PADDING, idealLeft);
      const detailSide =
        viewportWidth - (left + width) >= DETAIL_WIDTH + MENU_GAP + VIEWPORT_PADDING ? 'right' : 'left';
      setLayout({ bottom, detailSide, left, maxHeight });
    };

    updateLayout();
    window.addEventListener('resize', updateLayout);
    window.addEventListener('scroll', updateLayout, true);
    return () => {
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('scroll', updateLayout, true);
    };
  }, []);

  useLayoutEffect(() => {
    rowRefs.current.get(activeIndex)?.scrollIntoView({ block: 'nearest' });
    const frame = window.requestAnimationFrame(updateDetailTop);
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, updateDetailTop]);

  useLayoutEffect(() => {
    updateDetailTop();
  }, [updateDetailTop]);

  return (
    <div ref={anchorRef}>
      <div
        className="glass-surface fixed z-50 overflow-visible rounded-[10px] border text-popover-foreground"
        ref={menuRef}
        style={{
          ...menuStyle,
          backdropFilter: 'blur(18px) saturate(1.15)',
          background: 'color-mix(in srgb, var(--popover) 84%, transparent)',
          borderColor: 'rgb(var(--borderColor-secondary) / 0.12)',
          boxShadow: '0 1px 0 rgb(var(--borderColor-secondary) / 0.05), 0 18px 42px -28px rgb(0 0 0 / 0.42)'
        }}
      >
        {activeItem?.hint ? (
          <div
            className={cn(
              'glass-surface absolute hidden w-[17.5rem] overflow-y-auto p-3 text-popover-foreground shadow-xl [scrollbar-width:none] md:block [&::-webkit-scrollbar]:hidden',
              detailSideClass
            )}
            ref={detailRef}
            style={{
              maxHeight: Math.max(80, layout.maxHeight - detailTop),
              scrollbarWidth: 'none',
              top: detailTop
            }}
          >
            <p className="text-muted-foreground text-xs leading-relaxed">{activeItem.hint}</p>
          </div>
        ) : null}
        <div
          className="overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onScroll={updateDetailTop}
          style={{
            maxHeight: layout.maxHeight,
            scrollbarWidth: 'none'
          }}
        >
          <div className="p-1">
            {loading
              ? skeletonRows.map((row) => (
                  <div
                    className="flex min-h-[25px] items-center gap-2 rounded-md px-2 py-[3px]"
                    key={`command-skeleton-${row}`}
                  >
                    <span className="h-3 min-w-0 flex-1 animate-pulse rounded bg-muted" />
                    <span className="h-4 w-12 animate-pulse rounded-full bg-muted" />
                  </div>
                ))
              : null}
            {renderedItems.map(({ index, item, showSection }) => (
              <div key={item.key}>
                {showSection ? (
                  <div className="px-2.5 pt-2 pb-1 font-medium text-[10.5px] text-muted-foreground leading-4">
                    {item.section}
                  </div>
                ) : null}
                <button
                  className={cn(
                    'flex min-h-[25px] w-full items-center gap-1.5 rounded-md px-2 py-[3px] text-left',
                    index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onApply(item);
                  }}
                  onMouseEnter={() => onHover(index)}
                  ref={(node) => {
                    if (node) rowRefs.current.set(index, node);
                    else rowRefs.current.delete(index);
                  }}
                  type="button"
                >
                  <CommandMenuItemIcon item={item} />
                  <HighlightedCommandLabel
                    label={item.label}
                    matches={item.labelMatches}
                  />
                  <span className="min-w-3 flex-1" />
                  <span className="shrink-0 opacity-75">
                    <SourceChip label={sourceLabel(item)} />
                  </span>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function caretAnchorRect(anchor: HTMLElement): DOMRect | null {
  const frame = anchor.closest<HTMLElement>('.chat-input-frame') ?? anchor;
  const editor = frame.querySelector<HTMLElement>('.composer-tiptap-input');
  const selection = document.getSelection();
  if (!editor || !selection?.rangeCount) return null;
  const node = selection.focusNode;
  if (!node || !editor.contains(node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)) {
    return null;
  }
  const range = selection.getRangeAt(0).cloneRange();
  const rect = firstUsableRect(range);
  if (rect) return rect;
  const editorRect = editor.getBoundingClientRect();
  return new DOMRect(editorRect.left + 8, editorRect.top + 8, 1, 22);
}

function firstUsableRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return rect;
}

function sourceLabel(item: SessionCommandMenuItem): string {
  return item.badge ?? item.typeBadge ?? item.section ?? 'Command';
}

function CommandMenuItemIcon({ item }: { item: SessionCommandMenuItem }) {
  const iconText = renderableIconText(item.icon);
  if (item.icon && (item.icon.startsWith('http://') || item.icon.startsWith('https://'))) {
    return (
      <span
        aria-hidden="true"
        className="size-4 shrink-0 rounded bg-center bg-cover"
        style={{ backgroundImage: `url(${item.icon})` }}
      />
    );
  }
  if (iconText) {
    return (
      <span
        aria-hidden="true"
        className="grid size-4 shrink-0 place-items-center text-[11px] text-muted-foreground"
      >
        {iconText}
      </span>
    );
  }
  return (
    <HugeiconsIcon
      aria-hidden="true"
      className="size-4 shrink-0 text-muted-foreground"
      icon={item.typeBadge === 'Skill' ? PackageIcon : TerminalIcon}
    />
  );
}

function SourceChip({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <span className="label-mono shrink-0 rounded-full border border-border/70 bg-muted/60 px-1.5 py-0.5 text-[9.5px] text-muted-foreground leading-[14px]">
      {label}
    </span>
  );
}

function HighlightedCommandLabel({ label, matches }: { label: string; matches?: number[] }) {
  if (!matches?.length) {
    return <span className="min-w-0 truncate font-medium font-mono text-[12.5px] leading-[18px]">{label}</span>;
  }
  const matchSet = new Set(matches);
  return (
    <span className="min-w-0 truncate font-medium font-mono text-[12.5px] leading-[18px]">
      {Array.from(label).map((char, index) => {
        const key = `${label.slice(0, index)}${char}`;
        return (
          <span
            className={matchSet.has(index) ? 'rounded-[2px] bg-foreground/15 text-foreground' : undefined}
            key={key}
          >
            {char}
          </span>
        );
      })}
    </span>
  );
}
