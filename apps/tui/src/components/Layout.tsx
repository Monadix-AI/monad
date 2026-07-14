import type { MonadClient } from '@monad/client';
import type { ProjectId, SessionId } from '@monad/protocol';
import type { TerminalInputBridge } from '../input/terminal-input.ts';
import type { TuiRoute } from '../input/types.ts';
import type { NavCapability, TuiSurface } from '../shell/capabilities.ts';
import type { RootState } from '../store/index.ts';

import {
  externalAgentSessionSelectors,
  useAbortSessionMutation,
  useListExternalAgentSessionsQuery,
  useSendMessageMutation,
  useSendProjectMessageMutation
} from '@monad/client-rtk';
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { FocusRegistry } from '../input/focus.ts';
import { InputRouter } from '../input/router.ts';
import { HostInteractionPrompt, useTuiInteractionPresenter } from '../interactions/presenter.tsx';
import { t } from '../lib/i18n.ts';
import { NAV_CAPABILITIES } from '../shell/capabilities.ts';
import { globalShortcut } from '../shell/keymap.ts';
import {
  chatPaneWidths,
  layoutMode,
  navigationIndexAtRow,
  shouldShowProjection,
  transcriptOffsetAfterWheel
} from '../shell/layout-model.ts';
import { enqueueFollowUp, safeErrorMessage } from '../shell/view-model.ts';
import { addUserMessage, finishTurn, switchSession } from '../store/server.ts';
import { type EditorState, edit, insertText } from './editor-model.ts';
import { InboxScreen } from './InboxScreen.tsx';
import { ModelSettings } from './ModelSettings.tsx';
import {
  AgentsScreen,
  ConnectionScreen,
  DegradedScreen,
  ExternalAgentsScreen,
  PreferencesScreen,
  RuntimeScreen
} from './OperationalScreens.tsx';
import { ProjectBrowser } from './ProjectBrowser.tsx';
import { ProjectionPanel } from './ProjectionPanel.tsx';
import { SessionBrowser } from './SessionBrowser.tsx';
import { ShellComposer } from './ShellComposer.tsx';
import { Transcript } from './Transcript.tsx';
import { TUI_GLYPHS, TUI_THEME } from './theme.ts';

type FocusArea = 'nav' | 'content' | 'projection' | 'composer';
type Overlay = 'none' | 'palette' | 'help';

