'use client';

import type { SessionId } from '@monad/protocol';
import type { ComponentProps, ReactNode } from 'react';
import type { SessionRouteProps } from '#/features/routes/sessions/SessionRoute';
import type { WorkspaceRouteProps } from '#/features/routes/workspace/WorkspaceRoute';
import type { SettingsSectionId } from '#/features/settings/sections';
import type { ShellRoute } from '#/features/shell/routing/use-shell-route';
import type { StudioSectionId } from '#/features/studio/sections';

import { useInitStatusQuery } from '@monad/client-rtk';
import { createContext, useContext, useMemo } from 'react';

import { isRuntimeReady } from '#/features/init/init-readiness';
import { useSessionRouteModel } from '#/features/routes/sessions/use-session-route-model';
import { Settings } from '#/features/settings/Settings';
import { useAppShellNavigation } from '#/features/shell/routing/navigation';
import { useShellRoute } from '#/features/shell/routing/use-shell-route';
import { SessionSidebar } from '#/features/shell/SessionSidebar';
import { useAppShellData } from '#/features/shell/useAppShellData';
import { useMonadRuntime } from '#/lib/monad-runtime-provider';
import { useWorkspaceShellStore, type WorkspaceShellState } from '#/lib/workspace-shell-store';

type ShellRouteContextValue = {
  currentSessionId: SessionId | null;
  frame: {
    isWorkspaceHome: boolean;
    reserveHeaderLeading: boolean;
  };
  onCloseStudio: () => void;
  sessionRouteProps: Omit<SessionRouteProps, 'currentSessionId'>;
  settingsRouteProps: ComponentProps<typeof Settings>;
  shellRoute: ShellRoute;
  sidebarProps: ComponentProps<typeof SessionSidebar>;
  workspaceRouteProps: WorkspaceRouteProps;
};

const ShellRouteContext = createContext<ShellRouteContextValue | null>(null);

