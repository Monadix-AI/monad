import type { MouseEvent, ReactNode } from 'react';

import { MoreHorizontalIcon, PencilEdit01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  ShortcutChip
} from '@monad/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ShellLink } from '#/components/ShellLink';
import { SIDEBAR_ITEM_LABEL_CLASS, sidebarIconButtonClass, sidebarItemContainerClass } from './nav-item';
import { SidebarSessionTitle } from './sidebar-session-title';

export type TreeItemMenuAction = {
  icon: typeof PencilEdit01Icon;
  kind?: 'rename';
  label: string;
  onSelect?: () => void;
  shortcut?: string;
  variant?: 'default' | 'destructive';
};

type ResolvedTreeItemMenuAction = TreeItemMenuAction & {
  onSelect: () => void;
};

export function WorkspaceTreeItem({
  active,
  actions,
  ariaExpanded,
  children,
  className,
  contentClassName,
  editableOnDoubleClick,
  href,
  icon,
  label,
  menuActions,
  menuLabel,
  onOpen,
  onRename,
  sidebarSession,
  sessionShortcut,
  title = label,
  trailingActions
}: {
  active: boolean;
  actions?: ReactNode;
  ariaExpanded?: boolean;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  editableOnDoubleClick?: boolean;
  href?: string;
  icon?: ReactNode;
  label: string;
  menuActions?: TreeItemMenuAction[];
  menuLabel?: string;
  onOpen: () => void;
  onRename?: (title: string) => void | Promise<void>;
  sidebarSession?: boolean;
  sessionShortcut?: { modifierLabel: string; value: number; visible: boolean };
  title?: string;
  trailingActions?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [focusedWithin, setFocusedWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pointerWithin, setPointerWithin] = useState(false);
  const sessionEndOverlayRef = useRef<HTMLDivElement | null>(null);
  const [sessionEndOverlayWidth, setSessionEndOverlayWidth] = useState(0);
  const actionsVisible = pointerWithin || focusedWithin || menuOpen;
  const shortcutVisible = sessionShortcut?.visible === true && !actionsVisible;
  const overlayVisible = (actionsVisible || shortcutVisible) && !editing;
  const sessionSurfaceClass = active
    ? '[--sidebar-session-surface:var(--sidebar-selected)] hover:[--sidebar-session-surface:var(--sidebar-selected-hover)]'
    : '[--sidebar-session-surface:transparent] hover:[--sidebar-session-surface:var(--sidebar-accent)]';

  useEffect(() => {
    if (!sidebarSession || !overlayVisible) {
      setSessionEndOverlayWidth((current) => (current === 0 ? current : 0));
      return;
    }
    const element = sessionEndOverlayRef.current;
    if (!element) return;
    const updateWidth = () => setSessionEndOverlayWidth(element.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [overlayVisible, sidebarSession]);

  const startEditing = useCallback(() => {
    if (!onRename) return;
    setEditing(true);
  }, [onRename]);

  const resolvedMenuActions = useMemo(() => resolveMenuActions(menuActions, startEditing), [menuActions, startEditing]);
  const openItem = useCallback(() => {
    if (!editing) onOpen();
  }, [editing, onOpen]);
  const openContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!resolvedMenuActions?.length) return;
      event.preventDefault();
      setMenuOpen(true);
    },
    [resolvedMenuActions]
  );
  const handleDoubleClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (active || editableOnDoubleClick) startEditing();
    },
    [active, editableOnDoubleClick, startEditing]
  );

  const rowActions = (
    <>
      {actions}
      {resolvedMenuActions?.length ? (
        <SidebarItemMenu
          actions={resolvedMenuActions}
          label={menuLabel ?? title}
          onOpenChange={setMenuOpen}
          open={menuOpen}
        />
      ) : null}
      {trailingActions}
    </>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper tracks hover/focus state for an absolutely positioned sibling overlay; the actual row control remains the child link/button.
    <div
      className={sidebarItemContainerClass({ active, className: cn('gap-0.5', sessionSurfaceClass) })}
      data-sidebar-actions-visible={actionsVisible ? 'true' : undefined}
      data-sidebar-tree-item="true"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedWithin(false);
      }}
      onFocus={() => setFocusedWithin(true)}
      onPointerEnter={() => setPointerWithin(true)}
      onPointerLeave={() => setPointerWithin(false)}
    >
      {href ? (
        <ShellLink
          aria-current={active ? 'page' : undefined}
          aria-expanded={ariaExpanded}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 text-left text-inherit visited:text-inherit',
            className
          )}
          data-sidebar-session-row={sidebarSession || undefined}
          href={href}
          onClick={(event) => {
            event.preventDefault();
            openItem();
          }}
          onContextMenu={openContextMenu}
          onDoubleClick={handleDoubleClick}
          title={title}
        >
          {icon}
          <span className={cn(sidebarSession ? 'min-w-0 flex-1' : SIDEBAR_ITEM_LABEL_CLASS, contentClassName)}>
            <SidebarEditableTitle
              editing={editing}
              label={label}
              onCommit={onRename}
              onEditingChange={setEditing}
              title={title}
            >
              {sidebarSession ? (
                <SidebarSessionTitle
                  actionWidth={overlayVisible ? sessionEndOverlayWidth : 0}
                  disabled={editing || menuOpen}
                  label={label}
                />
              ) : (
                children
              )}
            </SidebarEditableTitle>
          </span>
        </ShellLink>
      ) : (
        <button
          aria-expanded={ariaExpanded}
          className={cn('flex min-w-0 flex-1 items-center gap-2 text-left text-inherit', className)}
          data-sidebar-session-row={sidebarSession || undefined}
          onClick={openItem}
          onContextMenu={openContextMenu}
          onDoubleClick={handleDoubleClick}
          title={title}
          type="button"
        >
          {icon}
          <span className={cn(sidebarSession ? 'min-w-0 flex-1' : SIDEBAR_ITEM_LABEL_CLASS, contentClassName)}>
            <SidebarEditableTitle
              editing={editing}
              label={label}
              onCommit={onRename}
              onEditingChange={setEditing}
              title={title}
            >
              {sidebarSession ? (
                <SidebarSessionTitle
                  actionWidth={overlayVisible ? sessionEndOverlayWidth : 0}
                  disabled={editing || menuOpen}
                  label={label}
                />
              ) : (
                children
              )}
            </SidebarEditableTitle>
          </span>
        </button>
      )}
      {sidebarSession ? (
        overlayVisible ? (
          <div
            className="pointer-events-none absolute inset-y-0 right-1 z-10 flex items-stretch [@media_(hover:none),_(pointer:coarse)]:pointer-events-auto"
            data-sidebar-session-end-overlay="true"
            ref={sessionEndOverlayRef}
          >
            <div
              aria-hidden="true"
              className="w-6 shrink-0 rounded-l-(--radius-md) bg-linear-to-r from-transparent to-[var(--sidebar-session-surface)]"
              data-sidebar-session-end-overlay-fade="true"
            />
            <div
              className="flex items-center gap-0.5 rounded-r-(--radius-md) bg-[var(--sidebar-session-surface)]"
              data-sidebar-session-actions="true"
            >
              {shortcutVisible && sessionShortcut ? (
                <SidebarSessionShortcutChip
                  modifierLabel={sessionShortcut.modifierLabel}
                  value={sessionShortcut.value}
                />
              ) : (
                rowActions
              )}
            </div>
          </div>
        ) : null
      ) : (
        rowActions
      )}
    </div>
  );
}

