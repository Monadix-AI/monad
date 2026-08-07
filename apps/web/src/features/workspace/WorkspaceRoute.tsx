import type { Agent, Session, SessionId } from '@monad/protocol';
import type { ProjectExperienceDefinition } from '#/features/workplace/experiences/types';
import type { ProjectController } from '#/features/workplace/use-project';

import { useListWorkplaceExperiencesQuery } from '@monad/client-rtk';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { listProjectExperiences, toProjectExperienceDefinitions } from '#/features/workplace/experiences/registry';
import { Workplace } from '#/features/workplace/Workplace';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import { deriveProjectRouteSessionState } from './project-route-session-state';
import { useProjectViewMode } from './use-project-view-mode';
import { WorkspaceHome } from './WorkspaceHome';

const PROJECT_KEEP_ALIVE_LIMIT = 3;
const PROJECT_KEEP_ALIVE_TTL_MS = 2 * 60 * 1000;
const PROJECT_KEEP_ALIVE_SWEEP_MS = 30 * 1000;

interface CachedProjectEntry {
  lastActiveAt: number;
  projectId: string;
}

interface CachedProjectWorkplaceProps {
  active: boolean;
  activeProjectSessionId: SessionId | null;
  activeProjectSurface: 'workplace' | 'project-settings';
  experiences: ProjectExperienceDefinition[];
  experiencesLoading: boolean;
  mode: string;
  onModeChange: (mode: string) => void;
  onProjectControllerChange?: (project: ProjectController) => void;
  onProjectDeleted: () => void;
  projectId: string;
  voiceModelState: 'checking' | 'configured' | 'missing' | 'failed';
}

export interface WorkspaceRouteProps {
  activeProjectId: string | null;
  activeProjectSessionId: SessionId | null;
  activeProjectSurface?: 'workplace' | 'project-settings';
  agents: Agent[];
  chatSessions: Pick<Session, 'id' | 'title'>[];
  projects: { id: string; name: string; cwd?: string; sessions?: { id: SessionId; title: string }[] }[];
  onProjectDeleted: () => void;
  onOpenSettings: () => void;
  onOpenStudio: () => void;
  voiceModelState?: 'checking' | 'configured' | 'missing' | 'failed';
}

