import type { ProjectItem } from './types';

import {
  ChatAdd01Icon,
  Delete02Icon,
  Folder01Icon,
  FolderOpenIcon,
  PencilEdit01Icon,
  PinIcon,
  Settings02Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useCallback, useMemo } from 'react';

import { projectSessionPath } from '#/features/shell/routing/paths';
import {
  SHORTCUT_BADGE_OVERLAY_CLASS,
  ShortcutBadge,
  SIDEBAR_INDENTED_ITEM_ROW_CLASS,
  SIDEBAR_ITEM_ROW_CLASS,
  SidebarIconActionButton
} from './nav-item';
import { useWorkspaceSidebar } from './workspace-sidebar-context';
import { type TreeItemMenuAction, WorkspaceTreeItem } from './workspace-tree-item';

export type PinnedSessionItem = {
  projectId: string;
  projectName: string;
  session: ProjectItem['sessions'][number];
};

function confirmDestructive(message: string): boolean {
  return typeof window === 'undefined' ? false : window.confirm(message);
}

export function ProjectTreeRow({
  expanded,
  index,
  onToggleProjectExpanded,
  project
}: {
  expanded: boolean;
  index: number;
  onToggleProjectExpanded: (id: string) => void;
  project: ProjectItem;
}) {
  const { actions, meta } = useWorkspaceSidebar();
  const { shortcutModifierLabel, showShortcutBadges, t } = meta;
  const unreadLabel = project.unreadCount > 99 ? '99+' : String(project.unreadCount);
  const runningLabel = t('web.workplace.projectRuntimeRunning');
  const unreadAriaLabel = t('web.workplace.projectUnreadMessages', { count: project.unreadCount });
  const toggleProjectExpanded = useCallback(
    () => onToggleProjectExpanded(project.id),
    [onToggleProjectExpanded, project.id]
  );
  const renameProject = useCallback((title: string) => actions.renameProject(project.id, title), [actions, project.id]);
  const deleteProject = useCallback(() => {
    if (confirmDestructive(t('web.workplace.deleteProjectConfirmDescription', { name: project.name }))) {
      void actions.deleteProject(project.id);
    }
  }, [actions, project.id, project.name, t]);
  const projectMenuActions = useMemo<TreeItemMenuAction[]>(
    () => [
      {
        icon: PencilEdit01Icon,
        kind: 'rename',
        label: t('web.sidebar.renameProject')
      },
      {
        icon: Delete02Icon,
        label: t('web.workplace.deleteProject'),
        onSelect: deleteProject,
        shortcut: 'D',
        variant: 'destructive'
      }
    ],
    [deleteProject, t]
  );

  return (
    <WorkspaceTreeItem
      actions={
        <>
          {showShortcutBadges && shortcutModifierLabel && index < 9 ? (
            <span className={SHORTCUT_BADGE_OVERLAY_CLASS}>
              <ShortcutBadge
                modifierLabel={shortcutModifierLabel}
                value={index + 1}
              />
            </span>
          ) : null}
          <SidebarIconActionButton
            icon={Settings02Icon}
            label={t('web.project.openSettings')}
            onClick={() => actions.openProjectSettings(project.id)}
            tooltip={t('web.project.settings')}
          />
        </>
      }
      active={false}
      ariaExpanded={expanded}
      className={SIDEBAR_ITEM_ROW_CLASS}
      icon={
        <HugeiconsIcon
          className="size-4 shrink-0 transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          icon={expanded ? FolderOpenIcon : Folder01Icon}
        />
      }
      label={project.name}
      menuActions={projectMenuActions}
      menuLabel={t('web.sidebar.itemMenu')}
      onOpen={toggleProjectExpanded}
      onRename={renameProject}
      trailingActions={
        <SidebarIconActionButton
          icon={ChatAdd01Icon}
          label={t('web.sidebar.newProjectSession')}
          onClick={() => actions.createProjectSession(project.id)}
        />
      }
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {project.hasRunningAgent ? (
            <span
              className="relative flex size-2.5"
              title={runningLabel}
            >
              <span className="sr-only">{runningLabel}</span>
              <span className="absolute inline-flex size-full rounded-full bg-foreground/30 opacity-75 motion-safe:animate-ping" />
              <span className="relative inline-flex size-2.5 rounded-full bg-foreground" />
            </span>
          ) : null}
          {project.unreadCount > 0 ? (
            <>
              <span className="sr-only">{unreadAriaLabel}</span>
              <span
                aria-hidden="true"
                className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 font-medium text-[11px] text-foreground tabular-nums"
              >
                {unreadLabel}
              </span>
            </>
          ) : null}
        </span>
      </span>
    </WorkspaceTreeItem>
  );
}

