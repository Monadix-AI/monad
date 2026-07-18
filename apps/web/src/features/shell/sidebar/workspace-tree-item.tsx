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
import {
  SIDEBAR_ITEM_LABEL_CLASS,
  SIDEBAR_SHORTCUT_BADGE_OVERLAY_CLASS,
  sidebarIconButtonClass,
  sidebarItemContainerClass
} from './nav-item';
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
  title?: string;
  trailingActions?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const sessionActionsRef = useRef<HTMLDivElement | null>(null);
  const [sessionActionWidth, setSessionActionWidth] = useState(0);

  useEffect(() => {
    const element = sessionActionsRef.current;
    if (!sidebarSession || !element) return;
    const updateWidth = () => setSessionActionWidth(element.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sidebarSession]);

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
    <div
      className={sidebarItemContainerClass({ active, className: 'gap-0.5' })}
      data-sidebar-tree-item="true"
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
                  actionWidth={sessionActionWidth}
                  disabled={editing || menuOpen}
                  label={label}
                />
              ) : (
                children
              )}
            </SidebarEditableTitle>
          </span>
          {sidebarSession ? <SidebarSessionShortcutChip /> : null}
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
                  actionWidth={sessionActionWidth}
                  disabled={editing || menuOpen}
                  label={label}
                />
              ) : (
                children
              )}
            </SidebarEditableTitle>
          </span>
          {sidebarSession ? <SidebarSessionShortcutChip /> : null}
        </button>
      )}
      {sidebarSession ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 right-1 z-10 flex items-center gap-0.5 [@media_(hover:none),_(pointer:coarse)]:pointer-events-auto',
            editing && 'hidden'
          )}
          data-sidebar-session-actions="true"
          ref={sessionActionsRef}
        >
          {rowActions}
        </div>
      ) : (
        rowActions
      )}
    </div>
  );
}

export function SidebarSessionShortcutChip() {
  return (
    <ShortcutChip
      aria-hidden="true"
      className={cn(SIDEBAR_SHORTCUT_BADGE_OVERLAY_CLASS, 'transition-opacity')}
      data-sidebar-shortcut-chip="true"
      hidden
    />
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