export function Layout({
  baseUrl,
  client,
  input,
  onExitRequested
}: {
  baseUrl: string;
  client: MonadClient;
  input: TerminalInputBridge;
  onExitRequested: () => void;
}) {
  const { columns, rows } = useWindowSize();
  const mode = layoutMode(columns, rows);
  const { exit } = useApp();
  const dispatch = useDispatch();
  const interactionPresenter = useTuiInteractionPresenter(client);
  const currentSessionId = useSelector((state: RootState) => state.server.currentSessionId);
  const streaming = useSelector((state: RootState) => state.server.isStreaming);
  const [abortSession] = useAbortSessionMutation();
  const [sendMessage] = useSendMessageMutation();
  const [sendProjectMessage] = useSendProjectMessageMutation();
  const [surface, setSurface] = useState<TuiSurface>('workspace');
  const [navIndex, setNavIndex] = useState(0);
  const [focus, setFocus] = useState<FocusArea>('nav');
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [editor, setEditor] = useState<EditorState>({ cursor: 0, value: '' });
  const [status, setStatus] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(30);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [transcriptOffset, setTranscriptOffset] = useState(0);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const externalAgentSessionsQuery = useListExternalAgentSessionsQuery(currentSessionId ?? ('' as SessionId), {
    skip: mode !== 'wide' || !chatOpen || currentSessionId === null
  });
  const messageQueueRef = useRef<string[]>([]);
  const previousStreaming = useRef(streaming);
  const exitArmed = useRef(false);
  const capabilities = useMemo(() => NAV_CAPABILITIES.filter((item) => item.surface === surface), [surface]);
  const selected = capabilities[Math.min(navIndex, Math.max(0, capabilities.length - 1))] ?? capabilities[0];
  const composerActive = focus === 'composer' && chatOpen && overlay === 'none';
  const showNav = mode === 'wide' || (mode === 'medium' && sidebarOpen);
  const navigationWidth = showNav ? (mode === 'wide' ? sidebarWidth : 26) : 0;
  const externalAgentCount = externalAgentSessionsQuery.data
    ? externalAgentSessionSelectors.selectAll(externalAgentSessionsQuery.data).length
    : 0;
  const showProjection = shouldShowProjection(mode, chatOpen, currentSessionId !== null, externalAgentCount);
  const chatWidths = chatPaneWidths(columns, navigationWidth, showProjection);

  const openSession = useCallback(
    (id: SessionId, nextProjectId: ProjectId | null = null) => {
      const route: TuiRoute = {
        sessionId: id,
        surface: 'workspace',
        view: 'chat',
        ...(nextProjectId ? { projectId: nextProjectId } : {})
      };
      dispatch(switchSession(route.sessionId));
      setProjectId(route.projectId ?? null);
      setChatOpen(true);
      setFocus('composer');
      setStatus('');
      setTranscriptOffset(0);
      setMessageQueue([]);
      messageQueueRef.current = [];
    },
    [dispatch]
  );

  const chooseCapability = useCallback((capability: NavCapability) => {
    const next = NAV_CAPABILITIES.filter((item) => item.surface === capability.surface);
    setSurface(capability.surface);
    setNavIndex(
      Math.max(
        0,
        next.findIndex((item) => item.id === capability.id)
      )
    );
    setChatOpen(false);
    setFocus('content');
    setOverlay('none');
  }, []);

  const sendText = useCallback(
    async (text: string) => {
      if (!text || !currentSessionId) return;
      dispatch(addUserMessage(text));
      try {
        if (projectId) await sendProjectMessage({ sessionId: currentSessionId, text }).unwrap();
        else await sendMessage({ sessionId: currentSessionId, text }).unwrap();
      } catch (cause) {
        dispatch(finishTurn());
        setStatus(safeErrorMessage(cause));
      }
    },
    [currentSessionId, dispatch, projectId, sendMessage, sendProjectMessage]
  );

  const submit = useCallback(
    async (forceSteer = false) => {
      const text = editor.value.trim();
      if (!text || !currentSessionId) return;
      setEditor({ cursor: 0, value: '' });
      if (streaming) {
        if (!forceSteer) {
          const next = enqueueFollowUp(messageQueueRef.current, text);
          messageQueueRef.current = next;
          setMessageQueue(next);
          setStatus(t('cli.tui.shell.queue', { count: next.length }));
          return;
        }
        const merged = [...messageQueueRef.current, text].join('\n\n');
        messageQueueRef.current = [];
        setMessageQueue([]);
        setStatus(t('cli.tui.shell.steer'));
        await abortSession(currentSessionId);
        dispatch(finishTurn());
        await new Promise((resolve) => setTimeout(resolve, 100));
        await sendText(merged);
        return;
      }
      await sendText(text);
    },
    [abortSession, currentSessionId, dispatch, editor.value, sendText, streaming]
  );

  useEffect(() => {
    const wasStreaming = previousStreaming.current;
    previousStreaming.current = streaming;
    if (!wasStreaming || streaming || messageQueueRef.current.length === 0) return;
    const text = messageQueueRef.current.join('\n\n');
    messageQueueRef.current = [];
    setMessageQueue([]);
    setStatus(t('cli.tui.shell.queueSending'));
    void sendText(text);
  }, [sendText, streaming]);

  usePaste((text) => setEditor((state) => insertText(state, text)), {
    isActive: composerActive && !interactionPresenter.active
  });

  const stopOrExit = useCallback(() => {
    if (streaming && currentSessionId) {
      void abortSession(currentSessionId);
      dispatch(finishTurn());
      setStatus(t('cli.tui.shell.stop'));
    } else if (exitArmed.current) {
      onExitRequested();
      exit();
    } else {
      exitArmed.current = true;
      setStatus(t('cli.tui.shell.exitConfirm'));
    }
  }, [abortSession, currentSessionId, dispatch, exit, onExitRequested, streaming]);

  useInput((typed, key) => {
    if (interactionPresenter.active) return;
    if (mode === 'too-small') {
      if (overlay === 'help' && (key.escape || typed === '?')) setOverlay('none');
      else if (typed === '?') setOverlay('help');
      else if (key.ctrl && typed.toLowerCase() === 'c') stopOrExit();
      return;
    }
    const priorityRouter = new InputRouter<string>();
    priorityRouter.register('modal', () => {
      if (overlay !== 'help') return false;
      if (key.ctrl && typed.toLowerCase() === 'c') return false;
      if (key.escape || typed === '?') setOverlay('none');
      return true;
    });
    priorityRouter.register('menu', () => {
      if (overlay !== 'palette') return false;
      if (key.ctrl && typed.toLowerCase() === 'c') return false;
      if (key.escape) setOverlay('none');
      else if (key.upArrow || typed === 'k') setPaletteIndex((value) => Math.max(0, value - 1));
      else if (key.downArrow || typed === 'j')
        setPaletteIndex((value) => Math.min(NAV_CAPABILITIES.length - 1, value + 1));
      else if (key.return && NAV_CAPABILITIES[paletteIndex]) chooseCapability(NAV_CAPABILITIES[paletteIndex]);
      return true;
    });
    if (priorityRouter.route({ input: typed, key })) return;

    const global = globalShortcut(typed, key, composerActive);
    if (global === 'palette.toggle') {
      setPaletteIndex(0);
      setOverlay('palette');
      return;
    }
    if (global === 'help.toggle') {
      setOverlay('help');
      return;
    }
    if (global === 'surface.settings') {
      setSurface('settings');
      setNavIndex(0);
      setChatOpen(false);
      setFocus('nav');
      return;
    }
    if (global === 'surface.workspace') {
      setSurface('workspace');
      setNavIndex(2);
      setChatOpen(false);
      setFocus('nav');
      return;
    }
    if (typed === '[' && mode === 'medium' && !composerActive) {
      setSidebarOpen((value) => {
        if (value && focus === 'nav') setFocus('content');
        return !value;
      });
      return;
    }
    if (key.ctrl && /^[1-9]$/.test(typed)) {
      const index = Number(typed) - 1;
      if (capabilities[index]) {
        setNavIndex(index);
        setChatOpen(false);
      }
      return;
    }
    if (key.ctrl && typed.toLowerCase() === 'c') {
      stopOrExit();
      return;
    }
    if (key.tab) {
      const registry = new FocusRegistry();
      registry.register({ active: showNav, height: rows, id: 'nav', order: 10, width: sidebarWidth, x: 0, y: 0 });
      registry.register({ active: true, height: rows, id: 'content', order: 20, width: columns, x: 0, y: 0 });
      registry.register({
        active: showProjection,
        height: rows,
        id: 'projection',
        order: 30,
        width: columns,
        x: 0,
        y: 0
      });
      registry.register({
        active: chatOpen,
        height: 4,
        id: 'composer',
        order: 40,
        width: columns,
        x: 0,
        y: rows - 4
      });
      registry.focus(focus);
      setFocus(((key.shift ? registry.previous() : registry.next()) ?? 'content') as FocusArea);
      return;
    }
    if (key.escape && chatOpen) {
      setChatOpen(false);
      setFocus('content');
      return;
    }
    if (focus === 'nav') {
      if (key.upArrow || typed === 'k') setNavIndex((value) => Math.max(0, value - 1));
      else if (key.downArrow || typed === 'j') setNavIndex((value) => Math.min(capabilities.length - 1, value + 1));
      else if (key.return) {
        setChatOpen(false);
        setFocus('content');
      }
      return;
    }
    if (focus === 'content' && chatOpen) {
      if (key.pageUp) setTranscriptOffset((value) => value + 20);
      else if (key.pageDown) setTranscriptOffset((value) => Math.max(0, value - 20));
      else if (typed === 'G') setTranscriptOffset(0);
      return;
    }
    if (!composerActive) return;
    if (key.return && key.ctrl) void submit(true);
    else if (key.return) {
      if (key.shift) setEditor((state) => insertText(state, '\n'));
      else void submit();
    } else if (key.ctrl && typed.toLowerCase() === 'j') setEditor((state) => insertText(state, '\n'));
    else if (key.backspace) setEditor((state) => edit(state, 'backspace'));
    else if (key.delete) setEditor((state) => edit(state, 'delete'));
    else if (key.leftArrow) setEditor((state) => edit(state, 'left'));
    else if (key.rightArrow) setEditor((state) => edit(state, 'right'));
    else if (key.home) setEditor((state) => edit(state, 'home'));
    else if (key.end) setEditor((state) => edit(state, 'end'));
    else if (!key.ctrl && !key.meta && !key.super && typed) setEditor((state) => insertText(state, typed));
  });

  useEffect(
    () =>
      input.onMouse((event) => {
        if (event.shift) return;
        if (event.action === 'drag' && mode === 'wide' && event.button === 'left') {
          setSidebarWidth(Math.max(24, Math.min(42, event.column + 1)));
          return;
        }
        if (event.action === 'scroll') {
          if (showNav && event.column < navigationWidth) {
            setFocus('nav');
            setNavIndex((value) =>
              Math.max(0, Math.min(capabilities.length - 1, value + (event.button === 'wheel-up' ? -1 : 1)))
            );
          } else if (
            chatOpen &&
            (event.button === 'wheel-up' || event.button === 'wheel-down') &&
            (!showProjection || event.column < columns - chatWidths.projection)
          ) {
            const wheelButton = event.button;
            setFocus('content');
            setTranscriptOffset((value) => transcriptOffsetAfterWheel(value, wheelButton));
          }
          return;
        }
        if (event.action !== 'press' || event.button !== 'left') return;
        if (event.row <= 2) {
          const tab = Math.min(2, Math.floor((event.column / Math.max(1, columns)) * 3));
          setSurface((['workspace', 'studio', 'settings'] as const)[tab] ?? 'workspace');
          setNavIndex(0);
          setChatOpen(false);
          return;
        }
        if (event.row >= rows - 2) {
          if (event.column < columns / 2) setOverlay('help');
          else setOverlay('palette');
          return;
        }
        if (event.row >= rows - 4 && chatOpen) {
          setFocus('composer');
          return;
        }
        if (showProjection && event.column >= columns - chatWidths.projection) {
          setFocus('projection');
          return;
        }
        if (showNav && event.column < navigationWidth) {
          const index = navigationIndexAtRow(event.row);
          if (index !== null && capabilities[index]) {
            setNavIndex(index);
            setChatOpen(false);
            setFocus('content');
          }
        } else setFocus('content');
      }),
    [
      capabilities,
      chatOpen,
      chatWidths.projection,
      columns,
      input,
      mode,
      navigationWidth,
      rows,
      showNav,
      showProjection
    ]
  );

  if (mode === 'too-small') {
    if (overlay === 'help') return <Help />;
    return (
      <Box
        flexDirection="column"
        padding={1}
      >
        <Text
          bold
          color={TUI_THEME.warning}
        >
          {t('cli.tui.shell.tooSmall')}
        </Text>
        <Text>{t('cli.tui.shell.resize')}</Text>
        <Text color={TUI_THEME.dim}>{t('cli.tui.shell.exitHint')}</Text>
      </Box>
    );
  }

  const showInteraction = interactionPresenter.active !== null;
  return (
    <Box
      backgroundColor={TUI_THEME.surface}
      flexDirection="column"
      height={rows}
    >
      <Header surface={surface} />
      {mode === 'compact' && selected ? (
        <Box paddingX={1}>
          <Text color={TUI_THEME.dim}>
            {selected.surface} / <Text color={TUI_THEME.accent}>{selected.label}</Text> · Ctrl+K navigate
          </Text>
        </Box>
      ) : null}
      <Box flexGrow={1}>
        {showNav ? (
          <Navigation
            capabilities={capabilities}
            focused={focus === 'nav'}
            selectedIndex={navIndex}
            width={mode === 'wide' ? sidebarWidth : 26}
          />
        ) : null}
        <Box
          borderColor={focus === 'content' ? TUI_THEME.accent : TUI_THEME.frame}
          borderStyle="single"
          flexDirection="column"
          flexGrow={1}
        >
          {showInteraction ? (
            <HostInteractionPrompt presenter={interactionPresenter} />
          ) : overlay === 'palette' ? (
            <CommandPalette cursor={paletteIndex} />
          ) : overlay === 'help' ? (
            <Help />
          ) : chatOpen && currentSessionId ? (
            <Box flexGrow={1}>
              <Box
                flexDirection="column"
                flexShrink={0}
                width={chatWidths.transcript}
              >
                <Transcript offset={transcriptOffset} />
              </Box>
              {showProjection ? (
                <Box
                  flexShrink={0}
                  width={chatWidths.projection}
                >
                  <ProjectionPanel
                    active={focus === 'projection'}
                    sessionId={currentSessionId}
                  />
                </Box>
              ) : null}
            </Box>
          ) : selected ? (
            <CapabilityContent
              active={focus === 'content'}
              baseUrl={baseUrl}
              capability={selected}
              onOpenProject={(id, owner) => openSession(id, owner)}
              onOpenSession={(id, owner) => openSession(id, owner)}
            />
          ) : null}
        </Box>
      </Box>
      {chatOpen && currentSessionId && !showInteraction ? (
        <ShellComposer
          active={composerActive}
          busy={streaming}
          queued={messageQueue.length}
          state={editor}
        />
      ) : null}
      <Box
        borderColor={TUI_THEME.frame}
        borderStyle="single"
        paddingX={1}
      >
        <Text color={status ? TUI_THEME.warning : TUI_THEME.dim}>
          {status || t('cli.tui.shell.status', { mode, size: `${columns}×${rows}` })}
        </Text>
      </Box>
    </Box>
  );
}

