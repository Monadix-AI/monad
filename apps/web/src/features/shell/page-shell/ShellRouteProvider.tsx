import type { ComponentProps, ReactNode } from 'react';
import type { SettingsSectionId } from '#/features/settings/sections';
import type { StudioSectionId } from '#/features/studio/sections';
import type { WorkspaceRouteProps } from '#/features/workspace/WorkspaceRoute';

import { useInitStatusQuery } from '@monad/client-rtk';
import { cn } from '@monad/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { isRuntimeReady } from '#/features/init/init-readiness';
import { useSessionRouteModel } from '#/features/session/use-session-route-model';
import { AppShellSidebarReveal } from '#/features/shell/AppShellSidebarReveal';
import { CommandPaletteDialog } from '#/features/shell/CommandPalette';
import {
  buildCommandPaletteSections,
  type CommandPaletteSection,
  matchesCommandPaletteHotkey
} from '#/features/shell/command-palette';
import { RightPanel } from '#/features/shell/right-panel/RightPanel';
import { RightPanelProvider } from '#/features/shell/right-panel/right-panel-context';
import { useAppShellNavigation } from '#/features/shell/routing/navigation';
import { useShellRoute } from '#/features/shell/routing/use-shell-route';
import { SessionSidebar } from '#/features/shell/SessionSidebar';
import { useAppShellData } from '#/features/shell/useAppShellData';
import { isApplePlatform } from '#/lib/keyboard';
import { useMonadRuntime } from '#/lib/monad-runtime-context';
import { useWorkspaceShellStore, type WorkspaceShellState } from '#/lib/workspace-shell-store';
import { ShellRouteContext, type ShellRouteContextValue, useShellRouteContext } from './shell-route-context';