export function WorkspaceRoute({
  activeProjectId,
  activeProjectSessionId,
  activeProjectSurface = 'workplace',
  projects,
  onProjectDeleted,
  voiceModelState = 'checking'
}: WorkspaceRouteProps) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [preferredMode, setMode] = useProjectViewMode(activeProjectId);
  const [cachedProjectEntries, setCachedProjectEntries] = useState<CachedProjectEntry[]>([]);
  const setActiveProjectSession = useWorkspaceShellStore((state) => state.setActiveProjectSession);
  const { data: workplaceExperiences, isLoading: workplaceExperiencesLoading } = useListWorkplaceExperiencesQuery(
    undefined,
    { skip: !activeProjectId }
  );
  const experiences = useMemo(
    () => listProjectExperiences(toProjectExperienceDefinitions(workplaceExperiences?.experiences ?? [])),
    [workplaceExperiences?.experiences]
  );
  const mode = experiences.some((experience) => experience.id === preferredMode)
    ? (preferredMode as string)
    : (experiences[0]?.id ?? '');
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const routedProjectSessionState = activeProject
    ? deriveProjectRouteSessionState(
        {
          activeSessionId: activeProjectSessionId,
          projectSessions: activeProject.sessions ?? []
        },
        activeProjectSessionId
      )
    : { activeSessionId: null, activeSessionTitle: null };
  const visibleActiveSessionId = routedProjectSessionState.activeSessionId ?? (activeSessionId as SessionId | null);
  const updateActiveProjectRouteState = useCallback(
    (project: ProjectController) => {
      const next = deriveProjectRouteSessionState(project, activeProjectSessionId);
      setActiveSessionId((current) => (current === next.activeSessionId ? current : next.activeSessionId));
    },
    [activeProjectSessionId]
  );
  const handleProjectDeleted = useCallback(
    (projectId: string) => {
      setCachedProjectEntries((entries) => entries.filter((entry) => entry.projectId !== projectId));
      onProjectDeleted();
    },
    [onProjectDeleted]
  );
  useEffect(() => {
    if (!activeProjectId) {
      setActiveProjectSession(null);
      return;
    }
    setActiveProjectSession({
      activeSessionId: visibleActiveSessionId,
      projectId: activeProjectId
    });
  }, [activeProjectId, setActiveProjectSession, visibleActiveSessionId]);

  useEffect(() => () => setActiveProjectSession(null), [setActiveProjectSession]);

  // Resets transient active-project UI state on a real project switch only — deliberately keyed on
  // `activeProjectId` alone. `projects` must NOT be a dependency here: its array reference changes on
  // any unrelated activity-badge recompute (e.g. a session list mutation from the tab strip below),
  // which would otherwise wipe activeProjectSessions with nothing left to repopulate it.
  useEffect(() => {
    setActiveSessionId(null);
    if (!activeProjectId) setCachedProjectEntries([]);
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    const projectIds = new Set(projects.map((project) => project.id));
    const now = Date.now();
    setCachedProjectEntries((entries) => {
      const previousActiveProjectId = entries[0]?.projectId;
      const existing = entries
        .filter((entry) => entry.projectId !== activeProjectId && projectIds.has(entry.projectId))
        .map((entry) => (entry.projectId === previousActiveProjectId ? { ...entry, lastActiveAt: now } : entry));
      return [{ projectId: activeProjectId, lastActiveAt: now }, ...existing].slice(0, PROJECT_KEEP_ALIVE_LIMIT);
    });
  }, [activeProjectId, projects]);

  useEffect(() => {
    if (!activeProjectId) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setCachedProjectEntries((entries) =>
        entries.filter(
          (entry) => entry.projectId === activeProjectId || now - entry.lastActiveAt <= PROJECT_KEEP_ALIVE_TTL_MS
        )
      );
    }, PROJECT_KEEP_ALIVE_SWEEP_MS);
    return () => window.clearInterval(interval);
  }, [activeProjectId]);

  if (activeProjectId) {
    return (
      <>
        <style>{`
          .g1-workspace { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
          .g1-workspace-canvas { flex: 1; min-height: 0; display: flex; overflow: hidden; }
          .g1-workspace-project-pane { flex: 1; min-height: 0; min-width: 0; display: none; }
          .g1-workspace-project-pane[data-active="true"] { display: flex; }
        `}</style>
        <div className="g1-workspace">
          <div className="g1-workspace-canvas">
            {cachedProjectEntries.map((entry) => {
              const active = entry.projectId === activeProjectId;
              return (
                <div
                  aria-hidden={!active}
                  className="g1-workspace-project-pane"
                  data-active={active ? 'true' : 'false'}
                  key={entry.projectId}
                >
                  <CachedProjectWorkplace
                    active={active}
                    activeProjectSessionId={active ? activeProjectSessionId : null}
                    activeProjectSurface={active ? activeProjectSurface : 'workplace'}
                    experiences={experiences}
                    experiencesLoading={workplaceExperiencesLoading}
                    mode={mode}
                    onModeChange={setMode}
                    onProjectControllerChange={active ? updateActiveProjectRouteState : undefined}
                    onProjectDeleted={() => handleProjectDeleted(entry.projectId)}
                    projectId={entry.projectId}
                    voiceModelState={voiceModelState}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  }

  return (
    <WorkspaceHome
      activeProjectId={activeProjectId}
      projects={projects}
    />
  );
}

const CachedProjectWorkplace = memo(function CachedProjectWorkplace({
  active,
  activeProjectSessionId,
  activeProjectSurface,
  experiences,
  experiencesLoading,
  mode,
  onModeChange,
  onProjectControllerChange,
  onProjectDeleted,
  projectId,
  voiceModelState
}: CachedProjectWorkplaceProps) {
  const handleProjectControllerChange = useCallback(
    (project: ProjectController) => {
      onProjectControllerChange?.(project);
    },
    [onProjectControllerChange]
  );

  return (
    <Workplace
      embedded
      experiences={experiences}
      experiencesLoading={experiencesLoading}
      mode={mode}
      onModeChange={active ? onModeChange : undefined}
      onProjectControllerChange={handleProjectControllerChange}
      onProjectDeleted={onProjectDeleted}
      projectId={projectId}
      routedSessionId={activeProjectSessionId}
      surface={activeProjectSurface}
      voiceModelState={voiceModelState}
    />
  );
}, areCachedProjectWorkplacePropsEqual);

function areCachedProjectWorkplacePropsEqual(
  prev: CachedProjectWorkplaceProps,
  next: CachedProjectWorkplaceProps
): boolean {
  return (
    prev.active === next.active &&
    prev.activeProjectSessionId === next.activeProjectSessionId &&
    prev.activeProjectSurface === next.activeProjectSurface &&
    prev.experiences === next.experiences &&
    prev.experiencesLoading === next.experiencesLoading &&
    prev.mode === next.mode &&
    prev.onModeChange === next.onModeChange &&
    prev.onProjectControllerChange === next.onProjectControllerChange &&
    prev.onProjectDeleted === next.onProjectDeleted &&
    prev.projectId === next.projectId &&
    prev.voiceModelState === next.voiceModelState
  );
}
