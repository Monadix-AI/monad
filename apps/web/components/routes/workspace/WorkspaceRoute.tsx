'use client';

import type { Session, SessionId } from '@monad/protocol';

import { useState } from 'react';

import { WorkspaceHome } from '@/components/WorkspaceHome';
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
  const projectName = projects.find((p) => p.id === activeProjectId)?.name ?? activeProjectId ?? 'Project';

  if (activeProjectId) {
    const openProjectSettings = () => {
      setMode('chat');
      setProjectSettingsOpen(true);
    };

    // Both view modes share the same host chrome (top bar + Workplace shell); only the body preset
    // differs (chat transcript vs. live agent graph), resolved by Workplace via getPreset(mode).
    return (
      <>
        <style>{`
          .g1-chatroom { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
          .g1-chatroom-body { flex: 1; min-height: 0; display: flex; overflow: hidden; }
        `}</style>
        <div className="g1-chatroom">
          <ProjectTopBar
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
              key={activeProjectId}
              mode={mode}
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
