'use client';

import type { MessageId, ProfileView, SessionId, UIItem, UIMessageItem } from '@monad/protocol';
import type { VirtualListHandle } from '@/components/ui/VirtualList';
import type { StudioSectionId } from './studio/sections';

import {
  profileSelectors,
  sessionAdapter,
  sessionSelectors,
  useApproveToolMutation,
  useClarifyRespondMutation,
  useCreateSessionMutation,
  useGetHealthQuery,
  useListCommandsQuery,
  useListProfilesQuery,
  useListSessionsQuery,
  useStreamControlQuery,
  useStreamUiItemsQuery
} from '@monad/client-rtk';
import { Button, cn } from '@monad/ui';
import { PanelLeftOpen } from 'lucide-react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { useChatComposer } from '@/hooks/use-chat-composer';
import { useFirstItemIndex } from '@/hooks/use-first-item-index';
import { useNavigableModal } from '@/hooks/use-navigable-modal';
import { useSidebarShortcuts } from '@/hooks/use-sidebar-shortcuts';
import { useTranscriptHistory } from '@/hooks/use-transcript-history';
import { useMonadRuntime } from '@/lib/monad-runtime-provider';
import { getWorkplaceProjectName, isWorkplaceProject, WORKPLACE_PROJECT_PREFIX } from '@/lib/workspace-sessions';
import { useWorkspaceShellStore, type WorkspaceShellState } from '@/lib/workspace-shell-store';
import {
  compactDividerItems,
  groupToolCalls,
  textFromParts,
  type ViewItem,
  viewItemFromUi,
  viewItemKey
} from './chat-view-items';
import { NewProjectDialog } from './NewProjectDialog';
import {
  isStudioPath,
  isWorkspacePath,
  projectIdFromPathname,
  sessionIdFromPathname,
  studioPath,
  studioSectionFromPathname
} from './routes/route-paths';
import {
  activeSkillToken,
  buildCommandMenuItems,
  skillCommandDisplayName,
  skillCommandMeta
} from './routes/sessions/command-menu';
import { type SessionCommandMenuItem, SessionRoute } from './routes/sessions/SessionRoute';
import { StudioRoute } from './routes/studio/StudioRoute';
import { WorkspaceRoute } from './routes/workspace/WorkspaceRoute';
import { SessionSidebar } from './SessionSidebar';
import { loadSkillContent, SkillEditorDialog } from './SkillsSettings';
import { isStudioSectionId } from './studio/sections';

const Settings = dynamic(() => import('./Settings').then((m) => m.Settings), { ssr: false });

// Stable empty references so query fallbacks don't change identity each render
// (a fresh `[]` default would retrigger effects that depend on the data).
const EMPTY_UI_ITEMS: UIItem[] = [];

