import { ChatAdd01Icon, FolderAddIcon, InboxIcon, ListCollapse, ListTreeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { memo, useMemo } from 'react';

import { ShellLink } from '#/components/ShellLink';
import { ChatSessionList } from './chat-session-list';
import {
  SIDEBAR_ITEM_FOCUS_CLASS,
  SIDEBAR_ITEM_ROW_CLASS,
  SidebarActionVisibilityRules,
  SidebarIconActionButton,
  sidebarItemContainerClass
} from './nav-item';
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
        <ShellLink
          className={sidebarItemContainerClass({
            className: `${SIDEBAR_ITEM_ROW_CLASS} gap-2 ${SIDEBAR_ITEM_FOCUS_CLASS}`
          })}
          href="/"
          onClick={(event) => {
            event.preventDefault();
            actions.createChatSession();
          }}
        >
          <HugeiconsIcon
            className="size-4 shrink-0"
            icon={ChatAdd01Icon}
          />
          <span className="truncate">{meta.t('web.workspace.newChat')}</span>
        </ShellLink>
        <ShellLink
          className={sidebarItemContainerClass({
            active: state.inboxActive,
            className: `${SIDEBAR_ITEM_ROW_CLASS} mt-0.5 gap-2 ${SIDEBAR_ITEM_FOCUS_CLASS}`
          })}
          href="/inbox"
          onClick={(event) => {
            event.preventDefault();
            actions.openInbox();
          }}
        >
          <HugeiconsIcon
            className="size-4 shrink-0"
            icon={InboxIcon}
          />
          <span className="truncate">{meta.t('web.sidebar.inbox')}</span>
        </ShellLink>
      </div>
      <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto">
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