function Header({ surface }: { surface: TuiSurface }) {
  return (
    <Box
      borderColor={TUI_THEME.frame}
      borderStyle="single"
      justifyContent="space-between"
      paddingX={1}
    >
      <Text
        bold
        color={TUI_THEME.glow}
      >
        {TUI_GLYPHS.title}
      </Text>
      <Text>
        {(['workspace', 'studio', 'settings'] as const).map((item) => (
          <Text
            bold={surface === item}
            color={surface === item ? TUI_THEME.accent : TUI_THEME.dim}
            key={item}
          >
            {` ${item} `}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function Navigation({
  capabilities,
  focused,
  selectedIndex,
  width
}: {
  capabilities: NavCapability[];
  focused: boolean;
  selectedIndex: number;
  width: number;
}) {
  return (
    <Box
      borderColor={focused ? TUI_THEME.accent : TUI_THEME.frame}
      borderStyle="single"
      flexDirection="column"
      paddingX={1}
      width={width}
    >
      {capabilities.map((capability, index) => (
        <Text
          color={index === selectedIndex ? TUI_THEME.accent : undefined}
          key={capability.id}
        >
          {index === selectedIndex ? '› ' : '  '}
          {capability.label}{' '}
          <Text color={TUI_THEME.dim}>{capability.mode === 'native' ? '' : `[${capability.mode}]`}</Text>
        </Text>
      ))}
    </Box>
  );
}

function CapabilityContent({
  active,
  baseUrl,
  capability,
  onOpenProject,
  onOpenSession
}: {
  active: boolean;
  baseUrl: string;
  capability: NavCapability;
  onOpenProject: (id: SessionId, projectId: ProjectId) => void;
  onOpenSession: (id: SessionId, projectId?: ProjectId | null) => void;
}) {
  switch (capability.id) {
    case 'workspace.inbox':
      return (
        <InboxScreen
          active={active}
          onOpen={onOpenSession}
        />
      );
    case 'workspace.projects':
      return (
        <ProjectBrowser
          active={active}
          baseUrl={baseUrl}
          onOpen={onOpenProject}
        />
      );
    case 'workspace.chats':
      return (
        <SessionBrowser
          active={active}
          onOpen={onOpenSession}
        />
      );
    case 'studio.runtime':
      return <RuntimeScreen active={active} />;
    case 'studio.models':
      return <ModelSettings active={active} />;
    case 'studio.agents':
      return <AgentsScreen active={active} />;
    case 'studio.externalAgents':
      return <ExternalAgentsScreen active={active} />;
    case 'studio.approvals':
      return (
        <InboxScreen
          active={active}
          approvalsOnly
          onOpen={onOpenSession}
        />
      );
    case 'settings.connection':
      return <ConnectionScreen baseUrl={baseUrl} />;
    case 'settings.preferences':
      return <PreferencesScreen />;
    default:
      return (
        <DegradedScreen
          active={active}
          baseUrl={baseUrl}
          capability={capability}
        />
      );
  }
}

function CommandPalette({ cursor }: { cursor: number }) {
  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text
        bold
        color={TUI_THEME.glow}
      >
        {t('cli.tui.shell.commands')}
      </Text>
      {NAV_CAPABILITIES.map((capability, index) => (
        <Text
          color={index === cursor ? TUI_THEME.accent : undefined}
          key={capability.id}
        >
          {index === cursor ? '› ' : '  '}
          {capability.surface} / {capability.label} <Text color={TUI_THEME.dim}>{capability.mode}</Text>
        </Text>
      ))}
      <Text color={TUI_THEME.dim}>↑↓ select · Enter open · Esc close</Text>
    </Box>
  );
}

function Help() {
  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text
        bold
        color={TUI_THEME.glow}
      >
        {t('cli.tui.shell.help')}
      </Text>
      <Text>{t('cli.tui.shell.helpGlobal')}</Text>
      <Text>{t('cli.tui.shell.helpFocus')}</Text>
      <Text>{t('cli.tui.shell.helpComposer')}</Text>
      <Text>{t('cli.tui.shell.helpMouse')}</Text>
      <Text color={TUI_THEME.dim}>{t('cli.tui.shell.helpClose')}</Text>
    </Box>
  );
}
