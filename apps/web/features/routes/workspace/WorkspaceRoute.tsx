'use client';

import type { ProjectId, Session } from '@monad/protocol';
import type { ProjectController } from '@/features/workplace/use-project';

import { useListWorkspaceExperiencesQuery } from '@monad/client-rtk';
import { useCallback, useState } from 'react';

import { listProjectExperiences, toProjectExperienceDefinitions } from '@/features/workplace/experiences/registry';
import { Workplace } from '@/features/workplace/Workplace';
import { useWorkplaceUiStore } from '@/features/workplace/workplace-ui-store';
import { ProjectTopBar } from './ProjectTopBar';
import { useProjectViewMode } from './use-project-view-mode';
import { WorkspaceHome } from './WorkspaceHome';

interface WorkspaceRouteProps {
  activeProjectId: string | null;
  agentSession: Session | null;
  projects: { id: string; name: string; cwd?: string }[];
  onNewAgentChat: () => void;
  onNewProject: () => void;
  onOpenAgentChat: () => void;
  onOpenProject: (projectId: string) => void;
  onProjectDeleted: () => void;
  onOpenSettings: () => void;
  onOpenStudio: () => void;
  voiceModelState?: 'checking' | 'configured' | 'missing' | 'failed';
}

export function WorkspaceRoute({
  activeProjectId,
  agentSession,
  projects,
  onNewAgentChat,
  onNewProject,
  onOpenAgentChat,
  onOpenProject,
  onProjectDeleted,
  onOpenSettings,
  onOpenStudio,
  voiceModelState = 'checking'
}: WorkspaceRouteProps) {
  const [preferredMode, setMode] = useProjectViewMode(activeProjectId);
  const [activeProjectController, setActiveProjectController] = useState<ProjectController | null>(null);
  const openProjectSettingsInStore = useWorkplaceUiStore((state) => state.openProjectSettings);
  const { data: workspaceExperiences } = useListWorkspaceExperiencesQuery(undefined, { skip: !activeProjectId });
  const experiences = listProjectExperiences(toProjectExperienceDefinitions(workspaceExperiences?.experiences ?? []));
  const mode = experiences.some((experience) => experience.id === preferredMode)
    ? (preferredMode as string)
    : (experiences[0]?.id ?? '');
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const projectName = activeProject?.name ?? activeProjectId ?? 'Project';
  const openProjectSettings = useCallback(() => {
    if (activeProjectId) openProjectSettingsInStore(activeProjectId);
  }, [activeProjectId, openProjectSettingsInStore]);
  const updateProjectController = useCallback((project: ProjectController) => {
    setActiveProjectController(project);
  }, []);

  if (activeProjectId) {
    // The active project experience owns the whole workplace region below the top bar, including its
    // composer and secondary rails. The top bar stays host-owned so runtime switching remains stable.
    return (
      <>
        <style>{`
          .g1-workspace { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
          .g1-workspace-canvas { flex: 1; min-height: 0; display: flex; overflow: hidden; }
        `}</style>
        <div className="g1-workspace">
          <ProjectTopBar
            experiences={experiences}
            mode={mode}
            onModeChange={setMode}
            onOpenSettings={openProjectSettings}
            participants={activeProjectController?.participants ?? []}
            projectId={activeProjectId as ProjectId}
            projectName={projectName}
            projectWorkdir={activeProject?.cwd}
          />
          <div className="g1-workspace-canvas">
            <Workplace
              embedded
              experiences={experiences}
              key={activeProjectId}
              mode={mode}
              onModeChange={setMode}
              onProjectControllerChange={updateProjectController}
              onProjectDeleted={onProjectDeleted}
              projectId={activeProjectId}
              voiceModelState={voiceModelState}
            />
          </div>
        </div>
      </>
    );
  }

  return (
    <WorkspaceHome
      activeProjectId={activeProjectId}
      agentSession={agentSession}
      onNewAgentChat={onNewAgentChat}
      onNewProject={onNewProject}
      onOpenAgentChat={onOpenAgentChat}
      onOpenProject={onOpenProject}
      onOpenSettings={onOpenSettings}
      onOpenStudio={onOpenStudio}
      projects={projects}
    />
  );
}
