import type {
  NetworkRuntimeStatus,
  Session,
  SessionAttentionState,
  SessionGenerationState,
  SessionId
} from '@monad/protocol';
import type { SettingsSectionId } from '#/features/settings/sections';
import type { ArchivedSessionListItem } from '#/features/shell/archived-sessions';
import type { StudioSectionId } from '#/features/studio/sections';
import type { RemoteDaemonConnection } from '#/lib/daemon-connections';
import type { WorkspaceSidebarContextValue } from './sidebar/workspace-sidebar-context';
import type { SidebarPagerSurface } from './sidebar-trackpad-switch';

import { useListWorkplaceExperiencesQuery } from '@monad/client-rtk';
import { cn } from '@monad/ui';
import { useReducedMotion } from 'motion/react';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { listProjectExperiences, toProjectExperienceDefinitions } from '#/features/workplace/experiences/registry';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import { NewProjectDialog } from './NewProjectDialog';
import { SessionSidebarPanels } from './SessionSidebarPanels';
import { SessionSidebarResizeHandle } from './SessionSidebarResizeHandle';
import { useSessionSidebarActions } from './session-sidebar-actions';
import { type ProjectItem, SidebarHeader } from './sidebar';
import { useConsumeActiveSessionAttention } from './sidebar/use-consume-active-session-attention';
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from './sidebar-layout';
import { useSidebarPagerGesture } from './use-sidebar-pager';
import { useSidebarResize } from './use-sidebar-resize';

interface SidebarWorkspaceConfig {
  archivedSessions: Pick<Session, 'id' | 'projectId' | 'title' | 'updatedAt'>[];
  archivedSessionsLoading?: boolean;
  projectOrderRevision: number;
  projects: ProjectItem[];
  chatSessions: (Pick<Session, 'id' | 'projectId' | 'title'> & {
    attentionState: SessionAttentionState | null;
    generationState: SessionGenerationState | null;
    unreadItemKeys: string[];
  })[];
  workspaceItemsLoading?: boolean;
  inboxActive?: boolean;
  activeChatSessionId: string | null;
  activeProjectId: string | null;
  activeProjectSessionId: string | null;
  onOpenInbox: () => void;
  onCreateChatSession: () => void;
  onCreateProjectSession: (projectId: string) => void;
  onOpenSession: (id: SessionId) => void;
  onOpenProject: (id: string) => void;
  onOpenProjectSettings: (id: string) => void;
  onOpenProjectSession: (projectId: string, sessionId: SessionId) => void;
  onOpenSearch: () => void;
}

interface SidebarSurfacesConfig {
  onCloseArchived: () => void;
  onCloseSettings: () => void;
  onOpenArchived: () => void;
  onOpenSettingsSection: (section: SettingsSectionId) => void;
  onOpenStudio: () => void;
  onOpenStudioSection: (section: StudioSectionId) => void;
  onOpenWorkspace: () => void;
  onToggleSettings: () => void;
  runtimeReady: boolean;
  settingsReturnSurface: Exclude<SidebarPagerSurface, 'archived' | 'settings'>;
  settingsSection: SettingsSectionId;
  shortcutModifierLabel?: string;
  showSettings: boolean;
  showArchived: boolean;
  showShortcutBadges?: boolean;
  showStudio: boolean;
  studioPileActive: boolean;
  studioSection: StudioSectionId;
  workspacePileActive: boolean;
}

interface SidebarDaemonConfig {
  baseUrl: string;
  hasUpgrade?: boolean;
  networkRuntime?: NetworkRuntimeStatus;
  status: 'checking' | 'online' | 'offline';
  version?: string;
  onSwitchDaemonConnection: (
    request: { type: 'local' } | { connection: RemoteDaemonConnection; type: 'remote' }
  ) => void;
}

interface Props {
  daemon: SidebarDaemonConfig;
  responsive: {
    narrow: boolean;
    onOpenChange: (open: boolean) => void;
    open: boolean;
  };
  surfaces: SidebarSurfacesConfig;
  workspace: SidebarWorkspaceConfig;
}

const AUTO_REVEAL_CLOSE_ANIMATION_MS = 200;

