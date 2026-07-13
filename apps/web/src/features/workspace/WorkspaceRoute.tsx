'use client';

import type { Agent, ProjectId, Session, SessionId } from '@monad/protocol';
import type { ProjectExperienceDefinition } from '#/features/workplace/experiences/types';
import type { ProjectController } from '#/features/workplace/use-project';

import { useListWorkspaceExperiencesQuery } from '@monad/client-rtk';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { listProjectExperiences, toProjectExperienceDefinitions } from '#/features/workplace/experiences/registry';
import { Workplace } from '#/features/workplace/Workplace';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import { ProjectTopBar } from './ProjectTopBar';
import { useProjectViewMode } from './use-project-view-mode';
import { WorkspaceHome } from './WorkspaceHome';

const PROJECT_KEEP_ALIVE_LIMIT = 3;
const PROJECT_KEEP_ALIVE_TTL_MS = 2 * 60 * 1000;
const PROJECT_KEEP_ALIVE_SWEEP_MS = 30 * 1000;
const EMPTY_PROJECT_PARTICIPANTS: ProjectController['participants'] = [];
const PARTICIPANT_FIELD_SEPARATOR = '\u0000';
const PARTICIPANT_ROW_SEPARATOR = '\u0001';

interface CachedProjectEntry {
  lastActiveAt: number;
  projectId: string;
}

interface ActiveProjectParticipants {
  participants: ProjectController['participants'];
  signature: string;
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
  projects: { id: string; name: string; cwd?: string; sessions?: { id: SessionId }[] }[];
  onOpenProjectSettings: (projectId: string) => void;
  onProjectDeleted: () => void;
  onOpenSettings: () => void;
  onOpenStudio: () => void;
  voiceModelState?: 'checking' | 'configured' | 'missing' | 'failed';
}

function participantsSignature(participants: ProjectController['participants']): string {
  return participants
    .map((participant) =>
      [
        participant.id,
        participant.kind,
        participant.name,
        participant.avatarUrl ?? '',
        participant.icon ?? '',
        JSON.stringify(participant.av ?? null)
      ].join(PARTICIPANT_FIELD_SEPARATOR)
    )
    .join(PARTICIPANT_ROW_SEPARATOR);
}

export function WorkspaceRoute({
  activeProjectId,
  activeProjectSessionId,
  activeProjectSurface = 'workplace',
  agents,
  projects,
  onOpenProjectSettings,
  onProjectDeleted,
  onOpenSettings,
  onOpenStudio,
  voiceModelState = 'checking'
}: WorkspaceRouteProps) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionTitle, setActiveSessionTitle] = useState<string | null>(null);
  const [preferredMode, setMode] = useProjectViewMode(activeProjectId, activeSessionId);
  const [activeProjectParticipants, setActiveProjectParticipants] = useState<ActiveProjectParticipants>({
    participants: EMPTY_PROJECT_PARTICIPANTS,
    signature: ''
  });
  const [cachedProjectEntries, setCachedProjectEntries] = useState<CachedProjectEntry[]>([]);
  const setActiveProjectSession = useWorkspaceShellStore((state) => state.setActiveProjectSession);
  const { data: workspaceExperiences, isLoading: workspaceExperiencesLoading } = useListWorkspaceExperiencesQuery(
    undefined,
    { skip: !activeProjectId }
  );
  const experiences = useMemo(
    () => listProjectExperiences(toProjectExperienceDefinitions(workspaceExperiences?.experiences ?? [])),
    [workspaceExperiences?.experiences]
  );
  const mode = experiences.some((experience) => experience.id === preferredMode)
    ? (preferredMode as string)
    : (experiences[0]?.id ?? '');
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const projectName = activeProject?.name ?? activeProjectId ?? 'Project';
  const openProjectSettings = useCallback(() => {
    if (activeProjectId) onOpenProjectSettings(activeProjectId);
  }, [activeProjectId, onOpenProjectSettings]);
  const updateActiveProjectParticipants = useCallback(
    (project: ProjectController) => {
      const signature = participantsSignature(project.participants);
      setActiveProjectParticipants((current) =>
        current.signature === signature ? current : { participants: project.participants, signature }
      );
      if (
        activeProjectSessionId &&
        project.activeSessionId !== activeProjectSessionId &&
        project.projectSessions.some((session) => session.id === activeProjectSessionId)
      ) {
        const routedSession = project.projectSessions.find((session) => session.id === activeProjectSessionId);
        setActiveSessionId((current) => (current === activeProjectSessionId ? current : activeProjectSessionId));
        setActiveSessionTitle((current) => {
          const next = routedSession?.title ?? null;
          return current === next ? current : next;
        });
        return;
      }
      setActiveSessionId((current) => (current === null ? current : null));
      setActiveSessionTitle((current) => (current === null ? current : null));
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
      activeSessionId: activeSessionId as SessionId | null,
      projectId: activeProjectId
    });
  }, [activeProjectId, activeSessionId, setActiveProjectSession]);

  useEffect(() => () => setActiveProjectSession(null), [setActiveProjectSession]);

  // Resets transient active-project UI state on a real project switch only — deliberately keyed on
  // `activeProjectId` alone. `projects` must NOT be a dependency here: its array reference changes on
  // any unrelated activity-badge recompute (e.g. a session list mutation from the tab strip below),
  // which would otherwise wipe activeProjectSessions with nothing left to repopulate it.
  useEffect(() => {
    setActiveProjectParticipants({ participants: EMPTY_PROJECT_PARTICIPANTS, signature: '' });
    setActiveSessionId(null);
    setActiveSessionTitle(null);
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
    // The active project experience owns the whole workplace region below the top bar, including its
    // composer and secondary rails. The top bar stays host-owned so runtime switching remains stable.
    return (
      <>
        <style>{`
          .g1-workspace { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
          .g1-workspace-canvas { flex: 1; min-height: 0; display: flex; overflow: hidden; }
          .g1-workspace-project-pane { flex: 1; min-height: 0; min-width: 0; display: none; }
          .g1-workspace-project-pane[data-active="true"] { display: flex; }
        `}</style>
        <div className="g1-workspace">
          <ProjectTopBar
            experiences={experiences}
            mode={mode}
            onModeChange={setMode}
            onOpenSettings={openProjectSettings}
            participants={activeProjectParticipants.participants}
            projectId={activeProjectId as ProjectId}
            projectName={projectName}
            projectWorkdir={activeProject?.cwd}
            sessionId={activeSessionId as SessionId | null}
            sessionTitle={activeSessionTitle}
          />
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
                    experiencesLoading={workspaceExperiencesLoading}
                    mode={mode}
                    onModeChange={setMode}
                    onProjectControllerChange={active ? updateActiveProjectParticipants : undefined}
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
      agents={agents}
      onOpenSettings={onOpenSettings}
      onOpenStudio={onOpenStudio}
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
