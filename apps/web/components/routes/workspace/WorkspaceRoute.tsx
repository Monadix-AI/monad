'use client';

import type { Session, SessionId } from '@monad/protocol';

import { useListWorkspaceExperiencesQuery } from '@monad/client-rtk';
import { useState } from 'react';

import { WorkspaceHome } from '@/components/WorkspaceHome';
import { listProjectExperiences, toProjectExperienceDefinitions } from '@/components/workplace/experiences/registry';
import { Workplace } from '@/components/workplace/Workplace';
import { ProjectTopBar } from './ProjectTopBar';
import { useProjectViewMode } from './use-project-view-mode';

interface WorkspaceRouteProps {
  activeProjectId: string | null;
  agentSession: Session | null;
  projects: { id: string; name: string }[];
  onNewAgentChat: () => void;
  onNewProject: () => void;
  onOpenAgentChat: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenSettings: () => void;
  onOpenStudio: () => void;
}

export function WorkspaceRoute({
  activeProjectId,
  agentSession,
  projects,
  onNewAgentChat,
  onNewProject,
  onOpenAgentChat,
  onOpenProject,
  onOpenSettings,
  onOpenStudio
}: WorkspaceRouteProps) {
  const [mode, setMode] = useProjectViewMode(activeProjectId);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const { data: workspaceExperiences } = useListWorkspaceExperiencesQuery(undefined, { skip: !activeProjectId });
  const experiences = listProjectExperiences(toProjectExperienceDefinitions(workspaceExperiences?.experiences ?? []));
  const projectName = projects.find((p) => p.id === activeProjectId)?.name ?? activeProjectId ?? 'Project';

  if (activeProjectId) {
    const openProjectSettings = () => {
      setProjectSettingsOpen(true);
    };

    // The active project experience owns the whole workplace region below the top bar, including its
    // composer and secondary rails. The top bar stays host-owned so runtime switching remains stable.
    return (
      <>
        <style>{`
          .g1-chatroom { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
          .g1-chatroom-body { flex: 1; min-height: 0; display: flex; overflow: hidden; }
        `}</style>
        <div className="g1-chatroom">
          <ProjectTopBar
            experiences={experiences}
            mode={mode}
            onModeChange={setMode}
            onOpenSettings={openProjectSettings}
            projectName={projectName}
            sessionId={activeProjectId as SessionId}
            status="Active"
          />
          <div className="g1-chatroom-body">
            <Workplace
              embedded
              experiences={experiences}
              key={activeProjectId}
              mode={mode}
              onModeChange={setMode}
              onProjectSettingsOpenChange={setProjectSettingsOpen}
              projectId={activeProjectId}
              projectSettingsOpen={projectSettingsOpen}
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
