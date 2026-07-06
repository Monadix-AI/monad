'use client';

import type { MessageId, ProjectId, SessionId, UIItem, UIMessageItem } from '@monad/protocol';
import type { VirtualListHandle } from '@monad/ui/components/VirtualList';
import type { SessionCommandMenuItem } from '@/features/routes/sessions/SessionRoute';
import type { WorkspaceRouteProps } from '@/features/routes/workspace/WorkspaceRoute';
import type { StudioSectionId } from '@/features/studio/sections';

import {
  useApproveToolMutation,
  useClarifyRespondMutation,
  useCreateSessionMutation,
  useCreateWorkplaceProjectMutation,
  useGetWorkplaceProjectQuery,
  useStreamUiItemsQuery,
  useTranscribeAudioMutation
} from '@monad/client-rtk';
import { cn } from '@monad/ui';
import { useFirstItemIndex } from '@monad/ui/hooks/use-first-item-index';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelLoading } from '@/components/PanelLoading';
import {
  isStudioPath,
  isWorkspacePath,
  projectIdFromPathname,
  sessionIdFromPathname,
  studioPath,
  studioSectionFromPathname
} from '@/features/routes/route-paths';
import {
  activeSkillToken,
  buildCommandMenuItems,
  skillCommandDisplayName,
  skillCommandMeta
} from '@/features/routes/sessions/command-menu';
import {
  compactDividerItems,
  groupToolCalls,
  textFromParts,
  type ViewItem,
  viewItemFromUi,
  viewItemKey
} from '@/features/session/chat-view-items';
import { audioBlobToBase64 } from '@/features/session/voice-transcription';
import { Settings } from '@/features/settings/Settings';
import { SkillEditorDialog } from '@/features/studio/skills-settings/SkillEditorDialog';
import { loadSkillContent } from '@/features/studio/skills-settings/utils';
import { useChatComposer } from '@/hooks/use-chat-composer';
import { buildNavigableModalUrl, useNavigableModal } from '@/hooks/use-navigable-modal';
import {
  pushShellUrl,
  replaceShellUrl,
  useShellPathname,
  useShellSearchParam,
  useShellSearchParamPresent
} from '@/hooks/use-shell-location';
import { useSidebarShortcuts } from '@/hooks/use-sidebar-shortcuts';
import { useTranscriptHistory } from '@/hooks/use-transcript-history';
import { useMonadRuntime } from '@/lib/monad-runtime-provider';
import { useWorkspaceShellStore, type WorkspaceShellState } from '@/lib/workspace-shell-store';
import { AppShellRoutes } from './AppShellRoutes';
import { AppShellSidebarReveal } from './AppShellSidebarReveal';
import { NewProjectDialog } from './NewProjectDialog';
import { SessionSidebar } from './SessionSidebar';
import { useAppShellData } from './useAppShellData';

// Stable empty references so query fallbacks don't change identity each render
// (a fresh `[]` default would retrigger effects that depend on the data).
const EMPTY_UI_ITEMS: UIItem[] = [];

const viewMessageId = (item: ViewItem): string => item.id;

const SEGMENT_COLORS: Record<string, string> = {
  customAgents: 'var(--success)',
  mcpTools: 'var(--info)',
  memory: 'var(--warning)',
  messages: 'var(--primary)',
  skills: 'var(--destructive)',
  systemPrompt: 'var(--accent-blue)',
  systemTools: 'var(--warning)'
};

