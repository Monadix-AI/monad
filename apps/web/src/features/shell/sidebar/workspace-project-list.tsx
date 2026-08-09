import { useReorderWorkplaceProjectMutation } from '@monad/client-rtk';
import { cn } from '@monad/ui';
import { memo, useState } from 'react';

import { DeleteProjectDialog } from '#/features/workplace/DeleteProjectDialog';
import { CollapsiblePresence } from './collapsible-presence';
import {
  closestProjectDropBreakpoint,
  projectOrderDestination,
  readProjectDragId,
  writeProjectDragId
} from './project-order-drag-state';
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

export const ProjectList = memo(function ProjectList({
  expandedProjectIds,
  onToggleProjectExpanded
}: {
  expandedProjectIds: ReadonlySet<string>;
  onToggleProjectExpanded: (id: string) => void;
}) {
  const { actions, meta, state } = useWorkspaceSidebar();
  const [reorderProject] = useReorderWorkplaceProjectMutation();
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [dropBeforeProjectId, setDropBeforeProjectId] = useState<string | null | undefined>(undefined);
  const [projectToDelete, setProjectToDelete] = useState<{ id: string; name: string } | null>(null);
  const {
    showLess: showLessProjectSessions,
    showMore: showMoreProjectSessions,
    visibleCountFor: visibleProjectSessionCount
  } = useSidebarPreviewCountByKey();

  const dropBeforeAtPointer = (container: HTMLDivElement, pointerY: number): string | null | undefined =>
    closestProjectDropBreakpoint(
      [...container.querySelectorAll<HTMLElement>('[data-project-drop-before]')].map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          beforeProjectId: element.dataset.projectDropBefore || null,
          y: rect.top + rect.height / 2
        };
      }),
      pointerY
    );

  const finishDrop = (draggedProjectId: string, beforeProjectId: string | null | undefined): void => {
    if (beforeProjectId === undefined) return;
    const destination = projectOrderDestination(
      state.projects.map((candidate) => candidate.id),
      draggedProjectId,
      beforeProjectId
    );
    if (destination) {
      void reorderProject({
        projectId: draggedProjectId as `prj_${string}`,
        expectedRevision: state.projectOrderRevision,
        ...(destination as { beforeProjectId: `prj_${string}` } | { afterProjectId: `prj_${string}` })
      });
    }
    setDraggingProjectId(null);
    setDropBeforeProjectId(undefined);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the list is a native drag surface that snaps releases to project breakpoints.
    <div
      className="contents"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropBeforeProjectId(dropBeforeAtPointer(event.currentTarget, event.clientY));
      }}
      onDrop={(event) => {
        event.preventDefault();
        const draggedProjectId = readProjectDragId(event.dataTransfer) ?? draggingProjectId;
        if (!draggedProjectId) return;
        finishDrop(draggedProjectId, dropBeforeAtPointer(event.currentTarget, event.clientY));
      }}
    >
      {state.projects.map((project) => {
        const expanded = expandedProjectIds.has(project.id);
        const visibleSessions = project.sessions.filter((session) => !session.pinned);
        const lessTargetCount = getPreviewLessTargetCount(visibleSessions, state.activeProjectSessionId);
        const visibleSessionCount = visibleProjectSessionCount(project.id);
        const displayedSessions = visibleSessions.slice(0, visibleSessionCount);
        const canShowMoreProjectSessions = visibleSessionCount < visibleSessions.length;
        const canShowLessProjectSessions = visibleSessionCount > lessTargetCount;
        return (
          <div key={project.id}>
            <ProjectDropBreakpoint
              active={dropBeforeProjectId === project.id}
              beforeProjectId={project.id}
            />
            {/* biome-ignore lint/a11y/noStaticElementInteractions: native drag source wraps the complete project block; row controls retain their own semantics. */}
            <div
              className={cn('group/project-tree', draggingProjectId === project.id && 'opacity-35')}
              draggable
              onDragEnd={() => {
                setDraggingProjectId(null);
                setDropBeforeProjectId(undefined);
              }}
              onDragStart={(event) => {
                setDraggingProjectId(project.id);
                event.dataTransfer.effectAllowed = 'move';
                writeProjectDragId(event.dataTransfer, project.id);
                const card = document.createElement('div');
                card.textContent = `📁  ${project.name}`;
                Object.assign(card.style, {
                  background: 'Canvas',
                  border: '1px solid color-mix(in srgb, CanvasText 12%, transparent)',
                  borderRadius: '10px',
                  color: 'CanvasText',
                  font: '500 13px system-ui',
                  maxWidth: '220px',
                  overflow: 'hidden',
                  padding: '8px 12px',
                  position: 'fixed',
                  textOverflow: 'ellipsis',
                  top: '-1000px',
                  whiteSpace: 'nowrap'
                });
                document.body.append(card);
                event.dataTransfer.setDragImage(card, 18, 18);
                requestAnimationFrame(() => card.remove());
              }}
            >
              <ProjectTreeRow
                expanded={expanded}
                onDelete={setProjectToDelete}
                onToggleProjectExpanded={onToggleProjectExpanded}
                project={project}
              />
              <CollapsiblePresence collapsed={!expanded}>
                <div
                  aria-label={project.name}
                  className="mt-px flex flex-col gap-px pb-1"
                  role="tree"
                >
                  {visibleSessions.length === 0 ? (
                    <p className="py-1.5 pr-2 pl-5 text-muted-foreground text-xs">{meta.t('web.sidebar.noSessions')}</p>
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
          </div>
        );
      })}
      {state.projects.length > 0 ? (
        <ProjectDropBreakpoint
          active={dropBeforeProjectId === null}
          beforeProjectId={null}
        />
      ) : null}
      {state.projects.length === 0 && (
        <p className="px-2 py-2 text-muted-foreground text-xs">{meta.t('web.workplace.noProjects')}</p>
      )}
      <DeleteProjectDialog
        onConfirm={() => Promise.resolve(projectToDelete ? actions.deleteProject(projectToDelete.id) : undefined)}
        onOpenChange={(open) => {
          if (!open) setProjectToDelete(null);
        }}
        open={projectToDelete !== null}
        projectName={projectToDelete?.name ?? ''}
      />
    </div>
  );
});

function ProjectDropBreakpoint({ active, beforeProjectId }: { active: boolean; beforeProjectId: string | null }) {
  return (
    <div
      className="relative h-1"
      data-project-drop-before={beforeProjectId ?? ''}
    >
      <span
        className={cn(
          'pointer-events-none absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-primary transition-opacity',
          active ? 'opacity-100' : 'opacity-0'
        )}
      />
    </div>
  );
}

export const PinnedSessionList = memo(function PinnedSessionList({
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
});