export function ShellRouteProvider({ children }: { children: ReactNode }) {
  const shellRoute = useShellRoute();
  const {
    currentId,
    isSettingsRoute,
    isStudioRoute,
    isWorkspaceRoute,
    routedProjectId,
    routedProjectSessionId,
    settingsSection,
    studioSection
  } = shellRoute;
  const { baseUrl: daemonBaseUrl, switchDaemonConnection } = useMonadRuntime();

  const {
    daemonStatus,
    daemonVersion,
    hasUpgrade,
    networkRuntime,
    profiles,
    projectsLoading,
    sessions,
    sessionsLoading,
    voiceModelConfigured,
    voiceModelState,
    workspaceProjects
  } = useAppShellData({ loadModelData: !isStudioRoute });
  const initStatus = useInitStatusQuery();

  const routedProjectInList = Boolean(
    routedProjectId && workspaceProjects.some((project) => project.id === routedProjectId)
  );
  const currentSession = sessions.find((s) => s.id === currentId) ?? null;
  const routedSessionInList = Boolean(currentId && currentSession);
  const primaryAgentSession = currentSession ?? sessions[0] ?? null;
  const activeProjectId = routedProjectId;

  const shellSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.surface);
  const activeProjectSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.activeProjectSession);
  const sidebarCollapsed = useWorkspaceShellStore((state: WorkspaceShellState) => state.sidebarCollapsed);
  const sidebarAutoReveal = useWorkspaceShellStore((state: WorkspaceShellState) => state.sidebarAutoReveal);

  const reserveHeaderLeading = sidebarCollapsed || sidebarAutoReveal;
  const runtimeReady = initStatus.isLoading ? true : isRuntimeReady(initStatus.data);

  const { sessionRouteProps, setOptimistic, setSessionUrl } = useSessionRouteModel({
    currentSession,
    profiles,
    sessions,
    voiceModelConfigured
  });

  const isWorkspaceHome = currentId === null && activeProjectId === null && !isSettingsRoute && !isStudioRoute;

  const {
    closeSettings,
    handleNewMonadChat,
    handleOpenMonadChat,
    handleOpenProjectSession,
    handleOpenProjectSettings,
    handleOpenStudio,
    openProject,
    openSettings,
    resetWorkspaceUrl,
    setSettingsUrl,
    setStudioUrl,
    setWorkspaceUrl,
    settingsReturnSurface,
    shortcutModifierLabel,
    showSidebarShortcutBadges,
    toggleSettings
  } = useAppShellNavigation({
    primaryAgentSession,
    projectsLoading,
    routedProjectId,
    routedProjectInList,
    routedProjectSessionId,
    routedSessionInList,
    runtimeReady,
    sessions,
    sessionsLoading,
    setOptimistic,
    setSessionUrl,
    workspaceProjects
  });

  const workspaceRouteProps = useMemo<WorkspaceRouteProps>(
    () => ({
      activeProjectId,
      activeProjectSessionId: routedProjectSessionId,
      agentSession: primaryAgentSession,
      onNewMonadChat: handleNewMonadChat,
      onOpenMonadChat: handleOpenMonadChat,
      onOpenProject: openProject,
      onOpenSettings: openSettings,
      onOpenStudio: handleOpenStudio,
      onProjectDeleted: resetWorkspaceUrl,
      projects: workspaceProjects,
      voiceModelState
    }),
    [
      activeProjectId,
      routedProjectSessionId,
      handleNewMonadChat,
      handleOpenMonadChat,
      handleOpenStudio,
      openProject,
      openSettings,
      primaryAgentSession,
      resetWorkspaceUrl,
      voiceModelState,
      workspaceProjects
    ]
  );

  const sidebarProps = useMemo<ComponentProps<typeof SessionSidebar>>(
    () => ({
      activeProjectId,
      activeProjectSessionId: activeProjectSession?.activeSessionId ?? null,
      daemonBaseUrl,
      daemonStatus,
      daemonVersion,
      hasUpgrade,
      networkRuntime,
      monadChatActive: currentId !== null || shellSurface === 'monadChat',
      onCloseSettings: closeSettings,
      onOpenMonadChat: handleOpenMonadChat,
      onOpenProject: openProject,
      onOpenProjectSession: handleOpenProjectSession,
      onOpenProjectSettings: handleOpenProjectSettings,
      onOpenSettingsSection: (section: SettingsSectionId) => {
        setSettingsUrl(section);
      },
      onOpenStudio: () => {
        setStudioUrl();
      },
      onOpenStudioSection: (section: StudioSectionId) => {
        setStudioUrl(section);
      },
      onOpenWorkspace: setWorkspaceUrl,
      onSwitchDaemonConnection: switchDaemonConnection,
      onToggleSettings: toggleSettings,
      projects: workspaceProjects,
      runtimeReady,
      settingsReturnSurface,
      settingsSection,
      shortcutModifierLabel,
      showSettings: isSettingsRoute,
      showShortcutBadges: showSidebarShortcutBadges,
      showStudio: isStudioRoute,
      studioPileActive: isStudioRoute,
      studioSection,
      workspacePileActive: isWorkspaceRoute
    }),
    [
      activeProjectId,
      activeProjectSession,
      closeSettings,
      currentId,
      daemonBaseUrl,
      daemonStatus,
      daemonVersion,
      handleOpenMonadChat,
      handleOpenProjectSession,
      handleOpenProjectSettings,
      hasUpgrade,
      isSettingsRoute,
      isStudioRoute,
      isWorkspaceRoute,
      networkRuntime,
      openProject,
      runtimeReady,
      setSettingsUrl,
      setStudioUrl,
      setWorkspaceUrl,
      settingsReturnSurface,
      settingsSection,
      shellSurface,
      shortcutModifierLabel,
      showSidebarShortcutBadges,
      studioSection,
      switchDaemonConnection,
      toggleSettings,
      workspaceProjects
    ]
  );

  const value = useMemo<ShellRouteContextValue>(
    () => ({
      currentSessionId: currentId,
      frame: {
        isWorkspaceHome,
        reserveHeaderLeading
      },
      onCloseStudio: setWorkspaceUrl,
      sessionRouteProps,
      settingsRouteProps: {
        initialSection: settingsSection,
        onClose: closeSettings
      },
      shellRoute,
      sidebarProps,
      workspaceRouteProps
    }),
    [
      closeSettings,
      currentId,
      isWorkspaceHome,
      reserveHeaderLeading,
      sessionRouteProps,
      setWorkspaceUrl,
      settingsSection,
      shellRoute,
      sidebarProps,
      workspaceRouteProps
    ]
  );

  return <ShellRouteContext.Provider value={value}>{children}</ShellRouteContext.Provider>;
}

export function useShellRouteContext(): ShellRouteContextValue {
  const value = useContext(ShellRouteContext);
  if (!value) throw new Error('useShellRouteContext must be used within ShellRouteProvider');
  return value;
}
