'use client';

import type { Session, SessionId } from '@monad/protocol';
import type { SettingsSectionId } from '#/features/settings/sections';
import type { StudioSectionId } from '#/features/studio/sections';

import { useCreateSessionMutation } from '@monad/client-rtk';
import { useCallback, useEffect, useMemo } from 'react';

import { runtimeSectionEnabled } from '#/features/init/init-readiness';
import { normalizeSettingsSection } from '#/features/settings/sections';
import { useWorkplaceUiStore } from '#/features/workplace/workplace-ui-store';
import { pushShellUrl, replaceShellUrl, toShellUrl } from '#/hooks/use-shell-location';
import { useSidebarShortcuts } from '#/hooks/use-sidebar-shortcuts';
import { useWorkspaceShellStore, type WorkspaceShellState } from '#/lib/workspace-shell-store';
import { isSettingsPath, isStudioPath, isWorkspacePath, projectSessionPath, settingsPath, studioPath } from './paths';
import { resolveStudioNavigationPath } from './studio-navigation';
import { useShellRoute } from './use-shell-route';

type UseAppShellNavigationParams = {
  primaryAgentSession: Session | null;
  projectsLoading: boolean;
  routedProjectId: string | null;
  routedProjectInList: boolean;
  routedProjectSessionId: SessionId | null;
  routedSessionInList: boolean;
  runtimeReady: boolean;
  sessions: Session[];
  sessionsLoading: boolean;
  setOptimistic: (items: []) => void;
  setSessionUrl: (id: SessionId | null) => void;
  workspaceProjects: { id: string; sessions?: { id: SessionId }[] }[];
};

