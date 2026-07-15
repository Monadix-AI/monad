import type { SessionCommandMenuItem } from './command-menu';

import { PackageIcon, TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from '@monad/ui';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { renderableIconText } from '#/lib/renderable-icon-text';

const MENU_WIDTH = 288;
const DETAIL_WIDTH = 280;
const MENU_GAP = 10;
const VIEWPORT_PADDING = 12;
export const COMMAND_MENU_ITEM_HEIGHT = 31;
export const COMMAND_MENU_EDGE_PADDING = 4;
const COMMAND_MENU_STICKY_HEADER_HEIGHT = COMMAND_MENU_EDGE_PADDING + COMMAND_MENU_ITEM_HEIGHT;
const MENU_VISIBLE_ITEM_COUNT = 7;
const MENU_MAX_HEIGHT = commandMenuPanelHeight(MENU_VISIBLE_ITEM_COUNT);
export const COMMAND_MENU_SURFACE_BACKGROUND = 'color-mix(in srgb, var(--popover) 84%, transparent)';

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
  const renderedRows = useMemo(() => commandMenuRows(items), [items]);
  const initialSection = renderedRows.find((row) => row.type === 'section')?.label ?? null;
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const [activeSection, setActiveSection] = useState<string | null>(initialSection);
  const [detailTop, setDetailTop] = useState(0);
  const [layout, setLayout] = useState<CommandMenuLayout>({
    bottom: VIEWPORT_PADDING,
    detailSide: 'right',
    left: VIEWPORT_PADDING,
    maxHeight: MENU_MAX_HEIGHT
  });
  const activeIndex = items.length > 0 ? Math.min(activeSkill, items.length - 1) : 0;
  const activeItem = items[activeIndex] ?? null;
  const activeDetailSource = activeItem ? commandMenuDetailSource(activeItem) : null;
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
  const updateActiveSection = useCallback(
    (scrollTop: number) => {
      const nextSection = commandMenuSectionAtScrollTop(renderedRows, scrollTop) ?? initialSection;
      setActiveSection((current) => (current === nextSection ? current : nextSection));
    },
    [initialSection, renderedRows]
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
      const maxHeight = commandMenuSnappedMaxHeight(aboveSpace);
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
    const scrollBox = menuRef.current?.querySelector<HTMLElement>('[data-command-menu-scroll]');
    const row = rowRefs.current.get(activeIndex);
    if (scrollBox && row) {
      const scrollRect = scrollBox.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      scrollBox.scrollTop = commandMenuScrollTop({
        current: scrollBox.scrollTop,
        itemBottom: scrollBox.scrollTop + rowRect.bottom - scrollRect.top,
        itemTop: scrollBox.scrollTop + rowRect.top - scrollRect.top,
        viewportHeight: scrollBox.clientHeight
      });
      updateActiveSection(scrollBox.scrollTop);
    }
    const frame = window.requestAnimationFrame(updateDetailTop);
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, updateActiveSection, updateDetailTop]);

  useLayoutEffect(() => {
    updateDetailTop();
  }, [updateDetailTop]);

  useLayoutEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  return (
    <div ref={anchorRef}>
      <div
        className="glass-surface fixed z-50 overflow-visible rounded-[10px] border text-popover-foreground"
        ref={menuRef}
        style={{
          ...menuStyle,
          backdropFilter: 'blur(18px) saturate(1.15)',
          background: COMMAND_MENU_SURFACE_BACKGROUND,
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
              backdropFilter: 'blur(18px) saturate(1.15)',
              background: COMMAND_MENU_SURFACE_BACKGROUND,
              maxHeight: Math.max(80, layout.maxHeight - detailTop),
              scrollbarWidth: 'none',
              top: detailTop
            }}
          >
            <p className="text-muted-foreground text-xs leading-relaxed">{activeItem.hint}</p>
            {activeDetailSource ? (
              <p className="mt-2 font-medium text-[10px] text-muted-foreground leading-4">{activeDetailSource}</p>
            ) : null}
          </div>
        ) : null}
        <div
          className="relative overflow-hidden rounded-[9px]"
          data-command-menu-viewport
        >
          {activeSection ? (
            <div
              className="pointer-events-none absolute right-0 left-0 z-30 flex items-center rounded-t-[9px] bg-popover px-3 font-medium text-[10.5px] text-muted-foreground leading-none"
              data-command-menu-sticky-header
              style={{
                height: COMMAND_MENU_STICKY_HEADER_HEIGHT,
                paddingTop: COMMAND_MENU_EDGE_PADDING,
                top: 0
              }}
            >
              {activeSection}
            </div>
          ) : null}
          <div
            className="overflow-y-auto overscroll-contain rounded-[9px] p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-command-menu-scroll
            onScroll={(event) => {
              updateDetailTop();
              updateActiveSection(event.currentTarget.scrollTop);
            }}
            style={{
              maxHeight: layout.maxHeight,
              scrollbarWidth: 'none'
            }}
          >
            <div>
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
              {renderedRows.map((row) =>
                row.type === 'section' ? (
                  <div
                    className="flex h-[31px] items-center px-2 font-medium text-[10.5px] text-muted-foreground leading-none"
                    key={row.key}
                  >
                    {row.label}
                  </div>
                ) : (
                  <button
                    className={cn(
                      'flex min-h-[25px] w-full items-center gap-1.5 rounded-md px-2 py-[3px] text-left',
                      row.index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                    )}
                    key={row.item.key}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onApply(row.item);
                    }}
                    onMouseEnter={() => onHover(row.index)}
                    ref={(node) => {
                      if (node) rowRefs.current.set(row.index, node);
                      else rowRefs.current.delete(row.index);
                    }}
                    type="button"
                  >
                    <CommandMenuItemIcon item={row.item} />
                    <HighlightedCommandLabel
                      label={row.item.label}
                      matches={row.item.labelMatches}
                    />
                    <span className="min-w-3 flex-1" />
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type CommandMenuRenderRow =
  | { key: string; label: string; type: 'section' }
  | { index: number; item: SessionCommandMenuItem; type: 'item' };

function commandMenuRows(items: SessionCommandMenuItem[]): CommandMenuRenderRow[] {
  const rows: CommandMenuRenderRow[] = [];
  items.forEach((item, index) => {
    const previous = items[index - 1];
    if (item.section && item.section !== previous?.section) {
      rows.push({ key: `section:${item.section}`, label: item.section, type: 'section' });
    }
    rows.push({ index, item, type: 'item' });
  });
  return rows;
}

function commandMenuSectionAtScrollTop(rows: CommandMenuRenderRow[], scrollTop: number): string | null {
  let currentSection: string | null = null;
  let offset = 0;
  for (const row of rows) {
    if (row.type === 'section') {
      if (offset <= scrollTop) currentSection = row.label;
    }
    offset += COMMAND_MENU_ITEM_HEIGHT;
    if (offset > scrollTop) break;
  }
  return currentSection;
}

export function commandMenuScrollTop({
  current,
  itemBottom,
  itemTop,
  viewportHeight
}: {
  current: number;
  itemBottom: number;
  itemTop: number;
  viewportHeight: number;
}): number {
  const visibleTop = current + COMMAND_MENU_STICKY_HEADER_HEIGHT;
  const visibleBottom = current + viewportHeight - COMMAND_MENU_EDGE_PADDING;
  if (itemTop < visibleTop) return Math.max(0, current - COMMAND_MENU_ITEM_HEIGHT);
  if (itemBottom > visibleBottom) return current + COMMAND_MENU_ITEM_HEIGHT;
  return current;
}

export function commandMenuPanelHeight(itemCount: number): number {
  return COMMAND_MENU_EDGE_PADDING * 2 + COMMAND_MENU_ITEM_HEIGHT * itemCount;
}

export function commandMenuSnappedMaxHeight(availableHeight: number): number {
  const visibleItems = Math.max(
    1,
    Math.min(
      MENU_VISIBLE_ITEM_COUNT,
      Math.floor((availableHeight - COMMAND_MENU_EDGE_PADDING * 2) / COMMAND_MENU_ITEM_HEIGHT)
    )
  );
  return commandMenuPanelHeight(visibleItems);
}

export function commandMenuDetailSource(item: SessionCommandMenuItem): string | null {
  if (!item.badgeTitle) return null;
  if (item.badgeTitle === 'Global') return 'From: Global';
  if (item.badgeTitle.startsWith('Agent:')) return `From ${item.badgeTitle}`;
  if (item.badgeTitle.startsWith('Atom Pack:')) return `From ${item.badgeTitle}`;
  return `From: ${item.badgeTitle}`;
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