export function AppShell() {
  const pathname = useShellPathname();
  const t = useT();
  const { baseUrl: daemonBaseUrl, client: monadClient, switchDaemonConnection } = useMonadRuntime();

  const {
    commands,
    daemonStatus,
    daemonVersion,
    hasUpgrade,
    profiles,
    sessions,
    sessionsLoading,
    voiceModelConfigured,
    voiceModelState,
    workspaceProjects
  } = useAppShellData();
  const directSessions = sessions;
  const [transcribeAudio] = useTranscribeAudioMutation();
  const [createSession] = useCreateSessionMutation();
  const [createWorkplaceProject] = useCreateWorkplaceProjectMutation();
  const [approveTool] = useApproveToolMutation();
  const [clarifyRespond] = useClarifyRespondMutation();

  const currentId = (sessionIdFromPathname(pathname) as SessionId | null) || null;
  const routedProjectId = projectIdFromPathname(pathname);
  const routedProjectInList = Boolean(
    routedProjectId && workspaceProjects.some((project) => project.id === routedProjectId)
  );
  const routedProject = useGetWorkplaceProjectQuery((routedProjectId ?? ('prj_' as ProjectId)) as ProjectId, {
    skip: routedProjectId === null || routedProjectInList
  });
  const currentSession = sessions.find((s) => s.id === currentId) ?? null;
  const primaryAgentSession = currentSession ?? directSessions[0] ?? null;
  const shellSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.surface);
  const lastMonadSessionId = useWorkspaceShellStore((state: WorkspaceShellState) => state.lastMonadSessionId);
  const activeProjectId = routedProjectId;
  const rememberMonadSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.rememberMonadSession);
  const openWorkspaceSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.openWorkspace);
  const openMonadChatSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.openMonadChat);
  const openProjectSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.openProject);
  const sidebarCollapsed = useWorkspaceShellStore((state: WorkspaceShellState) => state.sidebarCollapsed);
  const sidebarAutoReveal = useWorkspaceShellStore((state: WorkspaceShellState) => state.sidebarAutoReveal);
  const newProjectOpen = useWorkspaceShellStore((state: WorkspaceShellState) => state.newProjectOpen);
  const showInspector = useWorkspaceShellStore((state: WorkspaceShellState) => state.sessionInspectorOpen);
  const revealSidebar = useWorkspaceShellStore((state: WorkspaceShellState) => state.revealSidebar);
  const autoRevealSidebar = useWorkspaceShellStore((state: WorkspaceShellState) => state.autoRevealSidebar);
  const collapseSidebar = useWorkspaceShellStore((state: WorkspaceShellState) => state.collapseSidebar);
  const toggleSidebarCollapsed = useWorkspaceShellStore((state: WorkspaceShellState) => state.toggleSidebarCollapsed);
  const toggleProjectPinned = useWorkspaceShellStore((state: WorkspaceShellState) => state.toggleProjectPinned);
  const setNewProjectOpen = useWorkspaceShellStore((state: WorkspaceShellState) => state.setNewProjectOpen);
  const toggleSessionInspector = useWorkspaceShellStore((state: WorkspaceShellState) => state.toggleSessionInspector);

  // The web client writes over HTTP — read-only when the session's policy excludes it.
  const writableBy = currentSession?.origin?.writableBy;
  const isReadOnly = writableBy != null && !writableBy.includes('http');
  const [hiddenViewItemKeysBySession, setHiddenViewItemKeysBySession] = useState<Record<string, string[]>>({});
  const [input, setInput] = useState('');
  const [accessMode, setAccessMode] = useState<'auto' | 'ask'>('auto');
  const showSettings = useShellSearchParamPresent('settings');
  const isStudioRoute = isStudioPath(pathname);
  const isWorkspaceRoute = isWorkspacePath(pathname);
  const sidebarAutoMode = sidebarCollapsed || sidebarAutoReveal;
  const reserveHeaderLeading = sidebarAutoMode;
  const routedStudioSection = studioSectionFromPathname(pathname);
  const studioSection = routedStudioSection ?? 'runtime';
  const showStudio = isStudioRoute;
  const studioPileActive = isStudioRoute;
  const workspacePileActive = isWorkspaceRoute;
  const [activeSkill, setActiveSkill] = useState(0);
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false);
  const [skillPreview, setSkillPreview] = useState<{
    id?: string;
    name?: string;
    title?: string;
    content: string;
  } | null>(null);
  const transcriptRef = useRef<VirtualListHandle>(null);
  const [atBottom, setAtBottom] = useState(true);

  const menuItems = useMemo<SessionCommandMenuItem[]>(
    () => buildCommandMenuItems(input, commands, profiles, sessions, t),
    [commands, profiles, sessions, input, t]
  );
  const skillMenuOpen = menuItems.length > 0 && !skillMenuDismissed;
  const activeInputSkill = useMemo(() => {
    return activeSkillToken(input, commands, t);
  }, [commands, input, t]);
  const openSkillPreview = useCallback(
    async (id: string) => {
      const command = commands.find((c) => c.kind === 'prompt' && c.name === id);
      const meta = skillCommandMeta(command, t);
      if (!command || !meta) return;
      const content = await loadSkillContent(
        { id: command.name, name: skillCommandDisplayName(command.name) },
        monadClient
      ).catch(() => null);
      if (content)
        setSkillPreview({ id: command.name, name: content.name, title: meta.label, content: content.content });
    },
    [commands, monadClient, t]
  );

  const stream = useStreamUiItemsQuery(currentId as SessionId, { skip: currentId === null });
  // Older history (and deep-linked windows) load lazily; the live tail arrives over `stream`.
  const transcript = useTranscriptHistory({
    transcriptTargetId: currentId,
    streamOldestCursor: stream.data?.oldestCursor,
    streamHasMore: stream.data?.hasMore ?? false
  });
  const history = transcript.items;
  const hiddenViewItemKeys = useMemo(
    () => new Set(currentId ? (hiddenViewItemKeysBySession[currentId] ?? []) : []),
    [currentId, hiddenViewItemKeysBySession]
  );
  const visibleHistory = useMemo(
    () => history.filter((item) => !hiddenViewItemKeys.has(viewItemKey(item) ?? '')),
    [history, hiddenViewItemKeys]
  );

  const liveItems = stream.data?.items ?? EMPTY_UI_ITEMS;
  const visibleLiveItems = useMemo(
    () => liveItems.filter((item) => !hiddenViewItemKeys.has(viewItemKey(item) ?? '')),
    [liveItems, hiddenViewItemKeys]
  );
  const inspectorItems = useMemo(() => {
    const map = new Map<string, UIItem>();
    for (const item of [...visibleHistory, ...visibleLiveItems]) map.set(`${item.kind}:${item.id}`, item);
    return [...map.values()];
  }, [visibleHistory, visibleLiveItems]);
  const pendingApprovals = useMemo(
    () =>
      visibleLiveItems
        .filter((item): item is Extract<UIItem, { kind: 'approval' }> => item.kind === 'approval')
        .map((item) => ({ requestId: item.id, tool: item.tool, input: item.input, key: item.key })),
    [visibleLiveItems]
  );

  // Auto-trigger the native OS folder picker for fs_path_access approvals — the system dialog
  // IS the authorization: picking grants, cancelling falls back to the in-product deny card.
  const pendingClarifications = useMemo(
    () =>
      visibleLiveItems
        .filter((item): item is Extract<UIItem, { kind: 'clarification' }> => item.kind === 'clarification')
        .map((item) => ({ requestId: item.id, question: item.question, options: item.options })),
    [visibleLiveItems]
  );
  const usage = visibleLiveItems.find(
    (item): item is Extract<UIItem, { kind: 'context' }> => item.kind === 'context'
  )?.usage;
  const groupedSegments = useMemo(() => {
    if (!usage) return [];
    const map = new Map<string, { category: string; label: string; tokens: number }>();
    for (const seg of usage.segments) {
      const existing = map.get(seg.category);
      if (existing) existing.tokens += seg.tokens;
      else map.set(seg.category, { ...seg });
    }
    return Array.from(map.values());
  }, [usage]);
  const modelOptions = useMemo(
    () => profiles.map((profile) => ({ label: profile.alias, value: profile.alias })),
    [profiles]
  );

  const liveStreaming = liveItems.some(
    (item) =>
      (item.kind === 'message' && item.status === 'streaming') || (item.kind === 'tool' && item.status === 'running')
  );

  // Following the bottom during streaming/append is handled inside VirtualList (stickToBottom);
  // this drives explicit jumps (after sending, "jump to latest") via the list's imperative handle,
  // first reconnecting to the live tail if the user was reading a detached history window.
  const jumpToLive = transcript.jumpToLive;
  const transcriptMode = transcript.mode;
  const scrollToBottom = useCallback(
    (behavior: 'smooth' | 'auto' = 'smooth') => {
      if (transcriptMode === 'history') jumpToLive();
      transcriptRef.current?.scrollToBottom(behavior);
    },
    [transcriptMode, jumpToLive]
  );

  const setSessionUrl = useCallback((id: SessionId | null) => {
    replaceShellUrl(id === null ? '/' : `/sessions/${id}`);
  }, []);

  const {
    isBusy,
    optimistic,
    setOptimistic,
    messageQueue,
    setMessageQueue,
    commandPending,
    handleSend,
    handleStop,
    handleBranch,
    handleRestore,
    handleSubmit,
    handleForceSteer
  } = useChatComposer({
    currentId,
    liveStreaming,
    history,
    liveItems,
    streamData: stream.data,
    input,
    setInput,
    scrollToBottom,
    jumpToLive,
    setSessionUrl,
    setHiddenViewItemKeysBySession
  });

  const viewMessages = useMemo<ViewItem[]>(() => {
    const items = new Map<string, ViewItem>();
    // History mode renders the detached window alone; live mode merges the live tail (which wins
    // on key collisions at the boundary). No `.slice` cap — virtualization keeps the DOM bounded.
    const sources = transcript.mode === 'history' ? [visibleHistory] : [visibleHistory, visibleLiveItems];
    for (const source of sources) {
      for (const item of source) {
        const key = viewItemKey(item);
        const viewItem = viewItemFromUi(item);
        if (!key || !viewItem) continue;
        items.set(key, viewItem);
      }
    }
    const out = [...items.values()];
    if (transcript.mode === 'live') {
      const streamedUserText = new Set(
        visibleLiveItems
          .filter((item): item is UIMessageItem => item.kind === 'message' && item.role === 'user')
          .map((item) => textFromParts(item.parts))
      );
      const historyUserTexts = new Set(
        visibleHistory
          .filter((item): item is UIMessageItem => item.kind === 'message' && item.role === 'user')
          .map((item) => textFromParts(item.parts))
      );
      for (const m of optimistic) {
        if (items.has(`message:${m.id}`)) continue;
        if (m.role === 'user' && (streamedUserText.has(m.text) || historyUserTexts.has(m.text))) continue;
        out.push(m);
      }
    }
    return groupToolCalls(compactDividerItems(out, commandPending));
  }, [visibleHistory, visibleLiveItems, optimistic, commandPending, transcript.mode]);

  const isWorkspaceHome = currentId === null && activeProjectId === null && !showSettings && !showStudio;
  const shouldShowSidebar = true;

  // Reverse-infinite anchoring: drop firstItemIndex by the number of rows prepended above the
  // previous first row so the viewport stays steady when older history loads.
  const firstItemIndex = useFirstItemIndex(viewMessages, viewMessageId);

  // Deep-link / search-to-message: ?msg=<id> opens an inclusive window around that message and
  // scrolls it into view once it renders.
  const deepLinkMsg = useShellSearchParam('msg');
  const openAtMessage = transcript.openAtMessage;
  const pendingScrollKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkMsg || currentId === null) return;
    openAtMessage(deepLinkMsg as MessageId);
    pendingScrollKeyRef.current = deepLinkMsg;
  }, [deepLinkMsg, currentId, openAtMessage]);
  useEffect(() => {
    const key = pendingScrollKeyRef.current;
    if (!key) return;
    if (viewMessages.some((m) => m.id === key)) {
      transcriptRef.current?.scrollToKey(key, { align: 'center' });
      pendingScrollKeyRef.current = null;
    }
  }, [viewMessages]);

  const setWorkspaceUrl = useCallback(() => {
    openWorkspaceSurface();
    replaceShellUrl('/');
  }, [openWorkspaceSurface]);

  const setStudioUrl = useCallback((section?: StudioSectionId) => {
    replaceShellUrl(studioPath(section ?? 'agents'));
  }, []);

  const toggleSidebarAutoMode = useCallback(() => {
    if (sidebarAutoMode) revealSidebar();
    else collapseSidebar();
  }, [collapseSidebar, revealSidebar, sidebarAutoMode]);

  const openProject = useCallback(
    (projectId: string) => {
      openProjectSurface(projectId);
      replaceShellUrl(`/workplace/projects/${encodeURIComponent(projectId)}`);
    },
    [openProjectSurface]
  );

  // Navigate back to / when the active session is deleted elsewhere.
  useEffect(() => {
    if (sessionsLoading || !currentId) return;
    if (!sessions.find((s) => s.id === currentId)) setSessionUrl(null);
  }, [sessions, sessionsLoading, currentId, setSessionUrl]);

  useEffect(() => {
    if (!routedProjectId) return;
    if (routedProjectInList) return;
    if ((routedProject.isLoading || routedProject.isFetching) && !routedProject.isError) return;
    if (routedProject.isError || routedProject.data?.id !== routedProjectId) setWorkspaceUrl();
  }, [
    routedProjectInList,
    routedProject.data?.id,
    routedProject.isError,
    routedProject.isFetching,
    routedProject.isLoading,
    routedProjectId,
    setWorkspaceUrl
  ]);

  useEffect(() => {
    if (isStudioRoute) return;
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
    activeProjectId
  ]);

  const selectSession = useCallback(
    (id: SessionId) => {
      setOptimistic([]);
      setSessionUrl(id);
    },
    [setSessionUrl, setOptimistic]
  );

  const handleNewSession = useCallback(async () => {
    const title = `chat ${new Date().toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}`;
    const id = await createSession({ title }).unwrap();
    setOptimistic([]);
    setSessionUrl(id);
  }, [createSession, setSessionUrl, setOptimistic]);

  const handleOpenMonadChat = useCallback(async () => {
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

  const handleNewProject = useCallback(() => setNewProjectOpen(true), [setNewProjectOpen]);
  const handleNewAgentChat = useCallback(() => {
    void handleNewSession();
  }, [handleNewSession]);
  const handleOpenAgentChatAction = useCallback(() => {
    void handleOpenMonadChat();
  }, [handleOpenMonadChat]);
  const handleOpenStudioAction = useCallback(() => {
    setStudioUrl();
  }, [setStudioUrl]);

  const handleCreateProject = useCallback(
    ({ name, cwd }: { name: string; cwd?: string }) => {
      setNewProjectOpen(false);
      createWorkplaceProject({
        title: name,
        origin: { surface: 'web' },
        ...(cwd ? { cwd } : {})
      })
        .unwrap()
        .then((id) => openProject(id))
        .catch(() => {});
    },
    [createWorkplaceProject, openProject, setNewProjectOpen]
  );

  const setSettingsUrl = useCallback((tab: string | null, mode: 'push' | 'replace' = 'replace') => {
    if (typeof window === 'undefined') return;
    const url = buildNavigableModalUrl(window.location.pathname, window.location.search, 'settings', tab);
    if (mode === 'push') pushShellUrl(url);
    else replaceShellUrl(url);
  }, []);

  const openSettings = useCallback(() => {
    setSettingsUrl('connection', showSettings ? 'replace' : 'push');
  }, [setSettingsUrl, showSettings]);

  const toggleSettings = useCallback(() => {
    if (showSettings) setSettingsUrl(null);
    else openSettings();
  }, [openSettings, setSettingsUrl, showSettings]);

  const sidebarShortcutActions = useMemo(() => {
    if (showStudio) {
      return [
        () => setStudioUrl('agents'),
        () => setStudioUrl('orchestration'),
        () => setStudioUrl('models'),
        () => setStudioUrl('atoms'),
        () => setStudioUrl('skills'),
        () => setStudioUrl('channels'),
        () => setStudioUrl('acpAgents'),
        () => setStudioUrl('nativeCliAgents'),
        () => setStudioUrl('capabilities')
      ];
    }

    return workspaceProjects.slice(0, 9).map((project) => () => openProject(project.id));
  }, [openProject, setStudioUrl, showStudio, workspaceProjects]);

  const { shortcutModifierLabel, showSidebarShortcutBadges } = useSidebarShortcuts({
    monadAgentShortcutAction: () => void handleOpenMonadChat(),
    sidebarShortcutActions,
    showSettings,
    toggleSettings
  });

  const applyItem = useCallback(
    (item: SessionCommandMenuItem) => {
      if (item.executeOnSelect) {
        setInput('');
        setActiveSkill(0);
        setSkillMenuDismissed(true);
        void handleSend(item.insert.trim());
        return;
      }
      setInput((current) =>
        item.replace
          ? `${current.slice(0, item.replace.start)}${item.insert}${current.slice(item.replace.end)}`
          : item.insert
      );
      setActiveSkill(0);
      setSkillMenuDismissed(item.dismissAfter ?? false);
    },
    [handleSend]
  );

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    // While an IME is composing (e.g. pinyin → Chinese), Enter confirms the candidate and must NOT
    // submit. Some browsers also fire a duplicate Enter keydown around composition end; both are
    // tagged `isComposing` (keyCode 229), so guarding here also prevents the double-send.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (skillMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveSkill((i) => (i + 1) % menuItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveSkill((i) => (i - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const picked = menuItems[Math.min(activeSkill, menuItems.length - 1)];
        if (picked) applyItem(picked);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSkillMenuDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && e.metaKey && e.altKey) {
      e.preventDefault();
      void handleForceSteer();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const sessionContextUsage = usage
    ? {
        approximate: usage.approximate,
        limit: usage.contextLimit,
        segments: groupedSegments.map((segment) => ({
          category: segment.category,
          color: SEGMENT_COLORS[segment.category],
          label: segment.label,
          tokens: segment.tokens
        })),
        used: usage.used
      }
    : undefined;
  const sessionModel = {
    current: modelOptions[0]?.value,
    onChange: (alias: string) => {
      if (!alias || isBusy || isReadOnly) return;
      void handleSend(`/model ${alias}`);
    },
    options: modelOptions
  };
  const activeInputSkillToken = activeInputSkill
    ? {
        label: activeInputSkill.label,
        source: activeInputSkill.sourceLabel,
        icon: activeInputSkill.icon,
        version: activeInputSkill.version,
        raw: activeInputSkill.raw,
        start: activeInputSkill.start,
        end: activeInputSkill.end,
        onClick: () => void openSkillPreview(activeInputSkill.id)
      }
    : undefined;
  const workspaceRouteProps = useMemo<WorkspaceRouteProps>(
    () => ({
      activeProjectId,
      agentSession: primaryAgentSession,
      onNewAgentChat: handleNewAgentChat,
      onNewProject: handleNewProject,
      onOpenAgentChat: handleOpenAgentChatAction,
      onOpenProject: openProject,
      onOpenSettings: openSettings,
      onOpenStudio: handleOpenStudioAction,
      onProjectDeleted: setWorkspaceUrl,
      projects: workspaceProjects,
      voiceModelState
    }),
    [
      activeProjectId,
      handleNewAgentChat,
      handleNewProject,
      handleOpenAgentChatAction,
      handleOpenStudioAction,
      openProject,
      openSettings,
      primaryAgentSession,
      setWorkspaceUrl,
      voiceModelState,
      workspaceProjects
    ]
  );

  return (
    <div className="app-shell relative flex h-screen overflow-hidden bg-background text-foreground">
      {shouldShowSidebar ? (
        <AppShellSidebarReveal
          autoMode={sidebarAutoMode}
          autoRevealSidebar={autoRevealSidebar}
          onOpenWorkspace={setWorkspaceUrl}
          onToggleAutoMode={toggleSidebarAutoMode}
        />
      ) : null}
      {shouldShowSidebar ? (
        <SessionSidebar
          activeProjectId={activeProjectId}
          autoCollapseOnPointerLeave={sidebarAutoReveal}
          collapsed={sidebarCollapsed}
          daemonBaseUrl={daemonBaseUrl}
          daemonStatus={daemonStatus}
          daemonVersion={daemonVersion}
          hasUpgrade={hasUpgrade}
          monadChatActive={currentId !== null || shellSurface === 'monadChat'}
          onOpenMonadChat={() => void handleOpenMonadChat()}
          onOpenProject={openProject}
          onOpenStudioSection={(section) => {
            setStudioUrl(section);
          }}
          onOpenWorkspace={setWorkspaceUrl}
          onRequestCollapse={collapseSidebar}
          onRequestPersistentExpand={revealSidebar}
          onSwitchDaemonConnection={switchDaemonConnection}
          onToggleCollapsed={toggleSidebarCollapsed}
          onToggleProjectPinned={toggleProjectPinned}
          onToggleSettings={toggleSettings}
          onToggleStudio={() => {
            setStudioUrl();
          }}
          overlay={sidebarAutoReveal}
          projects={workspaceProjects}
          shortcutModifierLabel={shortcutModifierLabel}
          showSettings={showSettings}
          showShortcutBadges={showSidebarShortcutBadges}
          showStudio={showStudio}
          studioPileActive={studioPileActive}
          studioSection={studioSection}
          workspacePileActive={workspacePileActive}
        />
      ) : null}

      <main className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            isWorkspaceHome ? 'bg-background' : 'app-main-frame',
            reserveHeaderLeading && 'app-main-sidebar-collapsed'
          )}
        >
          <Suspense fallback={<PanelLoading />}>
            <AppShellRoutes
              currentSessionId={currentId}
              onCloseStudio={setWorkspaceUrl}
              sessionRouteProps={{
                accessMode,
                activeInputSkillToken,
                activeSkill,
                atBottom,
                contextUsage: sessionContextUsage,
                currentSession,
                disabled: isReadOnly,
                firstItemIndex,
                inspectorItems,
                isBusy,
                isReadOnly,
                menuItems,
                messageQueue,
                model: sessionModel,
                onAccessModeChange: setAccessMode,
                onApproval: (approval, allow, scope, reason) => {
                  void approveTool({ requestId: approval.requestId, allow, scope, reason });
                },
                onAtBottomChange: setAtBottom,
                onBranch: handleBranch,
                onClarifyAnswer: (requestId, answer) => void clarifyRespond({ requestId, answer }),
                onClearQueue: () => setMessageQueue([]),
                onCommandItemApply: applyItem,
                onCommandItemHover: setActiveSkill,
                onEndReached: transcript.loadNewer,
                onInputChange: (value) => {
                  setInput(value);
                  setActiveSkill(0);
                  setSkillMenuDismissed(false);
                },
                onKeyDown: handleTextareaKeyDown,
                onRestore: handleRestore,
                onScrollToBottom: scrollToBottom,
                onSelectSession: selectSession,
                onSkillPreview: openSkillPreview,
                onStartReached: transcript.loadOlder,
                onStop: handleStop,
                onSubmit: () => void handleSubmit(),
                onToggleInspector: toggleSessionInspector,
                onVoiceSettingsClick: () => pushShellUrl(studioPath('models')),
                onVoiceText: (text) => {
                  setInput((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text));
                  setSkillMenuDismissed(false);
                },
                onVoiceTranscribe: async (audio) => {
                  const body = await audioBlobToBase64(audio);
                  return (await transcribeAudio(body).unwrap()).text;
                },
                pendingApprovals,
                pendingClarifications,
                showInspector,
                skillMenuOpen,
                transcriptRef,
                value: input,
                viewMessages,
                voiceModelConfigured
              }}
              showStudio={showStudio}
              workspaceRouteProps={workspaceRouteProps}
            />
          </Suspense>
        </div>
      </main>

      <SettingsModalHost />
      <NewProjectDialog
        onClose={() => setNewProjectOpen(false)}
        onCreate={handleCreateProject}
        open={newProjectOpen}
      />
      <SkillEditorDialog
        editor={skillPreview}
        initialView="preview"
        lockedPreview
        onClose={() => setSkillPreview(null)}
        onSaved={() => setSkillPreview(null)}
      />
    </div>
  );
}

function SettingsModalHost() {
  const [settingsTab, setSettingsTab] = useNavigableModal('settings');
  if (settingsTab === null) return null;
  return (
    <Settings
      initialSection={settingsTab}
      onClose={() => setSettingsTab(null)}
    />
  );
}