function currentShellUrl(): string {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function normalizedSettingsReturnPath(value: string | null, fallback: string): string {
  if (!value?.startsWith('/') || value.startsWith('//')) return fallback;
  const pathname = value.split(/[?#]/, 1)[0] ?? '/';
  if (isSettingsPath(pathname)) return fallback;
  if (isStudioPath(pathname) || isWorkspacePath(pathname)) return value;
  return fallback;
}

export function useAppShellNavigation({
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
}: UseAppShellNavigationParams) {
  const { currentId, isSettingsRoute, isStudioRoute, isWorkspaceRoute, pathname, routedStudioSection } =
    useShellRoute();
  const activeProjectId = routedProjectId;

  const [createSession] = useCreateSessionMutation();
  const activeProjectSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.activeProjectSession);
  const pendingProjectSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.pendingProjectSession);
  const setPendingProjectSession = useWorkspaceShellStore(
    (state: WorkspaceShellState) => state.setPendingProjectSession
  );
  const lastMonadSessionId = useWorkspaceShellStore((state: WorkspaceShellState) => state.lastMonadSessionId);
  const lastStudioSection = useWorkspaceShellStore((state: WorkspaceShellState) => state.lastStudioSection);
  const lastWorkspacePath = useWorkspaceShellStore((state: WorkspaceShellState) => state.lastWorkspacePath);
  const settingsReturnPathState = useWorkspaceShellStore((state: WorkspaceShellState) => state.settingsReturnPathState);
  const setSettingsReturnPathState = useWorkspaceShellStore(
    (state: WorkspaceShellState) => state.setSettingsReturnPathState
  );
  const rememberStudioSection = useWorkspaceShellStore((state: WorkspaceShellState) => state.rememberStudioSection);
  const rememberWorkspacePath = useWorkspaceShellStore((state: WorkspaceShellState) => state.rememberWorkspacePath);
  const rememberMonadSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.rememberMonadSession);
  const openWorkspaceSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.openWorkspace);
  const openMonadChatSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.openMonadChat);
  const openProjectSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.openProject);
  const openProjectSettingsInStore = useWorkplaceUiStore((state) => state.openProjectSettings);

  const settingsFallbackReturnPath = isStudioRoute ? studioPath(lastStudioSection) : lastWorkspacePath;
  const settingsReturnPath = normalizedSettingsReturnPath(settingsReturnPathState, settingsFallbackReturnPath);
  const settingsReturnSurface: 'studio' | 'workspace' = isStudioPath(settingsReturnPath.split(/[?#]/, 1)[0] ?? '/')
    ? 'studio'
    : 'workspace';

  const pushUrl = useCallback((url: string) => {
    const nextUrl = toShellUrl(url);
    if (nextUrl === currentShellUrl()) return;
    pushShellUrl(nextUrl);
  }, []);

  const replaceUrl = useCallback((url: string) => {
    const nextUrl = toShellUrl(url);
    if (nextUrl === currentShellUrl()) return;
    replaceShellUrl(nextUrl);
  }, []);

  const setWorkspaceUrl = useCallback(() => {
    openWorkspaceSurface();
    replaceUrl(lastWorkspacePath);
  }, [lastWorkspacePath, openWorkspaceSurface, replaceUrl]);

  const resetWorkspaceUrl = useCallback(() => {
    openWorkspaceSurface();
    rememberWorkspacePath('/');
    replaceUrl('/');
  }, [openWorkspaceSurface, rememberWorkspacePath, replaceUrl]);

  const setStudioUrl = useCallback(
    (section?: StudioSectionId) => {
      replaceUrl(resolveStudioNavigationPath({ runtimeReady, section: section ?? lastStudioSection }));
    },
    [lastStudioSection, replaceUrl, runtimeReady]
  );

  const openProject = useCallback(
    (projectId: string, sessionId?: SessionId) => {
      openProjectSurface(projectId);
      const fallbackSessionId = workspaceProjects.find((project) => project.id === projectId)?.sessions?.[0]?.id;
      const routeSessionId = sessionId ?? fallbackSessionId;
      replaceUrl(routeSessionId ? projectSessionPath(projectId, routeSessionId) : `/workspace/${projectId}`);
    },
    [openProjectSurface, replaceUrl, workspaceProjects]
  );

  useEffect(() => {
    const state = activeProjectSession;
    const pending = pendingProjectSession;
    if (!state) return;
    // Only mirror the active session into the URL while the route still points at this
    // project. Without this guard, navigating away (studio/settings/another project) fires
    // this effect with a stale `activeProjectSession` still in its closure — before
    // WorkspaceRoute's unmount clears it — and it would replaceUrl the caller straight back
    // to the project session, trapping them on the route and thrashing the page.
    if (routedProjectId !== state.projectId) return;
    if (pending && pending.projectId === state.projectId) {
      setPendingProjectSession(null);
      state.switchSession(pending.sessionId);
      return;
    }
    if (!state.activeSessionId) return;
    if (routedProjectSessionId && routedProjectSessionId !== state.activeSessionId) return;
    const nextUrl = projectSessionPath(state.projectId, state.activeSessionId);
    if (pathname !== nextUrl) replaceUrl(nextUrl);
  }, [
    activeProjectSession,
    pendingProjectSession,
    pathname,
    replaceUrl,
    routedProjectId,
    routedProjectSessionId,
    setPendingProjectSession
  ]);

  const handleOpenProjectSession = useCallback(
    (projectId: string, sessionId: SessionId) => {
      setPendingProjectSession({ projectId, sessionId });
      if (activeProjectSession?.projectId === projectId) {
        setPendingProjectSession(null);
        replaceUrl(projectSessionPath(projectId, sessionId));
        return;
      }
      openProject(projectId, sessionId);
    },
    [activeProjectSession, openProject, replaceUrl, setPendingProjectSession]
  );

  const handleOpenProjectSettings = useCallback(
    (projectId: string) => {
      openProject(projectId);
      openProjectSettingsInStore(projectId);
    },
    [openProject, openProjectSettingsInStore]
  );

  useEffect(() => {
    if (sessionsLoading || !currentId) return;
    if (!sessions.find((s) => s.id === currentId)) setSessionUrl(null);
  }, [sessions, sessionsLoading, currentId, setSessionUrl]);

  useEffect(() => {
    if (!routedProjectId) return;
    if (routedProjectInList) return;
    if (projectsLoading) return;
    resetWorkspaceUrl();
  }, [projectsLoading, resetWorkspaceUrl, routedProjectId, routedProjectInList]);

  useEffect(() => {
    if (!isStudioRoute || !routedStudioSection) return;
    if (!runtimeSectionEnabled(routedStudioSection, runtimeReady)) return;
    rememberStudioSection(routedStudioSection);
  }, [isStudioRoute, rememberStudioSection, routedStudioSection, runtimeReady]);


  useEffect(() => {
    if (!isWorkspaceRoute) return;
    if (routedProjectId && !projectsLoading && !routedProjectInList) return;
    if (currentId && !sessionsLoading && !routedSessionInList) return;
    rememberWorkspacePath(pathname);
  }, [
    currentId,
    isWorkspaceRoute,
    pathname,
    projectsLoading,
    rememberWorkspacePath,
    routedProjectId,
    routedProjectInList,
    routedSessionInList,
    sessionsLoading
  ]);

  useEffect(() => {
    if (isStudioRoute || isSettingsRoute) return;
    if (currentId) {
      openMonadChatSurface();
      rememberMonadSession(currentId);
      return;
    }
    if (activeProjectId) {
      openProjectSurface(activeProjectId);
      return;
    }
    openWorkspaceSurface();
  }, [
    currentId,
    openProjectSurface,
    openMonadChatSurface,
    openWorkspaceSurface,
    rememberMonadSession,
    isStudioRoute,
    isSettingsRoute,
    activeProjectId
  ]);

  const handleNewSession = useCallback(async () => {
    const title = `chat ${new Date().toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}`;
    const id = await createSession({ title }).unwrap();
    setOptimistic([]);
    setSessionUrl(id);
  }, [createSession, setSessionUrl, setOptimistic]);

  const openMonadChat = useCallback(async () => {
    openMonadChatSurface();
    if (currentId) {
      setSessionUrl(currentId);
      return;
    }
    if (lastMonadSessionId && sessions.find((session) => session.id === lastMonadSessionId)) {
      setSessionUrl(lastMonadSessionId);
      return;
    }
    if (primaryAgentSession) {
      setSessionUrl(primaryAgentSession.id);
      return;
    }
    await handleNewSession();
  }, [
    currentId,
    handleNewSession,
    lastMonadSessionId,
    openMonadChatSurface,
    primaryAgentSession,
    sessions,
    setSessionUrl
  ]);

  const handleNewMonadChat = useCallback(() => {
    void handleNewSession();
  }, [handleNewSession]);
  const handleOpenMonadChat = useCallback(() => {
    void openMonadChat();
  }, [openMonadChat]);
  const handleOpenStudio = useCallback(() => {
    setStudioUrl();
  }, [setStudioUrl]);

  const closeSettings = useCallback(() => {
    replaceUrl(settingsReturnPath);
  }, [replaceUrl, settingsReturnPath]);

  const setSettingsUrl = useCallback(
    (section: string | null, mode: 'push' | 'replace' = 'replace') => {
      if (section === null) {
        replaceUrl(settingsReturnPath);
        return;
      }
      if (!isSettingsRoute)
        setSettingsReturnPathState(normalizedSettingsReturnPath(currentShellUrl(), settingsFallbackReturnPath));
      const url = settingsPath(normalizeSettingsSection(section));
      if (mode === 'push') pushUrl(url);
      else replaceUrl(url);
    },
    [isSettingsRoute, pushUrl, replaceUrl, settingsFallbackReturnPath, settingsReturnPath, setSettingsReturnPathState]
  );

  const openSettings = useCallback(() => {
    setSettingsUrl('connection', isSettingsRoute ? 'replace' : 'push');
  }, [setSettingsUrl, isSettingsRoute]);

  const toggleSettings = useCallback(() => {
    if (isSettingsRoute) closeSettings();
    else openSettings();
  }, [closeSettings, openSettings, isSettingsRoute]);

  const sidebarShortcutActions = useMemo(() => {
    if (isStudioRoute) {
      return [
        () => setStudioUrl('agents'),
        () => setStudioUrl('orchestration'),
        () => setStudioUrl('models'),
        () => setStudioUrl('atoms'),
        () => setStudioUrl('skills'),
        () => setStudioUrl('channels'),
        () => setStudioUrl('acpAgents'),
        () => setStudioUrl('externalAgents'),
        () => setStudioUrl('capabilities')
      ];
    }

    return workspaceProjects.slice(0, 9).map((project) => () => openProject(project.id));
  }, [openProject, setStudioUrl, isStudioRoute, workspaceProjects]);

  const { shortcutModifierLabel, showSidebarShortcutBadges } = useSidebarShortcuts({
    monadAgentShortcutAction: handleOpenMonadChat,
    sidebarShortcutActions,
    showSettings: isSettingsRoute,
    toggleSettings
  });

  return {
    closeSettings,
    handleNewMonadChat,
    handleOpenMonadChat,
    handleOpenProjectSession,
    handleOpenProjectSettings,
    handleOpenStudio,
    openProject,
    openSettings,
    resetWorkspaceUrl,
    setSettingsUrl: setSettingsUrl as (section: SettingsSectionId | string | null, mode?: 'push' | 'replace') => void,
    setStudioUrl,
    setWorkspaceUrl,
    settingsReturnSurface,
    shortcutModifierLabel,
    showSidebarShortcutBadges,
    toggleSettings
  };
}
