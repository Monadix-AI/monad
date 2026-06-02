import type { ProjectItem } from './types';

import {
  ChatAdd01Icon,
  Delete02Icon,
  FileArchiveIcon,
  Folder01Icon,
  FolderOpenIcon,
  PencilEdit01Icon,
  PinIcon,
  Settings02Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useCallback, useMemo } from 'react';

import { projectSessionPath } from '#/features/shell/routing/paths';
import { useProjectViewMode } from '#/features/workspace/use-project-view-mode';
import { SIDEBAR_INDENTED_ITEM_ROW_CLASS, SIDEBAR_ITEM_ROW_CLASS, SidebarIconActionButton } from './nav-item';
import { projectExperienceAction } from './project-session-experience-actions';
import { SessionStatusMarker } from './session-attention-marker';
import { useSidebarSessionShortcutValue } from './sidebar-shortcut-context';
import { useWorkspaceSidebar } from './workspace-sidebar-context';
import { type TreeItemMenuAction, WorkspaceTreeItem } from './workspace-tree-item';

export type PinnedSessionItem = {
  projectId: string;
  projectName: string;
  session: ProjectItem['sessions'][number];
};

function useProjectExperienceMenu(projectId: string): TreeItemMenuAction | null {
  const { meta } = useWorkspaceSidebar();
  const [preferredMode, setMode] = useProjectViewMode(projectId);
  const activeExperienceId = meta.projectExperiences.some((experience) => experience.id === preferredMode)
    ? (preferredMode as string)
    : (meta.projectExperiences[0]?.id ?? '');

  return useMemo(
    () =>
      projectExperienceAction({
        activeExperienceId,
        experiences: meta.projectExperiences,
        label: meta.t('web.workplace.experienceMenu'),
        onSelect: setMode
      }),
    [activeExperienceId, meta.projectExperiences, meta.t, setMode]
  );
}

export function ProjectTreeRow({
  expanded,
  onDelete,
  onToggleProjectExpanded,
  project
}: {
  expanded: boolean;
  onDelete: (project: Pick<ProjectItem, 'id' | 'name'>) => void;
  onToggleProjectExpanded: (id: string) => void;
  project: ProjectItem;
}) {
  const { actions, meta } = useWorkspaceSidebar();
  const { t } = meta;
  const toggleProjectExpanded = useCallback(
    () => onToggleProjectExpanded(project.id),
    [onToggleProjectExpanded, project.id]
  );
  const experienceMenu = useProjectExperienceMenu(project.id);
  const renameProject = useCallback((title: string) => actions.renameProject(project.id, title), [actions, project.id]);
  const deleteProject = useCallback(() => onDelete(project), [onDelete, project]);
  const projectMenuActions = useMemo<TreeItemMenuAction[]>(
    () => [
      {
        icon: PencilEdit01Icon,
        kind: 'rename',
        label: t('web.sidebar.renameProject')
      },
      ...(experienceMenu ? [experienceMenu] : []),
      {
        icon: Delete02Icon,
        label: t('web.workplace.deleteProject'),
        onSelect: deleteProject,
        shortcut: 'D',
        variant: 'destructive'
      }
    ],
    [deleteProject, experienceMenu, t]
  );

  return (
    <WorkspaceTreeItem
      actions={
        <SidebarIconActionButton
          icon={Settings02Icon}
          label={t('web.project.openSettings')}
          onClick={() => actions.openProjectSettings(project.id)}
          tooltip={t('web.project.settings')}
        />
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
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
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
  const archiveSession = useCallback(() => {
    void actions.archiveProjectSession(projectId, session.id);
  }, [actions, projectId, session.id]);
  const deleteSession = useCallback(() => {
    void actions.deleteProjectSession(projectId, session.id);
  }, [actions, projectId, session.id]);
  const openSession = useCallback(
    () => actions.openProjectSession(projectId, session.id),
    [actions, projectId, session.id]
  );
  const shortcutValue = useSidebarSessionShortcutValue(`project:${projectId}:${session.id}`);
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
        icon: FileArchiveIcon,
        label: t('web.workplace.archiveSession'),
        onSelect: archiveSession,
        shortcut: 'A'
      },
      {
        icon: Delete02Icon,
        label: t('web.sidebar.deleteSession'),
        onSelect: deleteSession,
        shortcut: 'D',
        variant: 'destructive'
      }
    ],
    [archiveSession, deleteSession, session.pinned, t, togglePinned]
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
      sessionShortcut={
        shortcutValue && meta.shortcutModifierLabel
          ? {
              modifierLabel: meta.shortcutModifierLabel,
              value: shortcutValue,
              visible: meta.showShortcutBadges === true
            }
          : undefined
      }
      sidebarSession
      status={
        <SessionStatusMarker
          attentionState={session.attentionState}
          generationState={session.generationState}
        />
      }
      title={session.title}
    />
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
  const archiveSession = useCallback(() => {
    void actions.archiveProjectSession(projectId, session.id);
  }, [actions, projectId, session.id]);
  const deleteSession = useCallback(() => {
    void actions.deleteProjectSession(projectId, session.id);
  }, [actions, projectId, session.id]);
  const openSession = useCallback(() => {
    onProjectSessionOpened(projectId);
    actions.openProjectSession(projectId, session.id);
  }, [actions, onProjectSessionOpened, projectId, session.id]);
  const shortcutValue = useSidebarSessionShortcutValue(`pinned:${projectId}:${session.id}`);
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
        icon: FileArchiveIcon,
        label: t('web.workplace.archiveSession'),
        onSelect: archiveSession,
        shortcut: 'A'
      },
      {
        icon: Delete02Icon,
        label: t('web.sidebar.deleteSession'),
        onSelect: deleteSession,
        shortcut: 'D',
        variant: 'destructive'
      }
    ],
    [archiveSession, deleteSession, t, togglePinned]
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
      sessionShortcut={
        shortcutValue && meta.shortcutModifierLabel
          ? {
              modifierLabel: meta.shortcutModifierLabel,
              value: shortcutValue,
              visible: meta.showShortcutBadges === true
            }
          : undefined
      }
      sidebarSession
      status={
        <SessionStatusMarker
          attentionState={session.attentionState}
          generationState={session.generationState}
        />
      }
      title={`${projectName}: ${session.title}`}
    />
  );
}
