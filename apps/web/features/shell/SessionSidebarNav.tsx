'use client';

import type { ReactNode } from 'react';
import type { useT } from '@/components/I18nProvider';

import { MessageSquareCodeIcon, PanelLeftCloseIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';

import { MonadLogo } from '@/components/MonadLogo';
import {
  STUDIO_AGENT_SECTIONS,
  STUDIO_CAPABILITY_SECTIONS,
  STUDIO_RUNTIME_SECTIONS,
  STUDIO_USAGE_SECTION,
  type StudioSectionId,
  type StudioSectionItem
} from '@/features/studio/sections';

export interface ProjectItem {
  id: string;
  name: string;
}

type TFunction = ReturnType<typeof useT>;

const STUDIO_SHORTCUT_ITEMS = [
  ...STUDIO_AGENT_SECTIONS,
  ...STUDIO_CAPABILITY_SECTIONS,
  ...STUDIO_RUNTIME_SECTIONS,
  STUDIO_USAGE_SECTION
];

function ShortcutBadge({ modifierLabel, number }: { modifierLabel: string; number: number }) {
  return (
    <span className="mt-0.5 inline-flex h-6 min-w-11 shrink-0 items-center justify-center gap-0.5 rounded-full bg-sidebar-accent/80 px-2 font-medium text-[13px] text-sidebar-foreground/70 tabular-nums shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur">
      {modifierLabel}
      {number}
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

function SidebarNavItem({
  active,
  children,
  icon: Icon,
  label,
  onClick,
  shortcutModifierLabel,
  shortcutNumber
}: {
  active?: boolean;
  children?: ReactNode;
  icon: IconSvgElement;
  label: string;
  onClick: () => void;
  shortcutModifierLabel?: string;
  shortcutNumber?: number;
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group/item flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-(--radius-md) px-2.5 py-2 text-left transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground'
      )}
      onClick={onClick}
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
      {shortcutNumber && shortcutModifierLabel ? (
        <span className="opacity-0 transition-opacity duration-150 group-hover/item:opacity-100 group-hover/item:delay-500">
          <ShortcutBadge
            modifierLabel={shortcutModifierLabel}
            number={shortcutNumber}
          />
        </span>
      ) : null}
    </button>
  );
}

export function SidebarHeader({
  onOpenWorkspace,
  onToggleCollapsed,
  t
}: {
  onOpenWorkspace: () => void;
  onToggleCollapsed: () => void;
  t: TFunction;
}) {
  return (
    <div className="px-4 pt-3.5 pb-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center">
          <button
            className="poster-heading cursor-pointer text-sidebar-primary transition hover:text-sidebar-foreground"
            onClick={onOpenWorkspace}
            type="button"
          >
            <MonadLogo className="h-6 w-[4.75rem]" />
          </button>
        </div>
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={t('web.sidebar.collapse')}
                className="size-7"
                onClick={onToggleCollapsed}
                size="icon"
                variant="ghost"
              >
                <HugeiconsIcon icon={PanelLeftCloseIcon} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('web.sidebar.collapse')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

export function StudioSidebarItems({
  activeSection,
  onSelect,
  shortcutModifierLabel,
  showShortcutBadges,
  t
}: {
  activeSection: StudioSectionId;
  onSelect: (section: StudioSectionId) => void;
  shortcutModifierLabel: string;
  t: TFunction;
  showShortcutBadges?: boolean;
}) {
  const shortcutNumbers = new Map(STUDIO_SHORTCUT_ITEMS.slice(0, 9).map((item, index) => [item.id, index + 1]));
  const renderItem = ({ id, icon, i18nKey }: StudioSectionItem) => (
    <SidebarNavItem
      active={activeSection === id}
      icon={icon}
      key={id}
      label={t(i18nKey)}
      onClick={() => onSelect(id)}
      shortcutModifierLabel={shortcutModifierLabel}
      shortcutNumber={showShortcutBadges ? shortcutNumbers.get(id) : undefined}
    />
  );

  return (
    <>
      <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto">
        <SidebarNavSection>{STUDIO_AGENT_SECTIONS.map(renderItem)}</SidebarNavSection>
        <SidebarNavSection>{STUDIO_CAPABILITY_SECTIONS.map(renderItem)}</SidebarNavSection>
        <SidebarNavSection>{STUDIO_RUNTIME_SECTIONS.map(renderItem)}</SidebarNavSection>
      </div>
      <SidebarNavSection>{renderItem(STUDIO_USAGE_SECTION)}</SidebarNavSection>
    </>
  );
}

function ProjectList({
  activeProjectId,
  projects,
  onOpenProject,
  t
}: {
  activeProjectId: string | null;
  projects: ProjectItem[];
  onOpenProject: (id: string) => void;
  t: TFunction;
}) {
  return (
    <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-1 px-2.5 pb-3">
        {projects.map((project) => (
          <button
            aria-current={activeProjectId === project.id ? 'page' : undefined}
            className={cn(
              'flex cursor-pointer flex-col items-start gap-0.5 rounded-(--radius-md) px-2.5 py-2 text-left transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              activeProjectId === project.id && 'bg-sidebar-accent text-sidebar-accent-foreground'
            )}
            key={project.id}
            onClick={() => onOpenProject(project.id)}
            type="button"
          >
            <span className="label-mono">{t('web.workplace.projectBadge')}</span>
            <span className="line-clamp-2 font-normal text-ui leading-control">{project.name}</span>
          </button>
        ))}
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
  t
}: {
  activeProjectId: string | null;
  monadChatActive: boolean;
  onOpenProject: (id: string) => void;
  onOpenMonadChat: () => void;
  projects: ProjectItem[];
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
        >
          <div className="mt-1 text-muted-foreground text-sm">{t('web.sidebar.monadAgentHint')}</div>
        </SidebarNavItem>
      </SidebarNavSection>
      <ProjectList
        activeProjectId={activeProjectId}
        onOpenProject={onOpenProject}
        projects={projects}
        t={t}
      />
    </>
  );
}