export { useShellRouteContext };

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
    archivedSessions,
    archivedSessionsLoading,
    daemonStatus,
    daemonVersion,
    defaultProfileAlias,
    hasUpgrade,
    networkRuntime,
    profiles,
    projectsLoading,
    sessions,
    sessionsFetching,
    sessionsLoading,
    voiceModelConfigured,
    voiceModelState,
    workspaceProjects
  } = useAppShellData({ loadModelData: !isStudioRoute });
  const initStatus = useInitStatusQuery();

  const routedProjectInList = Boolean(
    routedProjectId && workspaceProjects.some((project) => project.id === routedProjectId)
  );
  const allSessions = useMemo(() => {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    for (const session of archivedSessions) byId.set(session.id, session);
    return [...byId.values()];
  }, [archivedSessions, sessions]);
  const currentSession = allSessions.find((s) => s.id === currentId) ?? null;
  const routedSessionInList = Boolean(currentId && currentSession);
  const primaryAgentSession = currentSession ?? sessions[0] ?? null;
  const activeProjectId = routedProjectId;

  const sidebarCollapsed = useWorkspaceShellStore((state: WorkspaceShellState) => state.sidebarCollapsed);
  const sidebarAutoReveal = useWorkspaceShellStore((state: WorkspaceShellState) => state.sidebarAutoReveal);
  const setNewChatPrefill = useWorkspaceShellStore((state: WorkspaceShellState) => state.setNewChatPrefill);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [showArchivedSidebar, setShowArchivedSidebar] = useState(false);

  const reserveHeaderLeading = sidebarCollapsed || sidebarAutoReveal;
  const runtimeReady = initStatus.isLoading ? true : isRuntimeReady(initStatus.data);

  const { sessionRouteModel, setOptimistic, setSessionUrl } = useSessionRouteModel({
    agents,
    currentSession,
    defaultProfileAlias,
    profiles,
    sessions: allSessions,
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
    sessions: allSessions,
    sessionsFetching: sessionsFetching || archivedSessionsLoading,
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

  const openArchivedSidebar = useCallback(() => {
    setShowArchivedSidebar(true);
  }, []);

  const closeArchivedSidebar = useCallback(() => {
    setShowArchivedSidebar(false);
  }, []);

  const openWorkspaceAndCloseArchived = useCallback(() => {
    setShowArchivedSidebar(false);
    setWorkspaceUrl();
  }, [setWorkspaceUrl]);

  const openSessionAndCloseArchived = useCallback(
    (sessionId: Parameters<typeof handleOpenSession>[0]) => {
      setShowArchivedSidebar(false);
      handleOpenSession(sessionId);
    },
    [handleOpenSession]
  );

  const openProjectSessionAndCloseArchived = useCallback(
    (projectId: string, sessionId: Parameters<typeof handleOpenProjectSession>[1]) => {
      setShowArchivedSidebar(false);
      handleOpenProjectSession(projectId, sessionId);
    },
    [handleOpenProjectSession]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const applePlatform = isApplePlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!matchesCommandPaletteHotkey(event, applePlatform)) return;
      event.preventDefault();
      setCommandPaletteOpen((open) => !open);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

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
        onCloseArchived: closeArchivedSidebar,
        onCloseSettings: closeSettings,
        onOpenArchived: openArchivedSidebar,
        onOpenSettingsSection: (section: SettingsSectionId) => {
          setSettingsUrl(section);
        },
        onOpenStudio: () => {
          setStudioUrl();
        },
        onOpenStudioSection: (section: StudioSectionId) => {
          setStudioUrl(section);
        },
        onOpenWorkspace: openWorkspaceAndCloseArchived,
        onToggleSettings: toggleSettings,
        runtimeReady,
        settingsReturnSurface,
        settingsSection,
        shortcutModifierLabel,
        showArchived: showArchivedSidebar,
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
        archivedSessions,
        archivedSessionsLoading,
        chatSessions: sessions.filter((session) => !session.projectId),
        inboxActive: isInboxRoute,
        onCreateChatSession: handleNewMonadChat,
        onCreateProjectSession: handlePrepareProjectSession,
        onOpenInbox: openInbox,
        onOpenProject: openProject,
        onOpenProjectSession: openProjectSessionAndCloseArchived,
        onOpenProjectSettings: handleOpenProjectSettings,
        onOpenSession: openSessionAndCloseArchived,
        projects: workspaceProjects,
        workspaceItemsLoading: projectsLoading || sessionsLoading
      }
    }),
    [
      activeProjectId,
      archivedSessions,
      archivedSessionsLoading,
      closeArchivedSidebar,
      closeSettings,
      currentId,
      daemonBaseUrl,
      daemonStatus,
      daemonVersion,
      handleNewMonadChat,
      handlePrepareProjectSession,
      handleOpenProjectSettings,
      hasUpgrade,
      isInboxRoute,
      isSettingsRoute,
      isStudioRoute,
      isWorkspaceRoute,
      networkRuntime,
      openArchivedSidebar,
      openInbox,
      openProject,
      openProjectSessionAndCloseArchived,
      openSessionAndCloseArchived,
      openWorkspaceAndCloseArchived,
      projectsLoading,
      routedProjectSessionId,
      runtimeReady,
      sessions,
      sessionsLoading,
      setSettingsUrl,
      setStudioUrl,
      settingsReturnSurface,
      settingsSection,
      showArchivedSidebar,
      shortcutModifierLabel,
      showSidebarShortcutBadges,
      studioSection,
      switchDaemonConnection,
      toggleSettings,
      workspaceProjects
    ]
  );

  const commandPaletteSections = useMemo<CommandPaletteSection[]>(() => {
    const projectNames = new Map(workspaceProjects.map((project) => [project.id, project.name]));
    return buildCommandPaletteSections({
      actions: [
        {
          id: 'new-chat',
          keywords: ['create', 'session'],
          label: 'New chat',
          shortcut: `${shortcutModifierLabel} N`,
          subtitle: 'Start a Monad chat',
          run: handleNewMonadChat
        },
        {
          id: 'inbox',
          keywords: ['approvals', 'mentions'],
          label: 'Open inbox',
          shortcut: `${shortcutModifierLabel} I`,
          subtitle: 'Review messages and approvals',
          run: openInbox
        },
        {
          id: 'studio',
          keywords: ['runtime', 'agents', 'models'],
          label: 'Open Studio',
          subtitle: 'Manage runtime configuration',
          run: handleOpenStudio
        },
        {
          id: 'settings',
          keywords: ['preferences', 'configuration'],
          label: 'Open Settings',
          shortcut: `${shortcutModifierLabel} ,`,
          subtitle: 'Connection, profile, and system settings',
          run: openSettings
        },
        {
          id: 'show-archived',
          keywords: ['archive', 'history', 'sessions'],
          label: 'Show archived',
          run: openArchivedSidebar
        }
      ],
      recents: sessions.slice(0, 8).map((session) => ({
        id: `session:${session.id}`,
        keywords: [session.id, session.projectId ? (projectNames.get(session.projectId) ?? '') : 'chat'],
        label: session.title || 'Untitled chat',
        subtitle: session.projectId ? (projectNames.get(session.projectId) ?? 'Project session') : 'Chat session',
        run: () => {
          if (session.projectId) openProjectSessionAndCloseArchived(session.projectId, session.id);
          else openSessionAndCloseArchived(session.id);
        }
      }))
    });
  }, [
    handleNewMonadChat,
    handleOpenStudio,
    openArchivedSidebar,
    openInbox,
    openSettings,
    openProjectSessionAndCloseArchived,
    openSessionAndCloseArchived,
    shortcutModifierLabel,
    sessions,
    workspaceProjects
  ]);

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
          <CommandPaletteDialog
            onOpenChange={setCommandPaletteOpen}
            open={commandPaletteOpen}
            sections={commandPaletteSections}
            shortcutModifierLabel={shortcutModifierLabel}
          />
        </div>
      </RightPanelProvider>
    </ShellRouteContext.Provider>
  );
}