const viewMessageId = (item: ViewItem): string => item.id;
const EMPTY_PROFILES: ProfileView[] = [];

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useT();
  const { baseUrl: daemonBaseUrl, client: monadClient, switchDaemonConnection } = useMonadRuntime();

  const { data: health, isError: healthError } = useGetHealthQuery();
  const daemonStatus = health?.status === 'ok' ? 'online' : healthError ? 'offline' : 'checking';
  const daemonVersion = health?.version;
  const hasUpgrade = Boolean(
    (health as { latestVersion?: string; version?: string } | undefined)?.latestVersion &&
      (health as { latestVersion?: string; version?: string } | undefined)?.latestVersion !==
        (health as { latestVersion?: string; version?: string } | undefined)?.version
  );

  const { data: sessionData, isLoading: sessionsLoading } = useListSessionsQuery(undefined);
  const sessions = sessionSelectors.selectAll(sessionData?.sessions ?? sessionAdapter.getInitialState());
  const directSessions = useMemo(() => sessions.filter((session) => !isWorkplaceProject(session)), [sessions]);
  const workspaceProjects = useMemo(() => {
    const projects = new Map<string, { id: string; name: string }>();
    for (const session of sessions) {
      if (!isWorkplaceProject(session)) continue;
      const name = getWorkplaceProjectName(session);
      if (projects.has(name)) continue;
      projects.set(name, { id: session.id, name });
    }
    return Array.from(projects.values());
  }, [sessions]);
  // Keep the session list live: re-fetch (and re-sort by last activity) when any session changes
  // anywhere — another tab, or a turn started from a third-party channel.
  useStreamControlQuery(undefined);
  // The unified command list (built-ins + atom pack commands + user-invocable skills) drives the
  // `/` autocomplete — one server-owned source of truth instead of a hardcoded list.
  const { data: commandsData } = useListCommandsQuery(undefined);
  const commands = commandsData?.commands ?? [];
  // Model profiles drive `/model <alias>` argument autocomplete.
  const { data: profileData } = useListProfilesQuery(undefined);
  const profiles = profileData ? profileSelectors.selectAll(profileData.profiles) : EMPTY_PROFILES;
  const [createSession] = useCreateSessionMutation();
  const [approveTool] = useApproveToolMutation();
  const [clarifyRespond] = useClarifyRespondMutation();

  const currentId = (sessionIdFromPathname(pathname) as SessionId | null) || null;
  const routedProjectId = projectIdFromPathname(pathname);
  const currentSession = sessions.find((s) => s.id === currentId) ?? null;
  const primaryAgentSession =
    currentSession && !isWorkplaceProject(currentSession) ? currentSession : (directSessions[0] ?? null);
  const shellSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.surface);
  const lastMonadSessionId = useWorkspaceShellStore((state: WorkspaceShellState) => state.lastMonadSessionId);
  const activeProjectId = routedProjectId;
  const rememberMonadSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.rememberMonadSession);
  const openWorkspaceSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.openWorkspace);
  const openMonadChatSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.openMonadChat);
  const openProjectSurface = useWorkspaceShellStore((state: WorkspaceShellState) => state.openProject);

  // The web client writes over HTTP — read-only when the session's policy excludes it.
  const writableBy = currentSession?.origin?.writableBy;
  const isReadOnly = writableBy != null && !writableBy.includes('http');
  const [hiddenViewItemKeysBySession, setHiddenViewItemKeysBySession] = useState<Record<string, string[]>>({});
  const [input, setInput] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarAutoReveal, setSidebarAutoReveal] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [accessMode, setAccessMode] = useState<'auto' | 'ask'>('auto');
  const [settingsTab, setSettingsTab] = useNavigableModal('settings');
  const showSettings = settingsTab !== null;
  const isStudioRoute = isStudioPath(pathname);
  const isWorkspaceRoute = isWorkspacePath(pathname);
  const routedStudioSection = studioSectionFromPathname(pathname);
  const studioSection = routedStudioSection ?? 'agents';
  const legacyStudioSection = searchParams.get('studio');
  const showStudio = isStudioRoute || legacyStudioSection !== null;
  const studioPileActive = isStudioRoute;
  const workspacePileActive = isWorkspaceRoute;
  const [showInspector, setShowInspector] = useState(false);
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
    sessionId: currentId,
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

  const setSessionUrl = useCallback(
    (id: SessionId | null) => {
      router.replace(id === null ? '/' : `/sessions/${id}`);
    },
    [router]
  );

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
  const deepLinkMsg = searchParams.get('msg');
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
    router.replace('/');
  }, [openWorkspaceSurface, router]);

  const setStudioUrl = useCallback(
    (section?: StudioSectionId) => {
      router.replace(studioPath(section ?? 'agents'));
    },
    [router]
  );

  const openProject = useCallback(
    (projectId: string) => {
      openProjectSurface(projectId);
      router.replace(`/workplace/projects/${encodeURIComponent(projectId)}`);
    },
    [openProjectSurface, router]
  );

  // Navigate back to / when the active session is deleted elsewhere.
  useEffect(() => {
    if (sessionsLoading || !currentId) return;
    if (!sessions.find((s) => s.id === currentId)) setSessionUrl(null);
  }, [sessions, sessionsLoading, currentId, setSessionUrl]);

  useEffect(() => {
    if (legacyStudioSection) {
      router.replace(studioPath(isStudioSectionId(legacyStudioSection) ? legacyStudioSection : 'agents'));
      return;
    }
    if (isStudioRoute && routedStudioSection === null) {
      router.replace(studioPath('agents'));
      return;
    }
    if (isStudioRoute) return;
    if (currentId) {
      openMonadChatSurface();
      rememberMonadSession(currentId);
      return;
    }
    if (routedProjectId) {
      if (pathname.startsWith('/channels/')) {
        router.replace(`/workplace/projects/${encodeURIComponent(routedProjectId)}`);
      }
      openProjectSurface(routedProjectId);
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
    legacyStudioSection,
    routedStudioSection,
    routedProjectId,
    pathname,
    router
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

  const handleNewProject = useCallback(() => setNewProjectOpen(true), []);

  const handleCreateProject = useCallback(
    ({ name, cwd }: { name: string; cwd?: string }) => {
      setNewProjectOpen(false);
      createSession({
        title: WORKPLACE_PROJECT_PREFIX + name,
        origin: { surface: 'web', client: 'workplace' },
        ...(cwd ? { cwd } : {})
      })
        .unwrap()
        .then((id) => openProject(id))
        .catch(() => {});
    },
    [createSession, openProject]
  );

  const openSettings = useCallback(() => {
    setSettingsTab('connection');
  }, [setSettingsTab]);

  const toggleSettings = useCallback(() => {
    if (showSettings) setSettingsTab(null);
    else openSettings();
  }, [openSettings, setSettingsTab, showSettings]);

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

    return [
      setWorkspaceUrl,
      () => void handleOpenMonadChat(),
      ...workspaceProjects.slice(0, 7).map((project) => () => openProject(project.id))
    ];
  }, [handleOpenMonadChat, openProject, setStudioUrl, setWorkspaceUrl, showStudio, workspaceProjects]);

  const { shortcutModifierLabel, showSidebarShortcutBadges } = useSidebarShortcuts({
    sidebarShortcutActions,
    showSettings,
    toggleSettings,
    setSidebarAutoReveal,
    setSidebarCollapsed
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

  return (
    <div className="app-shell flex h-screen overflow-hidden bg-background text-foreground">
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
          onRequestCollapse={() => {
            setSidebarAutoReveal(false);
            setSidebarCollapsed(true);
          }}
          onRequestPersistentExpand={() => {
            setSidebarAutoReveal(false);
            setSidebarCollapsed(false);
          }}
          onSwitchDaemonConnection={switchDaemonConnection}
          onToggleCollapsed={() => {
            setSidebarAutoReveal(false);
            setSidebarCollapsed((collapsed) => !collapsed);
          }}
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
        {shouldShowSidebar && sidebarCollapsed ? (
          <>
            <div
              aria-hidden="true"
              className="absolute inset-y-0 left-0 z-20 w-3"
              onPointerDown={() => {
                setSidebarAutoReveal(true);
                setSidebarCollapsed(false);
              }}
              onPointerEnter={() => {
                setSidebarAutoReveal(true);
                setSidebarCollapsed(false);
              }}
            />
            <Button
              aria-label={t('web.sidebar.expand')}
              className="glass-control absolute top-3 left-3 z-20 size-8"
              onClick={() => {
                setSidebarAutoReveal(false);
                setSidebarCollapsed(false);
              }}
              size="icon"
              variant="secondary"
            >
              <PanelLeftOpen />
            </Button>
          </>
        ) : null}
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            isWorkspaceHome ? 'bg-background' : 'app-main-frame'
          )}
        >
          {showStudio ? (
            <StudioRoute onClose={setWorkspaceUrl} />
          ) : currentId === null ? (
            <WorkspaceRoute
              activeProjectId={activeProjectId}
              agentSession={primaryAgentSession}
              onNewAgentChat={() => void handleNewSession()}
              onNewProject={handleNewProject}
              onOpenAgentChat={() => void handleOpenMonadChat()}
              onOpenProject={openProject}
              onOpenSettings={() => {
                openSettings();
              }}
              onOpenStudio={() => {
                setStudioUrl();
              }}
              projects={workspaceProjects}
            />
          ) : (
            <SessionRoute
              accessMode={accessMode}
              activeInputSkillToken={activeInputSkillToken}
              activeSkill={activeSkill}
              atBottom={atBottom}
              contextUsage={sessionContextUsage}
              currentSession={currentSession}
              currentSessionId={currentId}
              disabled={isReadOnly}
              firstItemIndex={firstItemIndex}
              inspectorItems={inspectorItems}
              isBusy={isBusy}
              isReadOnly={isReadOnly}
              menuItems={menuItems}
              messageQueue={messageQueue}
              model={sessionModel}
              onAccessModeChange={setAccessMode}
              onApproval={(approval, allow, scope, reason) => {
                void approveTool({ requestId: approval.requestId, allow, scope, reason });
              }}
              onAtBottomChange={setAtBottom}
              onBranch={handleBranch}
              onClarifyAnswer={(requestId, answer) => void clarifyRespond({ requestId, answer })}
              onClearQueue={() => setMessageQueue([])}
              onCommandItemApply={applyItem}
              onCommandItemHover={setActiveSkill}
              onEndReached={transcript.loadNewer}
              onInputChange={(value) => {
                setInput(value);
                setActiveSkill(0);
                setSkillMenuDismissed(false);
              }}
              onKeyDown={handleTextareaKeyDown}
              onRestore={handleRestore}
              onScrollToBottom={scrollToBottom}
              onSelectSession={selectSession}
              onSkillPreview={openSkillPreview}
              onStartReached={transcript.loadOlder}
              onStop={handleStop}
              onSubmit={() => void handleSubmit()}
              onToggleInspector={() => setShowInspector((value) => !value)}
              onVoiceText={(text) => {
                setInput((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text));
                setSkillMenuDismissed(false);
              }}
              pendingApprovals={pendingApprovals}
              pendingClarifications={pendingClarifications}
              showInspector={showInspector}
              skillMenuOpen={skillMenuOpen}
              transcriptRef={transcriptRef}
              value={input}
              viewMessages={viewMessages}
            />
          )}
        </div>
      </main>

      {showSettings ? <Settings onClose={() => setSettingsTab(null)} /> : null}
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