export function SessionSidebar({ daemon, responsive, surfaces, workspace }: Props) {
  const {
    activeChatSessionId,
    activeProjectId,
    activeProjectSessionId,
    archivedSessions,
    archivedSessionsLoading,
    chatSessions,
    inboxActive,
    onCreateChatSession,
    onCreateProjectSession,
    onOpenInbox,
    onOpenProject,
    onOpenProjectSession,
    onOpenProjectSettings,
    onOpenSearch,
    onOpenSession,
    projectOrderRevision,
    projects,
    workspaceItemsLoading
  } = workspace;
  const {
    onCloseArchived,
    onCloseSettings,
    onOpenArchived,
    onOpenSettingsSection,
    onOpenStudio,
    onOpenStudioSection,
    onOpenWorkspace,
    onToggleSettings,
    runtimeReady,
    settingsReturnSurface,
    settingsSection,
    shortcutModifierLabel = '⌘',
    showArchived,
    showSettings,
    showShortcutBadges,
    showStudio,
    studioPileActive,
    studioSection,
    workspacePileActive
  } = surfaces;
  const {
    baseUrl: daemonBaseUrl,
    hasUpgrade,
    networkRuntime,
    onSwitchDaemonConnection,
    status: daemonStatus,
    version: daemonVersion
  } = daemon;
  const t = useT();
  const { data: workplaceExperiences } = useListWorkplaceExperiencesQuery(undefined, {
    skip: !runtimeReady || projects.length === 0
  });
  const projectExperiences = useMemo(
    () =>
      listProjectExperiences(toProjectExperienceDefinitions(workplaceExperiences?.experiences ?? [])).map(
        (experience) => ({
          id: experience.id,
          ...(experience.icon ? { icon: experience.icon } : {}),
          label: experience.label ?? (experience.labelKey ? t(experience.labelKey) : experience.id)
        })
      ),
    [t, workplaceExperiences?.experiences]
  );
  const activeAttention = useMemo(() => {
    if (activeChatSessionId) return chatSessions.find((session) => session.id === activeChatSessionId);
    if (!activeProjectSessionId) return undefined;
    return projects.flatMap((project) => project.sessions).find((session) => session.id === activeProjectSessionId);
  }, [activeChatSessionId, activeProjectSessionId, chatSessions, projects]);
  useConsumeActiveSessionAttention(
    (activeAttention?.id as SessionId | undefined) ?? null,
    activeAttention?.unreadItemKeys ?? []
  );
  const collapsed = useWorkspaceShellStore((state) => state.sidebarCollapsed);
  const overlay = useWorkspaceShellStore((state) => state.sidebarAutoReveal);
  const collapseSidebar = useWorkspaceShellStore((state) => state.collapseSidebar);
  const revealSidebar = useWorkspaceShellStore((state) => state.revealSidebar);
  const toggleSessionPinned = useWorkspaceShellStore((state) => state.toggleSessionPinned);
  const toggleSidebarCollapsed = useWorkspaceShellStore((state) => state.toggleSidebarCollapsed);
  const effectiveCollapsed = responsive.narrow ? false : collapsed;
  const effectiveOverlay = responsive.narrow ? false : overlay;
  const autoCollapseOnPointerLeave = effectiveOverlay;
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoRevealClosing, setAutoRevealClosing] = useState(false);
  const [sidebarMotionReady, setSidebarMotionReady] = useState(false);
  const {
    createProject,
    deleteProject,
    archiveChatSession,
    archiveProjectSession,
    deleteArchivedSession,
    deleteChatSession,
    deleteProjectSession,
    newProjectDialogOpen,
    pendingUnarchivedSessionIds,
    renameProject,
    renameSession,
    setNewProjectDialogOpen,
    unarchiveSession,
    visibleChatSessions,
    visibleProjects
  } = useSessionSidebarActions({
    activeProjectId,
    chatSessions,
    onCreateChatSession,
    onCreateProjectSession,
    onOpenProject,
    onOpenWorkspace,
    projects,
    t
  });
  const sidebarRef = useRef<HTMLElement | null>(null);
  const autoRevealCloseTimerRef = useRef(0);
  const resizingRef = useRef(false);

  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    setSidebarMotionReady(true);
  }, []);

  useEffect(() => {
    if (!overlay) return;
    window.clearTimeout(autoRevealCloseTimerRef.current);
    setAutoRevealClosing(false);
  }, [overlay]);

  const pagerSurfaces = useMemo<SidebarPagerSurface[]>(
    () =>
      showSettings
        ? [settingsReturnSurface, 'settings']
        : showArchived
          ? ['workspace', 'archived']
          : ['workspace', 'studio'],
    [settingsReturnSurface, showArchived, showSettings]
  );
  const activeSidebarSurface: SidebarPagerSurface = showSettings
    ? 'settings'
    : showArchived
      ? 'archived'
      : showStudio
        ? 'studio'
        : 'workspace';
  const activeSidebarPageIndex = Math.max(0, pagerSurfaces.indexOf(activeSidebarSurface));

  const onDaemonMenuOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      if (open && autoCollapseOnPointerLeave) revealSidebar();
    },
    [autoCollapseOnPointerLeave, revealSidebar]
  );

  const openMenuAction = useCallback((action: () => void) => {
    setMenuOpen(false);
    action();
  }, []);

  const {
    cancelGesture: cancelPagerGesture,
    closeSettingsWithPagerAnimation,
    panelScrollRef,
    style: pagerStyle
  } = useSidebarPagerGesture({
    activeSidebarPageIndex,
    activeSidebarSurface,
    onCloseSettings,
    onOpenArchived,
    onOpenStudio,
    onOpenWorkspace,
    onToggleSettings,
    pagerSurfaces,
    prefersReducedMotion,
    resizingRef,
    settingsReturnSurface,
    showSettings
  });

  const onResizeCollapsedChange = useCallback(
    (nextCollapsed: boolean) => {
      if (nextCollapsed) collapseSidebar();
      else revealSidebar();
    },
    [collapseSidebar, revealSidebar]
  );

  const { onResizeKeyDown, onResizeMouseDown, onResizePointerDown, resizing, sidebarWidth } = useSidebarResize({
    cancelPagerGesture,
    onCollapsedChange: onResizeCollapsedChange,
    resizingRef
  });

  const activeSidebarWidth =
    responsive.narrow || effectiveCollapsed || effectiveOverlay ? DEFAULT_SIDEBAR_WIDTH : sidebarWidth;
  const expandedStyle = { width: activeSidebarWidth } satisfies CSSProperties;
  const sidebarStyle = {
    ...expandedStyle,
    ...(responsive.narrow && !responsive.open ? { transform: 'translateX(-100%)' } : {})
  } satisfies CSSProperties;
  const animateSidebar = responsive.narrow || (sidebarMotionReady && (effectiveOverlay || autoRevealClosing));
  const daemonStatusText =
    daemonStatus === 'online'
      ? t('web.sidebar.daemonOnline')
      : daemonStatus === 'offline'
        ? t('web.sidebar.daemonOffline')
        : t('web.sidebar.daemonChecking');
  const daemonStatusClass =
    daemonStatus === 'online' ? 'bg-success' : daemonStatus === 'offline' ? 'bg-destructive' : 'bg-muted-foreground';
  const workspacePanel = useMemo<WorkspaceSidebarContextValue>(
    () => ({
      state: {
        activeChatSessionId,
        activeProjectId,
        activeProjectSessionId,
        chatSessions: visibleChatSessions,
        inboxActive,
        loading: workspaceItemsLoading,
        projectOrderRevision,
        projects: visibleProjects
      },
      actions: {
        createChatSession: onCreateChatSession,
        createProject: () => setNewProjectDialogOpen(true),
        createProjectSession: onCreateProjectSession,
        archiveChatSession,
        archiveProjectSession,
        deleteChatSession,
        deleteProject,
        deleteProjectSession,
        openInbox: onOpenInbox,
        openProject: onOpenProject,
        openProjectSession: onOpenProjectSession,
        openProjectSettings: onOpenProjectSettings,
        openSearch: onOpenSearch,
        openSession: onOpenSession,
        renameProject,
        renameSession,
        toggleSessionPinned
      },
      meta: {
        projectExperiences,
        shortcutModifierLabel,
        showShortcutBadges,
        t
      }
    }),
    [
      activeChatSessionId,
      activeProjectId,
      activeProjectSessionId,
      archiveChatSession,
      archiveProjectSession,
      deleteChatSession,
      deleteProject,
      deleteProjectSession,
      inboxActive,
      onCreateChatSession,
      onCreateProjectSession,
      onOpenInbox,
      onOpenProject,
      onOpenProjectSession,
      onOpenProjectSettings,
      onOpenSearch,
      onOpenSession,
      projectOrderRevision,
      projectExperiences,
      renameProject,
      renameSession,
      setNewProjectDialogOpen,
      shortcutModifierLabel,
      showShortcutBadges,
      t,
      toggleSessionPinned,
      visibleChatSessions,
      visibleProjects,
      workspaceItemsLoading
    ]
  );
  const archivedPanel = useMemo(() => {
    const projectNames = new Map(visibleProjects.map((project) => [project.id, project.name]));
    const chatSessionItems: ArchivedSessionListItem[] = [];
    const projectSessionItems: ArchivedSessionListItem[] = [];
    for (const session of archivedSessions) {
      if (pendingUnarchivedSessionIds.has(session.id)) continue;
      const item: ArchivedSessionListItem = {
        id: session.id,
        projectId: session.projectId,
        projectName: session.projectId ? projectNames.get(session.projectId) : undefined,
        title: session.title,
        updatedAt: session.updatedAt
      };
      (session.projectId ? projectSessionItems : chatSessionItems).push(item);
    }
    return { chatSessions: chatSessionItems, projectSessions: projectSessionItems };
  }, [archivedSessions, pendingUnarchivedSessionIds, visibleProjects]);

  return (
    <>
      <aside
        className={cn(
          'panel-nav sidebar-no-hover-transition group/sidebar flex h-full min-h-0 flex-col overflow-hidden font-sans text-foreground',
          responsive.narrow && 'absolute inset-y-0 left-0 z-30 shadow-xl',
          !responsive.narrow && (effectiveCollapsed || effectiveOverlay) && 'panel-nav-overlay',
          resizing
            ? 'transition-none'
            : animateSidebar
              ? 'transition-[width,opacity,transform] duration-200 ease-out will-change-transform'
              : 'transition-none',
          responsive.narrow && (responsive.open ? 'translate-x-0 opacity-100' : 'pointer-events-none opacity-0'),
          !responsive.narrow && effectiveOverlay && !effectiveCollapsed && 'translate-x-0 opacity-100',
          !responsive.narrow && effectiveCollapsed && 'pointer-events-none -translate-x-6 opacity-0'
        )}
        data-resizing={resizing}
        onPointerLeave={(event) => {
          if (!autoCollapseOnPointerLeave || menuOpen) return;
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Element && nextTarget.closest('[data-sidebar-chrome="true"]')) return;
          window.clearTimeout(autoRevealCloseTimerRef.current);
          setAutoRevealClosing(true);
          autoRevealCloseTimerRef.current = window.setTimeout(() => {
            autoRevealCloseTimerRef.current = 0;
            setAutoRevealClosing(false);
          }, AUTO_REVEAL_CLOSE_ANIMATION_MS);
          collapseSidebar();
        }}
        ref={sidebarRef}
        style={sidebarStyle}
      >
        <div
          className="flex h-full min-h-0 flex-col"
          style={expandedStyle}
        >
          <SidebarHeader
            collapsed={effectiveCollapsed}
            onOpenWorkspace={onOpenWorkspace}
            onToggleCollapsed={responsive.narrow ? () => responsive.onOpenChange(false) : toggleSidebarCollapsed}
          />

          {!effectiveCollapsed ? (
            <SessionSidebarPanels
              archived={{
                chatSessions: archivedPanel.chatSessions,
                loading: archivedSessionsLoading,
                onBack: onCloseArchived,
                onDeleteSession: deleteArchivedSession,
                onOpenProjectSession,
                onOpenSession,
                onUnarchiveSession: unarchiveSession,
                projectSessions: archivedPanel.projectSessions
              }}
              footer={{
                daemonBaseUrl,
                daemonStatus,
                daemonStatusClass,
                daemonStatusText,
                daemonVersion,
                hasUpgrade,
                menuOpen,
                networkRuntime,
                onOpenChange: onDaemonMenuOpenChange,
                onOpenStudio,
                onOpenWorkspace,
                onRunMenuAction: openMenuAction,
                onSwitchDaemonConnection,
                onToggleSettings,
                shortcutModifierLabel,
                showSettings,
                studioPileActive,
                workspacePileActive
              }}
              pager={{
                panelScrollRef,
                style: pagerStyle,
                surfaces: pagerSurfaces
              }}
              settings={{
                activeSection: settingsSection,
                onBack: closeSettingsWithPagerAnimation,
                onSelect: onOpenSettingsSection
              }}
              studio={{
                activeSection: studioSection,
                onSelect: onOpenStudioSection,
                runtimeReady,
                shortcutModifierLabel,
                showShortcutBadges
              }}
              t={t}
              workspace={workspacePanel}
            />
          ) : null}
        </div>
        {!responsive.narrow && !effectiveCollapsed && !effectiveOverlay ? (
          <SessionSidebarResizeHandle
            label={t('web.shell.resizeSidebar')}
            max={MAX_SIDEBAR_WIDTH}
            min={MIN_SIDEBAR_WIDTH}
            onKeyDown={onResizeKeyDown}
            onMouseDown={onResizeMouseDown}
            onPointerDown={onResizePointerDown}
            value={sidebarWidth}
          />
        ) : null}
      </aside>
      <NewProjectDialog
        onClose={() => setNewProjectDialogOpen(false)}
        onCreate={createProject}
        open={newProjectDialogOpen}
      />
    </>
  );
}
