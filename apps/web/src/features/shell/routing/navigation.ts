import type { Session, SessionId } from '@monad/protocol';
import type { SettingsSectionId } from '#/features/settings/sections';
import type { StudioSectionId } from '#/features/studio/sections';

import { useCreateSessionMutation } from '@monad/client-rtk';
import { useCallback, useEffect, useMemo } from 'react';

import { runtimeSectionEnabled } from '#/features/init/init-readiness';
import { normalizeSettingsSection } from '#/features/settings/sections';
import { pushShellUrl, replaceShellUrl, toShellUrl } from '#/hooks/use-shell-location';
import { createVisibleSidebarSessionShortcutActions, useSidebarShortcuts } from '#/hooks/use-sidebar-shortcuts';
import { useWorkspaceShellStore, type WorkspaceShellState } from '#/lib/workspace-shell-store';
import {
  inboxPath,
  isSettingsPath,
  isStudioPath,
  isWorkspacePath,
  projectSessionPath,
  projectSettingsPath,
  settingsPath,
  studioPath
} from './paths';
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
  setSessionUrl
}: UseAppShellNavigationParams) {
  const {
    currentId,
    isProjectSettingsRoute,
    isSettingsRoute,
    isStudioRoute,
    isWorkspaceRoute,
    pathname,
    routedStudioSection
  } = useShellRoute();

  const [createSession] = useCreateSessionMutation();
  const activeProjectSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.activeProjectSession);
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
  const setNewChatPrefill = useWorkspaceShellStore((state: WorkspaceShellState) => state.setNewChatPrefill);
  const draftChatSessions = useWorkspaceShellStore((state: WorkspaceShellState) => state.draftChatSessions);
  const draftChatSessionIds = useMemo(
    () => new Set(draftChatSessions.map((session) => session.id)),
    [draftChatSessions]
  );

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

  const openInbox = useCallback(() => {
    openWorkspaceSurface();
    replaceUrl(inboxPath());
  }, [openWorkspaceSurface, replaceUrl]);

  const setStudioUrl = useCallback(
    (section?: StudioSectionId) => {
      replaceUrl(resolveStudioNavigationPath({ runtimeReady, section: section ?? lastStudioSection }));
    },
    [lastStudioSection, replaceUrl, runtimeReady]
  );

  const openProject = useCallback(
    (projectId: string, sessionId?: SessionId) => {
      replaceUrl(sessionId ? projectSessionPath(projectId, sessionId) : `/workspace/${projectId}`);
    },
    [replaceUrl]
  );

  useEffect(() => {
    const state = activeProjectSession;
    if (!state) return;
    // Reverse sync: mirror a project's internal active-session change into the URL, but only
    // while the route still points at this project — otherwise a stale closure would yank the
    // caller back to the project session when navigating away (studio/settings/other project).
    if (routedProjectId !== state.projectId) return;
    if (isProjectSettingsRoute) return;
    if (!state.activeSessionId) return;
    if (!routedProjectSessionId) return;
    if (routedProjectSessionId && routedProjectSessionId !== state.activeSessionId) return;
    const nextUrl = projectSessionPath(state.projectId, state.activeSessionId);
    if (pathname !== nextUrl) replaceUrl(nextUrl);
  }, [activeProjectSession, isProjectSettingsRoute, pathname, replaceUrl, routedProjectId, routedProjectSessionId]);

  const handleOpenProjectSession = useCallback(
    (projectId: string, sessionId: SessionId) => {
      // Forward switching is URL-driven: the routed session id flows into useProject.
      if (activeProjectSession?.projectId === projectId) {
        replaceUrl(projectSessionPath(projectId, sessionId));
        return;
      }
      openProject(projectId, sessionId);
    },
    [activeProjectSession, openProject, replaceUrl]
  );

  const handleOpenProjectSettings = useCallback(
    (projectId: string) => {
      openWorkspaceSurface();
      pushUrl(projectSettingsPath(projectId));
    },
    [openWorkspaceSurface, pushUrl]
  );

  useEffect(() => {
    if (sessionsLoading || !currentId) return;
    if (draftChatSessionIds.has(currentId)) return;
    if (!sessions.find((s) => s.id === currentId)) setSessionUrl(null);
  }, [sessions, sessionsLoading, currentId, setSessionUrl, draftChatSessionIds]);

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
    if (isStudioRoute || isSettingsRoute || !currentId) return;
    rememberMonadSession(currentId);
  }, [currentId, isSettingsRoute, isStudioRoute, rememberMonadSession]);

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
    setNewChatPrefill({ mode: 'agent' });
    resetWorkspaceUrl();
  }, [resetWorkspaceUrl, setNewChatPrefill]);
  const handleOpenMonadChat = useCallback(() => {
    void openMonadChat();
  }, [openMonadChat]);
  const handleOpenSession = useCallback(
    (sessionId: SessionId) => {
      openMonadChatSurface();
      setSessionUrl(sessionId);
    },
    [openMonadChatSurface, setSessionUrl]
  );
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

    return createVisibleSidebarSessionShortcutActions();
  }, [setStudioUrl, isStudioRoute]);

  const { shortcutModifierLabel, showSidebarShortcutBadges } = useSidebarShortcuts({
    inboxShortcutAction: openInbox,
    monadAgentShortcutAction: handleOpenMonadChat,
    newChatShortcutAction: handleNewMonadChat,
    sidebarShortcutActions,
    showSettings: isSettingsRoute,
    toggleSettings
  });

  return {
    closeSettings,
    handleNewMonadChat,
    handleOpenMonadChat,
    handleOpenSession,
    handleOpenProjectSession,
    handleOpenProjectSettings,
    handleOpenStudio,
    openProject,
    openInbox,
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
