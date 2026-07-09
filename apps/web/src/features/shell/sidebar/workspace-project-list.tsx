'use client';

import type { SessionId } from '@monad/protocol';
import type { ProjectItem, TFunction } from './types';

import {
  Bookmark02Icon,
  FileBookmarkIcon,
  Folder01Icon,
  FolderOpenIcon,
  Settings02Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';

import { ShellLink } from '#/components/ShellLink';
import { projectPath, projectSessionPath } from '#/features/shell/routing/paths';
import { SHORTCUT_BADGE_OVERLAY_CLASS, ShortcutBadge, sidebarIconButtonClass, sidebarItemStateClass } from './nav-item';

export type PinnedSessionItem = {
  projectId: string;
  projectName: string;
  session: ProjectItem['sessions'][number];
};

export function ProjectList({
  activeProjectId,
  activeSessionId,
  emptyLabel,
  expandedProjectIds,
  onToggleProjectExpanded,
  projects,
  onOpenProject,
  onOpenProjectSettings,
  onOpenProjectSession,
  onProjectSessionOpened,
  onToggleProjectPinned,
  shortcutModifierLabel,
  showShortcutBadges,
  t
}: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  emptyLabel: string;
  expandedProjectIds: ReadonlySet<string>;
  onToggleProjectExpanded: (id: string) => void;
  projects: ProjectItem[];
  onOpenProject: (id: string) => void;
  onOpenProjectSettings: (id: string) => void;
  onOpenProjectSession: (projectId: string, sessionId: SessionId) => void;
  onProjectSessionOpened: (projectId: string) => void;
  onToggleProjectPinned: (id: string) => void;
  shortcutModifierLabel?: string;
  showShortcutBadges?: boolean;
  t: TFunction;
}) {
  return (
    <>
      {projects.map((project, index) => {
        const active = activeProjectId === project.id;
        const expanded = expandedProjectIds.has(project.id);
        const unreadLabel = project.unreadCount > 99 ? '99+' : String(project.unreadCount);
        const runningLabel = t('web.workplace.projectRuntimeRunning');
        const unreadAriaLabel = t('web.workplace.projectUnreadMessages', { count: project.unreadCount });
        const pinLabel = project.pinned
          ? t('web.workplace.unpinProjectNamed', { name: project.name })
          : t('web.workplace.pinProjectNamed', { name: project.name });
        const pinTooltip = project.pinned ? t('web.workplace.unpinProject') : t('web.workplace.pinProject');
        const projectHref = project.sessions[0]
          ? projectSessionPath(project.id, project.sessions[0].id)
          : projectPath(project.id);
        return (
          <div
            className="group/project-tree"
            key={project.id}
          >
            <div
              className={cn(
                'relative flex items-center gap-1 rounded-(--radius-md)',
                sidebarItemStateClass({ active })
              )}
            >
              <ShellLink
                aria-current={active ? 'page' : undefined}
                aria-expanded={expanded}
                className="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left"
                href={projectHref}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenProject(project.id);
                  if (active) onToggleProjectExpanded(project.id);
                  else onProjectSessionOpened(project.id);
                }}
              >
                <HugeiconsIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  icon={expanded ? FolderOpenIcon : Folder01Icon}
                />
                <span className="line-clamp-2 min-w-0 flex-1 font-normal text-ui leading-control">{project.name}</span>
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
              </ShellLink>
              {showShortcutBadges && shortcutModifierLabel && index < 9 ? (
                <span className={SHORTCUT_BADGE_OVERLAY_CLASS}>
                  <ShortcutBadge
                    modifierLabel={shortcutModifierLabel}
                    value={index + 1}
                  />
                </span>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={t('web.project.openSettings')}
                    className={sidebarIconButtonClass()}
                    onClick={() => onOpenProjectSettings(project.id)}
                    type="button"
                  >
                    <HugeiconsIcon
                      className="size-3.5"
                      icon={Settings02Icon}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t('web.project.settings')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={pinLabel}
                    className={cn('mr-1', sidebarIconButtonClass({ active: project.pinned }))}
                    onClick={() => onToggleProjectPinned(project.id)}
                    type="button"
                  >
                    <HugeiconsIcon
                      className={cn('size-3.5', project.pinned && 'fill-current')}
                      icon={Bookmark02Icon}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{pinTooltip}</TooltipContent>
              </Tooltip>
            </div>
            {expanded && project.sessions.length > 0 ? (
              <div
                aria-label={project.name}
                className="mt-1 flex flex-col gap-0.5 pl-6"
                role="tree"
              >
                {project.sessions.map((session) => {
                  const sessionActive = activeSessionId === session.id;
                  return (
                    <ShellLink
                      aria-current={sessionActive ? 'page' : undefined}
                      className={cn(
                        'min-h-8 rounded-(--radius-sm) px-2 py-1.5 text-left text-muted-foreground text-sm transition hover:bg-sidebar-accent hover:text-foreground',
                        sessionActive && 'bg-sidebar-selected/70 text-foreground'
                      )}
                      href={projectSessionPath(project.id, session.id)}
                      key={session.id}
                      onClick={(event) => {
                        event.preventDefault();
                        onOpenProjectSession(project.id, session.id);
                      }}
                      role="treeitem"
                      title={session.title}
                    >
                      <span className="block truncate">{session.title}</span>
                    </ShellLink>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
      {projects.length === 0 && <p className="px-2 py-2 text-muted-foreground text-xs">{emptyLabel}</p>}
    </>
  );
}

export function PinnedSessionList({
  activeSessionId,
  onOpenProjectSession,
  onProjectSessionOpened,
  sessions
}: {
  activeSessionId: string | null;
  onOpenProjectSession: (projectId: string, sessionId: SessionId) => void;
  onProjectSessionOpened: (projectId: string) => void;
  sessions: PinnedSessionItem[];
}) {
  return (
    <>
      {sessions.map(({ projectId, projectName, session }) => {
        const active = activeSessionId === session.id;
        return (
          <ShellLink
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex min-h-8 items-center gap-2 rounded-(--radius-sm) px-2.5 py-1.5 text-left text-muted-foreground text-sm transition hover:bg-sidebar-accent hover:text-foreground',
              active && 'bg-sidebar-selected/70 text-foreground'
            )}
            href={projectSessionPath(projectId, session.id)}
            key={`${projectId}:${session.id}`}
            onClick={(event) => {
              event.preventDefault();
              onProjectSessionOpened(projectId);
              onOpenProjectSession(projectId, session.id);
            }}
            title={`${projectName}: ${session.title}`}
          >
            <HugeiconsIcon
              className="size-3.5 shrink-0"
              icon={FileBookmarkIcon}
            />
            <span className="block min-w-0 flex-1 truncate">{session.title}</span>
          </ShellLink>
        );
      })}
    </>
  );
}