export function ProjectSessionTreeRow({
  active,
  projectId,
  session
}: {
  active: boolean;
  projectId: string;
  session: ProjectItem['sessions'][number];
}) {
  const { actions, meta } = useWorkspaceSidebar();
  const { t } = meta;
  const sessionPinLabel = session.pinned
    ? t('web.workplace.unpinSessionNamed', { name: session.title })
    : t('web.workplace.pinSessionNamed', { name: session.title });
  const sessionPinTooltip = session.pinned ? t('web.workplace.unpinSession') : t('web.workplace.pinSession');
  const togglePinned = useCallback(() => actions.toggleSessionPinned(session.id), [actions, session.id]);
  const deleteSession = useCallback(() => {
    void actions.deleteProjectSession(projectId, session.id);
  }, [actions, projectId, session.id]);
  const openSession = useCallback(
    () => actions.openProjectSession(projectId, session.id),
    [actions, projectId, session.id]
  );
  const renameSession = useCallback((title: string) => actions.renameSession(session.id, title), [actions, session.id]);
  const sessionMenuActions = useMemo<TreeItemMenuAction[]>(
    () => [
      {
        icon: PencilEdit01Icon,
        kind: 'rename',
        label: t('web.sidebar.renameSession')
      },
      {
        icon: PinIcon,
        label: session.pinned ? t('web.workplace.unpinSession') : t('web.workplace.pinSession'),
        onSelect: togglePinned
      },
      {
        icon: Delete02Icon,
        label: t('web.workplace.deleteSession'),
        onSelect: deleteSession,
        shortcut: 'D',
        variant: 'destructive'
      }
    ],
    [deleteSession, session.pinned, t, togglePinned]
  );

  return (
    <WorkspaceTreeItem
      actions={
        <SidebarIconActionButton
          active={session.pinned}
          icon={PinIcon}
          iconClassName={session.pinned ? 'fill-current' : undefined}
          label={sessionPinLabel}
          onClick={togglePinned}
          tooltip={sessionPinTooltip}
        />
      }
      active={active}
      className={SIDEBAR_INDENTED_ITEM_ROW_CLASS}
      href={projectSessionPath(projectId, session.id)}
      label={session.title}
      menuActions={sessionMenuActions}
      menuLabel={t('web.sidebar.itemMenu')}
      onOpen={openSession}
      onRename={renameSession}
      title={session.title}
    >
      <span className="block truncate">{session.title}</span>
    </WorkspaceTreeItem>
  );
}

export function PinnedSessionTreeRow({
  active,
  item,
  onProjectSessionOpened
}: {
  active: boolean;
  item: PinnedSessionItem;
  onProjectSessionOpened: (projectId: string) => void;
}) {
  const { actions, meta } = useWorkspaceSidebar();
  const { t } = meta;
  const { projectId, projectName, session } = item;
  const togglePinned = useCallback(() => actions.toggleSessionPinned(session.id), [actions, session.id]);
  const deleteSession = useCallback(() => {
    void actions.deleteProjectSession(projectId, session.id);
  }, [actions, projectId, session.id]);
  const openSession = useCallback(() => {
    onProjectSessionOpened(projectId);
    actions.openProjectSession(projectId, session.id);
  }, [actions, onProjectSessionOpened, projectId, session.id]);
  const renameSession = useCallback((title: string) => actions.renameSession(session.id, title), [actions, session.id]);
  const sessionMenuActions = useMemo<TreeItemMenuAction[]>(
    () => [
      {
        icon: PencilEdit01Icon,
        kind: 'rename',
        label: t('web.sidebar.renameSession')
      },
      {
        icon: PinIcon,
        label: t('web.workplace.unpinSession'),
        onSelect: togglePinned
      },
      {
        icon: Delete02Icon,
        label: t('web.workplace.deleteSession'),
        onSelect: deleteSession,
        shortcut: 'D',
        variant: 'destructive'
      }
    ],
    [deleteSession, t, togglePinned]
  );

  return (
    <WorkspaceTreeItem
      actions={
        <SidebarIconActionButton
          icon={PinIcon}
          iconClassName="fill-current"
          label={t('web.workplace.unpinSessionNamed', { name: session.title })}
          onClick={togglePinned}
          tooltip={t('web.workplace.unpinSession')}
        />
      }
      active={active}
      className={SIDEBAR_ITEM_ROW_CLASS}
      href={projectSessionPath(projectId, session.id)}
      label={session.title}
      menuActions={sessionMenuActions}
      menuLabel={t('web.sidebar.itemMenu')}
      onOpen={openSession}
      onRename={renameSession}
      title={`${projectName}: ${session.title}`}
    >
      <span className="block min-w-0 flex-1 truncate will-change-auto">{session.title}</span>
    </WorkspaceTreeItem>
  );
}
