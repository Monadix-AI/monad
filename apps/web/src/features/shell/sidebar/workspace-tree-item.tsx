import type { MouseEvent, ReactNode } from 'react';

import { MoreHorizontalIcon, PencilEdit01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  ShortcutChip
} from '@monad/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ShellLink } from '#/components/ShellLink';
import { SIDEBAR_ITEM_LABEL_CLASS, sidebarIconButtonClass, sidebarItemContainerClass } from './nav-item';
import { SidebarItemEndcap } from './sidebar-item-endcap';
import { SidebarSessionTitle } from './sidebar-session-title';

export type TreeItemMenuAction = {
  checked?: boolean;
  icon: typeof PencilEdit01Icon;
  items?: TreeItemMenuAction[];
  kind?: 'rename';
  label: string;
  onSelect?: () => void;
  shortcut?: string;
  value?: string;
  variant?: 'default' | 'destructive';
};

type ResolvedTreeItemMenuAction = Omit<TreeItemMenuAction, 'items' | 'onSelect'> & {
  items?: ResolvedTreeItemMenuAction[];
  onSelect: () => void;
};

export function sidebarActionsVisible(input: { focusVisibleWithin: boolean; menuOpen: boolean }): boolean {
  return input.focusVisibleWithin || input.menuOpen;
}

export type SidebarEndcapSlot = 'shortcut' | 'actions' | 'status' | null;

export function resolveSidebarEndcapSlot(input: {
  actionsVisible: boolean;
  hasStatus: boolean;
  menuOpen?: boolean;
  shortcutVisible: boolean;
}): SidebarEndcapSlot {
  if (input.menuOpen) return 'actions';
  if (input.shortcutVisible) return 'shortcut';
  if (input.actionsVisible) return 'actions';
  if (input.hasStatus) return 'status';
  return null;
}

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
  status,
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
  status?: ReactNode;
  title?: string;
  trailingActions?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [focusVisibleWithin, setFocusVisibleWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const sessionEndOverlayRef = useRef<HTMLDivElement | null>(null);
  const [sessionEndOverlayWidth, setSessionEndOverlayWidth] = useState(0);
  const actionsVisible = sidebarActionsVisible({ focusVisibleWithin, menuOpen });
  const shortcutVisible = sessionShortcut?.visible === true;
  const endcapSlot = resolveSidebarEndcapSlot({
    actionsVisible,
    hasStatus: Boolean(status),
    menuOpen,
    shortcutVisible
  });

  useEffect(() => {
    if (!sidebarSession || editing) {
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
  }, [editing, sidebarSession]);

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
      className={sidebarItemContainerClass({ active, className: 'group/sidebar-tree-item gap-0.5' })}
      data-sidebar-actions-visible={actionsVisible ? 'true' : undefined}
      data-sidebar-tree-item="true"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusVisibleWithin(false);
      }}
      onFocus={(event) =>
        setFocusVisibleWithin(event.target instanceof Element && event.target.matches(':focus-visible'))
      }
      onPointerDown={() => setFocusVisibleWithin(false)}
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
                  actionWidth={editing ? 0 : sessionEndOverlayWidth}
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
                  actionWidth={editing ? 0 : sessionEndOverlayWidth}
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
      {editing ? null : (
        <SidebarItemEndcap
          className={cn(
            !shortcutVisible && 'group-hover/sidebar-tree-item:flex',
            !shortcutVisible && '[@media_(hover:none),_(pointer:coarse)]:pointer-events-auto',
            endcapSlot === null && 'hidden [@media_(hover:none),_(pointer:coarse)]:flex'
          )}
          ref={sessionEndOverlayRef}
        >
          {sessionShortcut?.visible ? (
            <span
              className={cn('items-center justify-end', endcapSlot === 'shortcut' ? 'flex' : 'hidden')}
              data-sidebar-endcap-slot="shortcut"
            >
              <SidebarSessionShortcutChip
                modifierLabel={sessionShortcut.modifierLabel}
                value={sessionShortcut.value}
              />
            </span>
          ) : null}
          <span
            className={cn(
              'items-center justify-end gap-0.5',
              endcapSlot === 'actions' ? 'flex' : 'hidden',
              !shortcutVisible && 'group-hover/sidebar-tree-item:flex',
              !shortcutVisible && '[@media_(hover:none),_(pointer:coarse)]:flex'
            )}
            data-sidebar-endcap-slot="actions"
            data-sidebar-session-actions="true"
          >
            {rowActions}
          </span>
          {status ? (
            <span
              className={cn(
                'items-center justify-end',
                endcapSlot === 'status' ? 'flex' : 'hidden',
                !shortcutVisible && 'group-hover/sidebar-tree-item:hidden',
                '[@media_(hover:none),_(pointer:coarse)]:hidden'
              )}
              data-sidebar-endcap-slot="status"
            >
              {status}
            </span>
          ) : null}
        </SidebarItemEndcap>
      )}
    </div>
  );
}

function SidebarSessionShortcutChip({
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
    const items = resolveMenuActions(action.items, startEditing);
    if (action.kind === 'rename') {
      return {
        ...action,
        items,
        onSelect: startEditing
      };
    }
    return {
      ...action,
      items,
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
          <SidebarItemMenuAction
            action={action}
            key={action.value ?? action.label}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarItemMenuAction({ action }: { action: ResolvedTreeItemMenuAction }): React.ReactElement {
  if (action.items?.length) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="text-base leading-control">
          <HugeiconsIcon icon={action.icon} />
          <span>{action.label}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-44">
          {action.items.map((item) => (
            <SidebarItemMenuAction
              action={item}
              key={item.value ?? item.label}
            />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  if (action.checked !== undefined) {
    return (
      <DropdownMenuCheckboxItem
        checked={action.checked}
        indicatorPosition="end"
        onSelect={action.onSelect}
      >
        <HugeiconsIcon icon={action.icon} />
        <span>{action.label}</span>
      </DropdownMenuCheckboxItem>
    );
  }

  return (
    <DropdownMenuItem
      onSelect={action.onSelect}
      variant={action.variant}
    >
      <HugeiconsIcon icon={action.icon} />
      <span>{action.label}</span>
      {action.shortcut ? <DropdownMenuShortcut>{action.shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  );
}
