'use client';

import type { SessionId } from '@monad/protocol';
import type { ProjectItem, TFunction } from './types';

import { MessageSquareCodeIcon } from '@hugeicons/core-free-icons';
import { useEffect, useState } from 'react';

import { SidebarNavItem } from './nav-item';
import { PinnedSessionList, ProjectList } from './workspace-project-list';
import { WorkspaceSection } from './workspace-section';

type WorkspaceSectionId = 'pinned' | 'projects' | 'chats';

function ChatsList({
  monadChatActive,
  onOpenMonadChat,
  shortcutModifierLabel,
  showShortcutBadges,
  t
}: {
  monadChatActive: boolean;
  onOpenMonadChat: () => void;
  shortcutModifierLabel?: string;
  showShortcutBadges?: boolean;
  t: TFunction;
}) {
  return (
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
  );
}

function createOpenSections(): Record<WorkspaceSectionId, boolean> {
  return {
    chats: false,
    pinned: false,
    projects: false
  };
}

function toggleSectionState(
  sections: Record<WorkspaceSectionId, boolean>,
  section: WorkspaceSectionId
): Record<WorkspaceSectionId, boolean> {
  return {
    ...sections,
    [section]: !sections[section]
  };
}

function WorkspaceSectionList({
  activeProjectId,
  activeSessionId,
  monadChatActive,
  onOpenProject,
  onOpenProjectSettings,
  onOpenProjectSession,
  onOpenMonadChat,
  onToggleProjectPinned,
  projects,
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
  const [collapsedSections, setCollapsedSections] = useState(createOpenSections);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(activeProjectId ? [activeProjectId] : [])
  );
  const pinnedSessions = projects.flatMap((project) =>
    project.pinned
      ? project.sessions.map((session) => ({
          projectId: project.id,
          projectName: project.name,
          session
        }))
      : []
  );
  const toggleSection = (section: WorkspaceSectionId) => {
    setCollapsedSections((sections) => toggleSectionState(sections, section));
  };
  const expandProject = (projectId: string) => {
    setExpandedProjectIds((current) => new Set(current).add(projectId));
  };
  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  useEffect(() => {
    if (!activeProjectId) return;
    setExpandedProjectIds((current) => new Set(current).add(activeProjectId));
  }, [activeProjectId]);

  return (
    <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-2 px-2.5 pb-3">
        {pinnedSessions.length > 0 ? (
          <WorkspaceSection
            collapsed={collapsedSections.pinned}
            onToggle={() => toggleSection('pinned')}
            title={t('web.sidebar.pinned')}
          >
            <PinnedSessionList
              activeSessionId={activeSessionId}
              onOpenProjectSession={onOpenProjectSession}
              onProjectSessionOpened={expandProject}
              sessions={pinnedSessions}
            />
          </WorkspaceSection>
        ) : null}
        <WorkspaceSection
          collapsed={collapsedSections.projects}
          onToggle={() => toggleSection('projects')}
          title={t('web.sidebar.projects')}
        >
          <ProjectList
            activeProjectId={activeProjectId}
            activeSessionId={activeSessionId}
            emptyLabel={t('web.workplace.noProjects')}
            expandedProjectIds={expandedProjectIds}
            onOpenProject={onOpenProject}
            onOpenProjectSession={onOpenProjectSession}
            onOpenProjectSettings={onOpenProjectSettings}
            onProjectSessionOpened={expandProject}
            onToggleProjectExpanded={toggleProjectExpanded}
            onToggleProjectPinned={onToggleProjectPinned}
            projects={projects}
            shortcutModifierLabel={shortcutModifierLabel}
            showShortcutBadges={showShortcutBadges}
            t={t}
          />
        </WorkspaceSection>
        <WorkspaceSection
          collapsed={collapsedSections.chats}
          onToggle={() => toggleSection('chats')}
          title={t('web.sidebar.chats')}
        >
          <ChatsList
            monadChatActive={monadChatActive}
            onOpenMonadChat={onOpenMonadChat}
            shortcutModifierLabel={shortcutModifierLabel}
            showShortcutBadges={showShortcutBadges}
            t={t}
          />
        </WorkspaceSection>
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
    <WorkspaceSectionList
      activeProjectId={activeProjectId}
      activeSessionId={activeSessionId}
      monadChatActive={monadChatActive}
      onOpenMonadChat={onOpenMonadChat}
      onOpenProject={onOpenProject}
      onOpenProjectSession={onOpenProjectSession}
      onOpenProjectSettings={onOpenProjectSettings}
      onToggleProjectPinned={onToggleProjectPinned}
      projects={projects}
      shortcutModifierLabel={shortcutModifierLabel}
      showShortcutBadges={showShortcutBadges}
      t={t}
    />
  );
}
