'use client';

import type { SessionId } from '@monad/protocol';
import type { ProjectItem, TFunction } from './types';

import { MessageSquareCodeIcon, Settings02Icon, StarIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';

import { ShellLink } from '#/components/ShellLink';
import { projectPath, projectSessionPath } from '#/features/shell/routing/paths';
import { SHORTCUT_BADGE_OVERLAY_CLASS, ShortcutBadge, SidebarNavItem, SidebarNavSection } from './nav-item';

function ProjectList({
  activeProjectId,
  activeSessionId,
  projects,
  onOpenProject,
  onOpenProjectSettings,
  onOpenProjectSession,
  onToggleProjectPinned,
  shortcutModifierLabel,
  showShortcutBadges,
  t
}: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  projects: ProjectItem[];
  onOpenProject: (id: string) => void;
  onOpenProjectSettings: (id: string) => void;
  onOpenProjectSession: (projectId: string, sessionId: SessionId) => void;
  onToggleProjectPinned: (id: string) => void;
  shortcutModifierLabel?: string;
  showShortcutBadges?: boolean;
  t: TFunction;
}) {
  return (
    <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-1 px-2.5 pb-3">
        {projects.map((project, index) => {
          const active = activeProjectId === project.id;
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
                  'relative flex items-center gap-1 rounded-(--radius-md) transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                  active && 'bg-sidebar-selected text-sidebar-selected-foreground hover:bg-sidebar-selected-hover'
                )}
              >
                <ShellLink
                  aria-current={active ? 'page' : undefined}
                  aria-expanded={active}
                  className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-2 text-left"
                  href={projectHref}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenProject(project.id);
                  }}
                >
                  <span className="line-clamp-2 min-w-0 flex-1 font-normal text-ui leading-control">
                    {project.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {project.hasRunningAgent ? (
                      <span
                        className="relative flex size-2.5"
                        title={runningLabel}
                      >
                        <span className="sr-only">{runningLabel}</span>
                        <span className="absolute inline-flex size-full rounded-full bg-[color-mix(in_srgb,var(--accent-blue)_48%,transparent)] opacity-75 motion-safe:animate-ping" />
                        <span className="relative inline-flex size-2.5 rounded-full bg-[color-mix(in_srgb,var(--accent-blue)_86%,var(--foreground))]" />
                      </span>
                    ) : null}
                    {project.unreadCount > 0 ? (
                      <>
                        <span className="sr-only">{unreadAriaLabel}</span>
                        <span
                          aria-hidden="true"
                          className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-sidebar-primary px-1.5 font-medium text-[11px] text-sidebar-primary-foreground tabular-nums"
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
                      className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-(--radius-sm) text-sidebar-foreground/45 opacity-0 transition hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 group-focus-within/project-tree:opacity-100 group-hover/project-tree:opacity-100 [@media_(hover:none),_(pointer:coarse)]:opacity-100"
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
                      className={cn(
                        'mr-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-(--radius-sm) text-sidebar-foreground/45 opacity-0 transition hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 group-focus-within/project-tree:opacity-100 group-hover/project-tree:opacity-100 [@media_(hover:none),_(pointer:coarse)]:opacity-100',
                        project.pinned && 'text-sidebar-primary opacity-100'
                      )}
                      onClick={() => onToggleProjectPinned(project.id)}
                      type="button"
                    >
                      <HugeiconsIcon
                        className={cn('size-3.5', project.pinned && 'fill-current')}
                        icon={StarIcon}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{pinTooltip}</TooltipContent>
                </Tooltip>
              </div>
              {active && project.sessions.length > 0 ? (
                <div
                  aria-label={project.name}
                  className="mt-1 flex flex-col gap-0.5 border-sidebar-border/60 border-l pl-3"
                  role="tree"
                >
                  {project.sessions.map((session) => {
                    const sessionActive = activeSessionId === session.id;
                    return (
                      <ShellLink
                        aria-current={sessionActive ? 'page' : undefined}
                        className={cn(
                          'min-h-8 cursor-pointer rounded-(--radius-sm) px-2 py-1.5 text-left text-sidebar-foreground/72 text-sm transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                          sessionActive && 'bg-sidebar-selected/70 text-sidebar-selected-foreground'
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
        {projects.length === 0 && (
          <p className="px-2 py-2 text-muted-foreground text-xs">{t('web.workplace.noProjects')}</p>
        )}
      </div>
    </div>
  );
}

export function WorkspaceSidebarItems({
  activeProjectId,
  activeSessionId,
  monadChatActive,
  onOpenProject,
  onOpenProjectSettings,
  onOpenProjectSession,
  onOpenMonadChat,
  projects,
  onToggleProjectPinned,
  shortcutModifierLabel,
  showShortcutBadges,
  t
}: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  monadChatActive: boolean;
  onOpenProject: (id: string) => void;
  onOpenProjectSettings: (id: string) => void;
  onOpenProjectSession: (projectId: string, sessionId: SessionId) => void;
  onOpenMonadChat: () => void;
  onToggleProjectPinned: (id: string) => void;
  projects: ProjectItem[];
  shortcutModifierLabel?: string;
  showShortcutBadges?: boolean;
  t: TFunction;
}) {
  return (
    <>
      <SidebarNavSection>
        <SidebarNavItem
          active={monadChatActive}
          href="/"
          icon={MessageSquareCodeIcon}
          label={t('web.sidebar.monadAgent')}
          onClick={onOpenMonadChat}
          shortcutModifierLabel={shortcutModifierLabel}
          shortcutValue={showShortcutBadges ? '`' : undefined}
        >
          <div className="mt-1 text-muted-foreground text-sm">{t('web.sidebar.monadAgentHint')}</div>
        </SidebarNavItem>
      </SidebarNavSection>
      <ProjectList
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        onOpenProject={onOpenProject}
        onOpenProjectSession={onOpenProjectSession}
        onOpenProjectSettings={onOpenProjectSettings}
        onToggleProjectPinned={onToggleProjectPinned}
        projects={projects}
        shortcutModifierLabel={shortcutModifierLabel}
        showShortcutBadges={showShortcutBadges}
        t={t}
      />
    </>
  );
}
