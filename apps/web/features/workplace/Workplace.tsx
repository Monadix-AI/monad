'use client';

import type { WorkspaceExperienceProjectDialogRequest } from '@monad/protocol';
import type { CSSProperties } from 'react';
import type { ProjectExperienceDefinition } from './experiences/types';
import type { ProjectController } from './use-project';

import {
  workspaceBoxRadius as boxR,
  workspaceMono as mono,
  workspaceSans as sans
} from '@monad/ui/components/AgentAvatar';
import { memo, useCallback, useEffect } from 'react';

import { ShellLink } from '@/components/ShellLink';
import { MonadLoading } from '@/features/init/MonadLoading';
import { getProjectExperience } from './experiences/registry';
import { ProjectHeader } from './project-shell/ProjectHeader';
import { ProjectMemberDialog } from './project-shell/ProjectMemberDialog';
import { ProjectSettings } from './project-shell/ProjectSettings';
import { useProject } from './use-project';
import { useWorkplaceUiStore } from './workplace-ui-store';

const noopSwitchExperience = () => {};

export const Workplace = memo(function Workplace({
  projectId,
  embedded = false,
  mode,
  experiences,
  experiencesLoading = false,
  onModeChange,
  onProjectControllerChange,
  onProjectDeleted,
  voiceModelState = 'checking'
}: {
  projectId: string;
  embedded?: boolean;
  mode?: string;
  experiences?: ProjectExperienceDefinition[];
  experiencesLoading?: boolean;
  onModeChange?: (mode: string) => void;
  onProjectControllerChange?: (project: ProjectController) => void;
  onProjectDeleted?: () => void;
  voiceModelState?: 'checking' | 'configured' | 'missing' | 'failed';
}): React.ReactElement {
  const projectSettings = useWorkplaceUiStore((state) =>
    state.projectSettings?.projectId === projectId ? state.projectSettings : null
  );
  const projectMemberSettings = useWorkplaceUiStore((state) =>
    state.projectMemberSettings?.projectId === projectId ? state.projectMemberSettings : null
  );
  const openProjectSettingsInStore = useWorkplaceUiStore((state) => state.openProjectSettings);
  const closeProjectSettingsInStore = useWorkplaceUiStore((state) => state.closeProjectSettings);
  const openProjectMemberSettings = useWorkplaceUiStore((state) => state.openProjectMemberSettings);
  const closeProjectMemberSettings = useWorkplaceUiStore((state) => state.closeProjectMemberSettings);
  const settingsOpen = projectSettings !== null;
  const closeProjectSettings = useCallback(() => {
    closeProjectSettingsInStore();
  }, [closeProjectSettingsInStore]);
  const openAgentCard = useCallback(
    (memberId: string) => {
      openProjectMemberSettings(projectId, memberId);
    },
    [openProjectMemberSettings, projectId]
  );
  const requestProjectDialog = useCallback(
    (request: WorkspaceExperienceProjectDialogRequest) => {
      if (request.type === 'project-settings') {
        if (request.open) openProjectSettingsInStore(projectId, request.intent);
        else closeProjectSettingsInStore();
        return;
      }
      if (!request.open) {
        closeProjectMemberSettings();
        return;
      }
      if (request.memberId) openProjectMemberSettings(projectId, request.memberId);
    },
    [
      closeProjectMemberSettings,
      closeProjectSettingsInStore,
      openProjectMemberSettings,
      openProjectSettingsInStore,
      projectId
    ]
  );
  const project = useProject(projectId, {
    openAgentCard,
    switchExperience: onModeChange ?? noopSwitchExperience
  });
  useEffect(() => {
    onProjectControllerChange?.(project);
  }, [onProjectControllerChange, project]);
  const experience = getProjectExperience(mode, experiences);

  return (
    <div
      style={
        {
          minHeight: embedded ? '100%' : '100vh',
          height: embedded ? '100%' : undefined,
          flex: embedded ? 1 : undefined,
          minWidth: embedded ? 0 : undefined,
          background: embedded ? 'transparent' : 'var(--background)',
          padding: embedded ? 0 : '18px 24px 32px',
          boxSizing: 'border-box',
          overflow: embedded ? 'hidden' : undefined,
          display: 'flex',
          flexDirection: 'column',
          fontFamily: sans,
          color: 'var(--foreground)',
          WebkitFontSmoothing: 'antialiased'
        } as CSSProperties
      }
    >
      {!embedded ? (
        <div
          style={{
            maxWidth: 1360,
            margin: '0 auto 12px',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 24,
            flexWrap: 'wrap'
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 1.2,
                textTransform: 'uppercase',
                fontFamily: mono,
                color: 'var(--muted-foreground)'
              }}
            >
              Workplace
            </div>
            <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.15, marginTop: 4 }}>
              Agent project <span style={{ color: 'var(--muted-foreground)', fontWeight: 400 }}>workplace</span>
            </div>
          </div>
          <ShellLink
            href="/"
            style={{
              fontFamily: mono,
              fontSize: 11,
              color: 'var(--muted-foreground)',
              textDecoration: 'none',
              border: `1px solid ${'var(--border)'}`,
              borderRadius: 8,
              padding: '6px 12px',
              background: 'var(--card)',
              whiteSpace: 'nowrap'
            }}
          >
            ← back to workspace
          </ShellLink>
        </div>
      ) : null}

      <div
        style={{
          maxWidth: embedded ? '100%' : 1360,
          margin: embedded ? 0 : '0 auto',
          border: embedded ? 0 : `1px solid ${'var(--border)'}`,
          borderRadius: embedded ? 0 : boxR,
          background: 'var(--card)',
          overflow: 'hidden',
          boxShadow: embedded ? 'none' : 'var(--shadow-lg)',
          height: '100%',
          minHeight: 0,
          position: 'relative'
        }}
      >
        <div
          className="workplace-layout"
          style={{
            height: embedded ? '100%' : 'min(780px, calc(100vh - 102px))',
            minHeight: embedded ? undefined : 620,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--card)',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {!embedded ? <ProjectHeader project={project} /> : null}
          {experience ? (
            experience.render({
              embedded,
              onProjectDialogRequest: requestProjectDialog,
              runtime: project.experienceRuntime,
              voiceModelState
            })
          ) : experiencesLoading ? (
            <MonadLoading className="min-h-0 flex-1" />
          ) : null}
        </div>
        {settingsOpen ? (
          <ProjectSettings
            initialIntent={projectSettings.intent}
            onClose={closeProjectSettings}
            onDeleted={onProjectDeleted}
            room={project}
          />
        ) : null}
        <ProjectMemberDialog
          memberId={projectMemberSettings?.memberId ?? null}
          onClose={closeProjectMemberSettings}
          room={project}
        />
      </div>
    </div>
  );
});
