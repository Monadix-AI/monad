import {
  ChatAdd01Icon,
  FolderAddIcon,
  InboxIcon,
  ListCollapse,
  ListTreeIcon,
  Search01Icon
} from '@hugeicons/core-free-icons';
import { memo, useMemo } from 'react';

import { ChatSessionList } from './chat-session-list';
import { SidebarActionVisibilityRules, SidebarIconActionButton, SidebarNavItem } from './nav-item';
import { SidebarShortcutAllocatorProvider } from './sidebar-shortcut-context';
import { SidebarItemSkeletonList } from './sidebar-skeleton';
import { useWorkspaceSidebarTreeState } from './use-workspace-sidebar-tree-state';
import { PinnedSessionList, ProjectList } from './workspace-project-list';
import { WorkspaceSection } from './workspace-section';
import {
  useWorkspaceSidebar,
  type WorkspaceSidebarContextValue,
  WorkspaceSidebarProvider
} from './workspace-sidebar-context';

const WorkspaceSectionList = memo(function WorkspaceSectionList() {
  const { actions, meta, state } = useWorkspaceSidebar();
  const pinnedSessions = useMemo(
    () =>
      state.projects.flatMap((project) =>
        project.sessions
          .filter((session) => session.pinned)
          .map((session) => ({ projectId: project.id, projectName: project.name, session }))
      ),
    [state.projects]
  );
  const projectIds = useMemo(() => state.projects.map((project) => project.id), [state.projects]);
  const {
    allProjectsExpanded,
    collapsedSections,
    expandProject,
    expandedProjectIds,
    toggleAllProjectsExpanded,
    toggleProjectExpanded,
    toggleSection
  } = useWorkspaceSidebarTreeState({ activeProjectId: state.activeProjectId, projectIds });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarActionVisibilityRules />
      <div className="flex-none px-2.5 pb-2">
        <SidebarNavItem
          href="/"
          icon={ChatAdd01Icon}
          label={meta.t('web.workspace.newChat')}
          onClick={actions.createChatSession}
          shortcutModifierLabel={meta.shortcutModifierLabel}
          shortcutValue={meta.showShortcutBadges ? '`' : undefined}
        />
        <div className="mt-0.5 flex flex-col gap-0.5">
          <SidebarNavItem
            active={state.inboxActive}
            href="/inbox"
            icon={InboxIcon}
            label={meta.t('web.sidebar.inbox')}
            onClick={actions.openInbox}
            shortcutModifierLabel={meta.shortcutModifierLabel}
            shortcutValue={meta.showShortcutBadges ? 'I' : undefined}
          />
          <SidebarNavItem
            icon={Search01Icon}
            label={meta.t('web.sidebar.searchSessions')}
            onClick={actions.openSearch}
            shortcutModifierLabel={meta.shortcutModifierLabel}
            shortcutValue={meta.showShortcutBadges ? 'K' : undefined}
          />
        </div>
      </div>
      <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto">
        <SidebarShortcutAllocatorProvider>
          <div className="flex flex-col gap-0.5 px-2.5 pb-4">
            {pinnedSessions.length > 0 ? (
              <WorkspaceSection
                collapsed={collapsedSections.pinned}
                onToggle={() => toggleSection('pinned')}
                title={meta.t('web.sidebar.pinned')}
              >
                <PinnedSessionList
                  onProjectSessionOpened={expandProject}
                  sessions={pinnedSessions}
                />
              </WorkspaceSection>
            ) : null}
            <WorkspaceSection
              action={
                <>
                  {projectIds.length > 0 ? (
                    <SidebarIconActionButton
                      icon={allProjectsExpanded ? ListCollapse : ListTreeIcon}
                      label={
                        allProjectsExpanded
                          ? meta.t('web.sidebar.collapseAllProjects')
                          : meta.t('web.sidebar.expandAllProjects')
                      }
                      onClick={toggleAllProjectsExpanded}
                    />
                  ) : null}
                  <SidebarIconActionButton
                    icon={FolderAddIcon}
                    label={meta.t('web.workplace.newProject')}
                    onClick={actions.createProject}
                  />
                </>
              }
              collapsed={collapsedSections.projects}
              onToggle={() => toggleSection('projects')}
              title={meta.t('web.sidebar.projects')}
            >
              {state.loading ? (
                <SidebarItemSkeletonList />
              ) : (
                <ProjectList
                  expandedProjectIds={expandedProjectIds}
                  onToggleProjectExpanded={toggleProjectExpanded}
                />
              )}
            </WorkspaceSection>
            <WorkspaceSection
              action={
                <SidebarIconActionButton
                  icon={ChatAdd01Icon}
                  label={meta.t('web.sidebar.newChatSession')}
                  onClick={actions.createChatSession}
                />
              }
              collapsed={collapsedSections.chats}
              onToggle={() => toggleSection('chats')}
              title={meta.t('web.sidebar.chats')}
            >
              {state.loading ? <SidebarItemSkeletonList count={3} /> : <ChatSessionList />}
            </WorkspaceSection>
          </div>
        </SidebarShortcutAllocatorProvider>
      </div>
    </div>
  );
});

export function WorkspaceSidebarItems({ value }: { value: WorkspaceSidebarContextValue }) {
  return (
    <WorkspaceSidebarProvider value={value}>
      <WorkspaceSectionList />
    </WorkspaceSidebarProvider>
  );
}
