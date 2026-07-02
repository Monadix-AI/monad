'use client';

import type { CSSProperties } from 'react';
import type { ProjectExperienceDefinition } from './experiences/types';
import type { ProjectController } from './use-project';

import { useStartNativeCliAuthMutation } from '@monad/client-rtk';
import { useCallback, useEffect, useMemo } from 'react';

import { useT } from '@/components/I18nProvider';
import { NativeCliAuthModal } from './cli/NativeCliAuthModal';
import { getProjectExperience } from './experiences/registry';
import { toExperienceRuntime } from './experiences/to-runtime';
import { ProjectMemberDialog } from './project-shell/ProjectMemberDialog';
import { ProjectRail } from './project-shell/ProjectRail';
import { ProjectSettings } from './project-shell/ProjectSettings';
import { boxR, mono, sans } from './styles';
import { useProject } from './use-project';
import { useWorkplaceUiStore } from './workplace-ui-store';

export function Workplace({
  projectId,
  embedded = false,
  mode = 'chat',
  experiences,
  onModeChange,
  onProjectControllerChange,
  onProjectDeleted
}: {
  projectId: string;
  embedded?: boolean;
  mode?: string;
  experiences?: ProjectExperienceDefinition[];
  onModeChange?: (mode: string) => void;
  onProjectControllerChange?: (project: ProjectController) => void;
  onProjectDeleted?: () => void;
}): React.ReactElement {
  const project = useProject(projectId);
  const t = useT();
  const [startNativeCliAuth] = useStartNativeCliAuthMutation();
  const openNativeCliObservation = useWorkplaceUiStore((state) => state.followNativeCliSession);
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
  const nativeCliAuthSession = useWorkplaceUiStore((state) => state.nativeCliAuthSession);
  const startingNativeCliAuthAgent = useWorkplaceUiStore((state) => state.startingNativeCliAuthAgent);
  const setNativeCliAuthSession = useWorkplaceUiStore((state) => state.setNativeCliAuthSession);
  const clearNativeCliAuthSession = useWorkplaceUiStore((state) => state.clearNativeCliAuthSession);
  const setStartingNativeCliAuthAgent = useWorkplaceUiStore((state) => state.setStartingNativeCliAuthAgent);
  const settingsOpen = projectSettings !== null;
  const closeProjectSettings = useCallback(() => {
    closeProjectSettingsInStore();
  }, [closeProjectSettingsInStore]);
  const setProjectSettingsOpen = useCallback(
    (open: boolean) => {
      if (open) openProjectSettingsInStore(projectId);
      else closeProjectSettingsInStore();
    },
    [closeProjectSettingsInStore, openProjectSettingsInStore, projectId]
  );
  const openAgentCard = useCallback(
    (memberId: string) => {
      openProjectMemberSettings(projectId, memberId);
    },
    [openProjectMemberSettings, projectId]
  );
  const followNativeCliSession = useCallback(
    (id: string) => {
      openNativeCliObservation(projectId, id);
    },
    [openNativeCliObservation, projectId]
  );
  const startNativeCliAuthForAgent = useCallback(
    (agentName: string) => {
      clearNativeCliAuthSession();
      setStartingNativeCliAuthAgent(agentName);
      startNativeCliAuth(agentName)
        .unwrap()
        .then((session) => {
          if (session.authState !== 'authenticated') {
            setNativeCliAuthSession({ id: session.id, agentName: session.agentName });
          }
        })
        .catch(() => {
          clearNativeCliAuthSession();
        })
        .finally(() => setStartingNativeCliAuthAgent(null));
    },
    [clearNativeCliAuthSession, setNativeCliAuthSession, setStartingNativeCliAuthAgent, startNativeCliAuth]
  );
  useEffect(() => {
    onProjectControllerChange?.(project);
  }, [onProjectControllerChange, project]);
  const experience = getProjectExperience(mode, experiences);
  const runtime = useMemo(
    () =>
      toExperienceRuntime(project, {
        followNativeCliSession,
        openAgentCard,
        switchExperience: onModeChange ?? (() => {})
      }),
    [project, followNativeCliSession, onModeChange, openAgentCard]
  );

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
          <a
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
          </a>
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
            background: 'var(--card)',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {!embedded ? (
            <ProjectRail
              onStartNativeCliAuth={startNativeCliAuthForAgent}
              project={project}
              startingNativeCliAuthAgent={startingNativeCliAuthAgent}
            />
          ) : null}

          {experience.render({
            embedded,
            onProjectSettingsOpenChange: setProjectSettingsOpen,
            project,
            projectSettingsOpen: settingsOpen,
            runtime,
            t
          })}
        </div>
        {settingsOpen ? (
          <ProjectSettings
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
        {nativeCliAuthSession ? (
          <NativeCliAuthModal
            agentName={nativeCliAuthSession.agentName}
            onClose={clearNativeCliAuthSession}
            sessionId={nativeCliAuthSession.id}
          />
        ) : null}
      </div>
    </div>
  );
}