export function SidebarSessionShortcutChip({
  modifierLabel = '',
  value = ''
}: {
  modifierLabel?: string;
  value?: number | string;
}) {
  return (
    <ShortcutChip
      aria-hidden="true"
      className="pointer-events-none"
      data-sidebar-shortcut-chip="true"
    >
      {modifierLabel}
      {value}
    </ShortcutChip>
  );
}

function SidebarEditableTitle({
  children,
  editing,
  label,
  onCommit,
  onEditingChange,
  title
}: {
  children?: ReactNode;
  editing: boolean;
  label: string;
  onCommit?: (title: string) => void | Promise<void>;
  onEditingChange: (editing: boolean) => void;
  title: string;
}) {
  const [draftTitle, setDraftTitle] = useState(label);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraftTitle(label);
  }, [editing, label]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const commitRename = () => {
    const nextTitle = draftTitle.trim();
    onEditingChange(false);
    if (!nextTitle || nextTitle === label) return;
    void onCommit?.(nextTitle);
  };

  if (!editing) return children;

  return (
    <input
      aria-label={title}
      className="block h-auto w-full border-0 bg-transparent p-0 text-inherit outline-none [font:inherit] [line-height:inherit]"
      onBlur={commitRename}
      onChange={(event) => setDraftTitle(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commitRename();
        if (event.key === 'Escape') {
          onEditingChange(false);
          setDraftTitle(label);
        }
      }}
      ref={inputRef}
      value={draftTitle}
    />
  );
}

function resolveMenuActions(
  actions: TreeItemMenuAction[] | undefined,
  startEditing: () => void
): ResolvedTreeItemMenuAction[] | undefined {
  return actions?.map((action) => {
    if (action.kind === 'rename') {
      return {
        ...action,
        onSelect: startEditing
      };
    }
    return {
      ...action,
      onSelect: action.onSelect ?? (() => undefined)
    };
  });
}

function SidebarItemMenu({
  actions,
  label,
  onOpenChange,
  open
}: {
  actions: ResolvedTreeItemMenuAction[];
  label: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <DropdownMenu
      onOpenChange={onOpenChange}
      open={open}
    >
      <DropdownMenuTrigger asChild>
        <button
          aria-label={label}
          className={cn(sidebarIconButtonClass(), open && 'opacity-100')}
          type="button"
        >
          <HugeiconsIcon
            className="size-3.5"
            icon={MoreHorizontalIcon}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-40"
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
          const action = actions.find((item) => item.shortcut?.toLowerCase() === event.key.toLowerCase());
          if (!action) return;
          event.preventDefault();
          onOpenChange(false);
          action.onSelect();
        }}
      >
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            onSelect={action.onSelect}
            variant={action.variant}
          >
            <HugeiconsIcon icon={action.icon} />
            <span>{action.label}</span>
            {action.shortcut ? <DropdownMenuShortcut>{action.shortcut}</DropdownMenuShortcut> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
