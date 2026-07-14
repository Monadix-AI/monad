import type { ComponentProps, ReactNode } from 'react';
import type { SessionRouteModel } from '#/features/session/session-route-contract';
import type { SettingsSectionId } from '#/features/settings/sections';
import type { StudioSectionId } from '#/features/studio/sections';
import type { WorkspaceRouteProps } from '#/features/workspace/WorkspaceRoute';

import { useInitStatusQuery } from '@monad/client-rtk';
import { cn } from '@monad/ui';
import { createContext, useCallback, useContext, useMemo } from 'react';

import { isRuntimeReady } from '#/features/init/init-readiness';
import { useSessionRouteModel } from '#/features/session/use-session-route-model';
import { Settings } from '#/features/settings/Settings';
import { AppShellSidebarReveal } from '#/features/shell/AppShellSidebarReveal';
import { RightPanel } from '#/features/shell/right-panel/RightPanel';
import { RightPanelProvider } from '#/features/shell/right-panel/right-panel-context';
import { useAppShellNavigation } from '#/features/shell/routing/navigation';
import { useShellRoute } from '#/features/shell/routing/use-shell-route';
import { SessionSidebar } from '#/features/shell/SessionSidebar';
import { useAppShellData } from '#/features/shell/useAppShellData';
import { useMonadRuntime } from '#/lib/monad-runtime-provider';
import { useWorkspaceShellStore, type WorkspaceShellState } from '#/lib/workspace-shell-store';

type ShellRouteContextValue = {
  onCloseStudio: () => void;
  sessionRouteModel: SessionRouteModel | null;
  settingsRouteProps: ComponentProps<typeof Settings>;
  workspaceRouteProps: WorkspaceRouteProps;
};

const ShellRouteContext = createContext<ShellRouteContextValue | null>(null);

export function ShellRouteProvider({ children }: { children: ReactNode }) {
  const shellRoute = useShellRoute();
  const {
    currentId,
    isInboxRoute,
    isProjectSettingsRoute,
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
    agents,
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

  const sidebarCollapsed = useWorkspaceShellStore((state: WorkspaceShellState) => state.sidebarCollapsed);
  const sidebarAutoReveal = useWorkspaceShellStore((state: WorkspaceShellState) => state.sidebarAutoReveal);
  const setNewChatPrefill = useWorkspaceShellStore((state: WorkspaceShellState) => state.setNewChatPrefill);

  const reserveHeaderLeading = sidebarCollapsed || sidebarAutoReveal;
  const runtimeReady = initStatus.isLoading ? true : isRuntimeReady(initStatus.data);

  const { sessionRouteModel, setOptimistic, setSessionUrl } = useSessionRouteModel({
    agents,
    currentSession,
    profiles,
    sessions,
    voiceModelConfigured
  });

  const isWorkspaceHome =
    currentId === null && activeProjectId === null && !isInboxRoute && !isSettingsRoute && !isStudioRoute;
  const rightPanelOwnerId = currentId ? `session:${currentId}` : null;

  const {
    closeSettings,
    handleNewMonadChat,
    handleOpenSession,
    handleOpenProjectSession,
    handleOpenProjectSettings,
    handleOpenStudio,
    openInbox,
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

  const handlePrepareProjectSession = useCallback(
    (projectId: string) => {
      setNewChatPrefill({ mode: 'project', projectId });
      resetWorkspaceUrl();
    },
    [resetWorkspaceUrl, setNewChatPrefill]
  );

  const workspaceRouteProps = useMemo<WorkspaceRouteProps>(
    () => ({
      activeProjectId,
      activeProjectSessionId: routedProjectSessionId,
      activeProjectSurface: isProjectSettingsRoute ? 'project-settings' : 'workplace',
      agents,
      chatSessions: sessions.filter((session) => !session.projectId),
      onOpenProjectSettings: handleOpenProjectSettings,
      onOpenSettings: openSettings,
      onOpenStudio: handleOpenStudio,
      onProjectDeleted: resetWorkspaceUrl,
      projects: workspaceProjects,
      voiceModelState
    }),
    [
      activeProjectId,
      agents,
      isProjectSettingsRoute,
      routedProjectSessionId,
      sessions,
      handleOpenStudio,
      handleOpenProjectSettings,
      openSettings,
      resetWorkspaceUrl,
      voiceModelState,
      workspaceProjects
    ]
  );

  const sidebarProps = useMemo<ComponentProps<typeof SessionSidebar>>(
    () => ({
      daemon: {
        baseUrl: daemonBaseUrl,
        hasUpgrade,
        networkRuntime,
        onSwitchDaemonConnection: switchDaemonConnection,
        status: daemonStatus,
        version: daemonVersion
      },
      surfaces: {
        onCloseSettings: closeSettings,
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
        onToggleSettings: toggleSettings,
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
      },
      workspace: {
        activeChatSessionId: currentId,
        activeProjectId,
        activeProjectSessionId: routedProjectSessionId,
        chatSessions: sessions.filter((session) => !session.projectId),
        inboxActive: isInboxRoute,
        onCreateChatSession: handleNewMonadChat,
        onCreateProjectSession: handlePrepareProjectSession,
        onOpenInbox: openInbox,
        onOpenProject: openProject,
        onOpenProjectSession: handleOpenProjectSession,
        onOpenProjectSettings: handleOpenProjectSettings,
        onOpenSession: handleOpenSession,
        projects: workspaceProjects,
        workspaceItemsLoading: projectsLoading || sessionsLoading
      }
    }),
    [
      activeProjectId,
      closeSettings,
      currentId,
      daemonBaseUrl,
      daemonStatus,
      daemonVersion,
      handleNewMonadChat,
      handlePrepareProjectSession,
      handleOpenSession,
      handleOpenProjectSession,
      handleOpenProjectSettings,
      hasUpgrade,
      isInboxRoute,
      isSettingsRoute,
      isStudioRoute,
      isWorkspaceRoute,
      networkRuntime,
      openInbox,
      openProject,
      projectsLoading,
      routedProjectSessionId,
      runtimeReady,
      sessions,
      sessionsLoading,
      setSettingsUrl,
      setStudioUrl,
      setWorkspaceUrl,
      settingsReturnSurface,
      settingsSection,
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
      onCloseStudio: setWorkspaceUrl,
      sessionRouteModel,
      settingsRouteProps: {
        initialSection: settingsSection,
        onClose: closeSettings
      },
      workspaceRouteProps
    }),
    [closeSettings, sessionRouteModel, setWorkspaceUrl, settingsSection, workspaceRouteProps]
  );

  return (
    <ShellRouteContext.Provider value={value}>
      <RightPanelProvider ownerId={rightPanelOwnerId}>
        <div className="app-shell relative flex h-screen overflow-hidden bg-background text-foreground">
          <AppShellSidebarReveal onOpenWorkspace={sidebarProps.surfaces.onOpenWorkspace} />
          <SessionSidebar {...sidebarProps} />
          <main className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <div
              className={cn(
                'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
                isWorkspaceHome ? 'bg-background' : 'app-main-frame',
                reserveHeaderLeading && 'app-main-sidebar-collapsed'
              )}
            >
              {children}
            </div>
          </main>
          <RightPanel />
        </div>
      </RightPanelProvider>
    </ShellRouteContext.Provider>
  );
}

export function useShellRouteContext(): ShellRouteContextValue {
  const value = useContext(ShellRouteContext);
  if (!value) throw new Error('useShellRouteContext must be used within ShellRouteProvider');
  return value;
}
