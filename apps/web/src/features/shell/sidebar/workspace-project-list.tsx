'use client';

import { CollapsiblePresence } from './collapsible-presence';
import {
  getPreviewLessTargetCount,
  SidebarMoreLessControls,
  useSidebarPreviewCountByKey
} from './session-preview-controls';
import {
  type PinnedSessionItem,
  PinnedSessionTreeRow,
  ProjectSessionTreeRow,
  ProjectTreeRow
} from './workspace-project-rows';
import { useWorkspaceSidebar } from './workspace-sidebar-context';

export function ProjectList({
  expandedProjectIds,
  onToggleProjectExpanded,
  onProjectSessionOpened
}: {
  expandedProjectIds: ReadonlySet<string>;
  onToggleProjectExpanded: (id: string) => void;
  onProjectSessionOpened: (projectId: string) => void;
}) {
  const { meta, state } = useWorkspaceSidebar();
  const {
    showLess: showLessProjectSessions,
    showMore: showMoreProjectSessions,
    visibleCountFor: visibleProjectSessionCount
  } = useSidebarPreviewCountByKey();

  return (
    <>
      {state.projects.map((project, index) => {
        const routedProject = state.activeProjectId === project.id;
        const expanded = expandedProjectIds.has(project.id);
        const visibleSessions = project.sessions.filter((session) => !session.pinned);
        const lessTargetCount = getPreviewLessTargetCount(visibleSessions, state.activeProjectSessionId);
        const visibleSessionCount = visibleProjectSessionCount(project.id);
        const displayedSessions = visibleSessions.slice(0, visibleSessionCount);
        const canShowMoreProjectSessions = visibleSessionCount < visibleSessions.length;
        const canShowLessProjectSessions = visibleSessionCount > lessTargetCount;
        return (
          <div
            className="group/project-tree"
            key={project.id}
          >
            <ProjectTreeRow
              expanded={expanded}
              index={index}
              onProjectSessionOpened={onProjectSessionOpened}
              onToggleProjectExpanded={onToggleProjectExpanded}
              project={project}
              routedProject={routedProject}
            />
            <CollapsiblePresence collapsed={!expanded}>
              <div
                aria-label={project.name}
                className="mt-0.5 flex flex-col gap-0.5 pb-1"
                role="tree"
              >
                {visibleSessions.length === 0 ? (
                  <p className="px-2 py-1.5 text-muted-foreground text-xs">{meta.t('web.sidebar.noSessions')}</p>
                ) : null}
                {displayedSessions.map((session) => (
                  <ProjectSessionTreeRow
                    active={state.activeProjectSessionId === session.id}
                    key={session.id}
                    projectId={project.id}
                    session={session}
                  />
                ))}
                <SidebarMoreLessControls
                  canShowLess={canShowLessProjectSessions}
                  canShowMore={canShowMoreProjectSessions}
                  lessLabel={meta.t('web.sidebar.less')}
                  moreLabel={meta.t('web.sidebar.more')}
                  onShowLess={() => showLessProjectSessions(project.id, lessTargetCount)}
                  onShowMore={() => showMoreProjectSessions(project.id)}
                />
              </div>
            </CollapsiblePresence>
          </div>
        );
      })}
      {state.projects.length === 0 && (
        <p className="px-2 py-2 text-muted-foreground text-xs">{meta.t('web.workplace.noProjects')}</p>
      )}
    </>
  );
}

export function PinnedSessionList({
  onProjectSessionOpened,
  sessions
}: {
  onProjectSessionOpened: (projectId: string) => void;
  sessions: PinnedSessionItem[];
}) {
  const { state } = useWorkspaceSidebar();
  return (
    <>
      {sessions.map((item) => {
        const active = state.activeProjectSessionId === item.session.id;
        return (
          <div
            className="group/project-tree"
            key={`${item.projectId}:${item.session.id}`}
          >
            <PinnedSessionTreeRow
              active={active}
              item={item}
              onProjectSessionOpened={onProjectSessionOpened}
            />
          </div>
        );
      })}
    </>
  );
}
