'use client';

import type { ReactNode } from 'react';
import type { useT } from '@/components/I18nProvider';

import { MessageSquareCodeIcon, StarIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';

import { runtimeSectionEnabled } from '@/features/init/init-readiness';
import {
  STUDIO_MESH_SECTIONS,
  STUDIO_RUNTIME_SECTIONS,
  STUDIO_SYSTEM_SECTIONS,
  type StudioSectionId,
  type StudioSectionItem
} from '@/features/studio/sections';

export interface ProjectItem {
  id: string;
  name: string;
  hasRunningAgent: boolean;
  pinned: boolean;
  unreadCount: number;
}

type TFunction = ReturnType<typeof useT>;

const STUDIO_SHORTCUT_ITEMS = [...STUDIO_RUNTIME_SECTIONS, ...STUDIO_MESH_SECTIONS, ...STUDIO_SYSTEM_SECTIONS];
const SHELL_HEADER_HEIGHT = 52;
const SHORTCUT_BADGE_OVERLAY_CLASS = 'pointer-events-none absolute top-1/2 right-1.5 -mt-px -translate-y-1/2';

function ShortcutBadge({ modifierLabel, value }: { modifierLabel: string; value: number | string }) {
  return (
    <span className="inline-flex h-4 min-w-7 items-center justify-center gap-px rounded-full bg-sidebar-accent/85 px-1.5 font-medium text-[10px] text-sidebar-foreground/65 tabular-nums shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur">
      {modifierLabel}
      {value}
    </span>
  );
}

function SidebarNavSection({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1.5">
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function SidebarNavSectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 font-medium text-[11px] text-sidebar-foreground/55">{children}</div>;
}

function SidebarNavItem({
  active,
  children,
  icon: Icon,
  label,
  onClick,
  disabled,
  disabledReason,
  shortcutModifierLabel,
  shortcutValue
}: {
  active?: boolean;
  children?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  icon: IconSvgElement;
  label: string;
  onClick: () => void;
  shortcutModifierLabel?: string;
  shortcutValue?: number | string;
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      aria-disabled={disabled || undefined}
      className={cn(
        'group/item relative flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-(--radius-md) px-2.5 py-2 text-left transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground',
        disabled &&
          'cursor-not-allowed text-sidebar-foreground/35 hover:bg-transparent hover:text-sidebar-foreground/35'
      )}
      onClick={() => {
        if (!disabled) onClick();
      }}
      title={disabled ? disabledReason : undefined}
      type="button"
    >
      <div className="rounded-full border border-transparent bg-transparent p-1.5">
        <HugeiconsIcon
          className="size-4"
          icon={Icon}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-normal text-ui leading-control">{label}</div>
        {children}
      </div>
      {shortcutValue && shortcutModifierLabel ? (
        <span className={SHORTCUT_BADGE_OVERLAY_CLASS}>
          <ShortcutBadge
            modifierLabel={shortcutModifierLabel}
            value={shortcutValue}
          />
        </span>
      ) : null}
    </button>
  );
}

export function SidebarHeader({
  collapsed
}: {
  collapsed: boolean;
  onOpenWorkspace: () => void;
  onToggleCollapsed: () => void;
  t: TFunction;
}) {
  return (
    <div
      className="flex shrink-0 items-center px-3"
      style={{ height: SHELL_HEADER_HEIGHT }}
    >
      {collapsed ? null : <div className="min-w-0 flex-1" />}
    </div>
  );
}

export function StudioSidebarItems({
  activeSection,
  onSelect,
  runtimeReady,
  shortcutModifierLabel,
  showShortcutBadges,
  t
}: {
  activeSection: StudioSectionId;
  onSelect: (section: StudioSectionId) => void;
  runtimeReady: boolean;
  shortcutModifierLabel: string;
  t: TFunction;
  showShortcutBadges?: boolean;
}) {
  const shortcutNumbers = new Map(STUDIO_SHORTCUT_ITEMS.slice(0, 9).map((item, index) => [item.id, index + 1]));
  const disabledReason = t('web.studio.runtimeOnboardingRequired');
  const renderItem = ({ id, icon, i18nKey }: StudioSectionItem) => {
    const disabled = !runtimeSectionEnabled(id, runtimeReady);
    return (
      <SidebarNavItem
        active={activeSection === id}
        disabled={disabled}
        disabledReason={disabledReason}
        icon={icon}
        key={id}
        label={t(i18nKey)}
        onClick={() => onSelect(id)}
        shortcutModifierLabel={shortcutModifierLabel}
        shortcutValue={showShortcutBadges && !disabled ? shortcutNumbers.get(id) : undefined}
      />
    );
  };

  return (
    <>
      <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto">
        <SidebarNavSection>
          <SidebarNavSectionLabel>{t('web.studio.agentRuntime')}</SidebarNavSectionLabel>
          {STUDIO_RUNTIME_SECTIONS.map(renderItem)}
        </SidebarNavSection>
        <SidebarNavSection>
          <SidebarNavSectionLabel>{t('web.studio.agentMesh')}</SidebarNavSectionLabel>
          {STUDIO_MESH_SECTIONS.map(renderItem)}
        </SidebarNavSection>
      </div>
      <SidebarNavSection>
        <SidebarNavSectionLabel>{t('web.studio.system')}</SidebarNavSectionLabel>
        {STUDIO_SYSTEM_SECTIONS.map(renderItem)}
      </SidebarNavSection>
    </>
  );
}

function ProjectList({
  activeProjectId,
  projects,
  onOpenProject,
  onToggleProjectPinned,
  shortcutModifierLabel,
  showShortcutBadges,
  t
}: {
  activeProjectId: string | null;
  projects: ProjectItem[];
  onOpenProject: (id: string) => void;
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
          return (
            <div
              className={cn(
                'group/project relative flex items-center gap-1 rounded-(--radius-md) transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                active && 'bg-sidebar-accent text-sidebar-accent-foreground'
              )}
              key={project.id}
            >
              <button
                aria-current={active ? 'page' : undefined}
                className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-2 text-left"
                onClick={() => onOpenProject(project.id)}
                type="button"
              >
                <span className="line-clamp-2 min-w-0 flex-1 font-normal text-ui leading-control">{project.name}</span>
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
              </button>
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
                    aria-label={pinLabel}
                    className={cn(
                      'mr-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-(--radius-sm) text-sidebar-foreground/45 opacity-0 transition hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 group-focus-within/project:opacity-100 group-hover/project:opacity-100',
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
  monadChatActive,
  onOpenProject,
  onOpenMonadChat,
  projects,
  onToggleProjectPinned,
  shortcutModifierLabel,
  showShortcutBadges,
  t
}: {
  activeProjectId: string | null;
  monadChatActive: boolean;
  onOpenProject: (id: string) => void;
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
        onOpenProject={onOpenProject}
        onToggleProjectPinned={onToggleProjectPinned}
        projects={projects}
        shortcutModifierLabel={shortcutModifierLabel}
        showShortcutBadges={showShortcutBadges}
        t={t}
      />
    </>
  );
}
