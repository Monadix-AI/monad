import type { Agent, MessageId, ProfileView, Session, SessionId, UIItem } from '@monad/protocol';
import type { VirtualListHandle } from '@monad/ui/components/VirtualList';
import type { SessionRouteModel } from './session-route-contract';

import {
  useApproveToolMutation,
  useClarifyRespondMutation,
  useCreateSessionMutation,
  useGetAppearanceQuery,
  useLazyListCommandsQuery,
  useSendMessageMutation,
  useStreamUiItemsQuery,
  useTranscribeAudioMutation,
  useUpdateSessionMutation
} from '@monad/client-rtk';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useT } from '#/components/I18nProvider';
import { type ViewItem, viewItemKey } from '#/features/session/chat-view-items';
import {
  buildCommandMenuItems,
  type SessionCommandMenuItem,
  shouldActivateSlashCommandDiscovery
} from '#/features/session/command-menu';
import { useSessionUiStore } from '#/features/session/session-ui-store';
import { audioBlobToBase64 } from '#/features/session/voice-transcription';
import { studioPath } from '#/features/shell/routing/paths';
import { useShellRoute } from '#/features/shell/routing/use-shell-route';
import { workspaceLaunchErrorMessage } from '#/features/workspace/workspace-home-model';
import { useChatComposer } from '#/hooks/use-chat-composer';
import { pushShellUrl, removeShellSearchParam, replaceShellUrl, useShellSearchParam } from '#/hooks/use-shell-location';
import { useTranscriptHistory } from '#/hooks/use-transcript-history';
import { normalizedComposerSettings } from '#/lib/composer-settings';
import { getActiveDaemonConnection } from '#/lib/daemon-connections';
import { useMonadRuntime } from '#/lib/monad-runtime-context';
import { useWorkspaceShellStore, type WorkspaceShellState } from '#/lib/workspace-shell-store';
import { buildDraftSessionFeedback, resolveDraftAgentLabel } from './draft-session-feedback';
import {
  nextSessionModelCommand,
  resolveAgentProfileDefault,
  type SessionModelSelectionTarget
} from './session-model-options';
import { sessionIsDraft, sessionUsesProjectMessageRoute } from './session-route-contract';
import {
  buildSessionContextUsage,
  buildViewMessages,
  createTextareaKeyDownHandler,
  EMPTY_UI_ITEMS
} from './session-view';
import { useSessionModelOptions } from './use-session-model-options';

type UseSessionRouteModelParams = {
  agents: Agent[];
  currentSession: Session | null;
  defaultProfileAlias?: string;
  isCurrentSessionDeleted?: boolean;
  onSessionUnarchived: () => void;
  profiles: ProfileView[];
  sessions: Session[];
  voiceModelConfigured: boolean;
};

export function useSessionRouteModel({
  agents,
  currentSession,
  defaultProfileAlias,
  isCurrentSessionDeleted = false,
  onSessionUnarchived,
  profiles,
  sessions,
  voiceModelConfigured
}: UseSessionRouteModelParams) {
  const t = useT();
  const { baseUrl: daemonBaseUrl } = useMonadRuntime();
  const { currentId } = useShellRoute();
  const { data: appearance } = useGetAppearanceQuery();
  const composerSettings = normalizedComposerSettings(appearance?.composer);
  const [transcribeAudio] = useTranscribeAudioMutation();
  const [loadCommands, commandsQuery] = useLazyListCommandsQuery();
  const [approveTool] = useApproveToolMutation();
  const [clarifyRespond] = useClarifyRespondMutation();
  const [createSession] = useCreateSessionMutation();
  const [sendMessage] = useSendMessageMutation();
  const [updateSession, updateSessionState] = useUpdateSessionMutation();
  const modelProviders = useSessionModelOptions();
  const draftSession = useWorkspaceShellStore((state: WorkspaceShellState) =>
    currentId ? (state.draftChatSessions.find((session) => session.id === currentId) ?? null) : null
  );
  const removeDraftChatSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.removeDraftChatSession);
  const failDraftChatSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.failDraftChatSession);
  const hiddenViewItemKeysBySession = useSessionUiStore((state) => state.hiddenViewItemKeysBySession);
  const enqueueInitialUserMessage = useSessionUiStore((state) => state.enqueueInitialUserMessage);
  const input = useSessionUiStore((state) => state.input);
  const activeSkill = useSessionUiStore((state) => state.activeSkill);
  const applyCommandInsert = useSessionUiStore((state) => state.applyCommandInsert);
  const clearComposerInput = useSessionUiStore((state) => state.clearComposerInput);
  const setActiveSkill = useSessionUiStore((state) => state.setActiveSkill);
  const skillMenuDismissed = useSessionUiStore((state) => state.skillMenuDismissed);
  const setSkillMenuDismissed = useSessionUiStore((state) => state.setSkillMenuDismissed);
  const transcriptRef = useRef<VirtualListHandle>(null);
  const slashDiscoveryActive = shouldActivateSlashCommandDiscovery(input);
  const commands = commandsQuery.data?.commands ?? [];
  const commandMenuLoading =
    slashDiscoveryActive &&
    commands.length === 0 &&
    !commandsQuery.isError &&
    (commandsQuery.isUninitialized || commandsQuery.isLoading || commandsQuery.isFetching);

  useEffect(() => {
    if (!slashDiscoveryActive) return;
    if (
      !commandsQuery.isUninitialized &&
      (commandsQuery.isLoading || commandsQuery.isFetching || commandsQuery.isSuccess)
    ) {
      return;
    }
    void loadCommands(undefined, true);
  }, [
    commandsQuery.isFetching,
    commandsQuery.isLoading,
    commandsQuery.isSuccess,
    commandsQuery.isUninitialized,
    loadCommands,
    slashDiscoveryActive
  ]);

  const menuItems = useMemo<SessionCommandMenuItem[]>(
    () => buildCommandMenuItems(input, commands, profiles, sessions, t),
    [commands, profiles, sessions, input, t]
  );
  const skillMenuOpen = (menuItems.length > 0 || commandMenuLoading) && !skillMenuDismissed;
  const previousInputRef = useRef(input);

  useEffect(() => {
    if (previousInputRef.current === input) return;
    previousInputRef.current = input;
    if (!slashDiscoveryActive) return;
    setSkillMenuDismissed(false);
    setActiveSkill(0);
  }, [input, setActiveSkill, setSkillMenuDismissed, slashDiscoveryActive]);

  useEffect(() => {
    if (menuItems.length === 0) {
      if (activeSkill !== 0) setActiveSkill(0);
      return;
    }
    if (activeSkill >= menuItems.length) setActiveSkill(menuItems.length - 1);
  }, [activeSkill, menuItems.length, setActiveSkill]);

  const writableBy = currentSession?.origin?.writableBy;
  const isReadOnly = writableBy != null && !writableBy.includes('http');
  const stream = useStreamUiItemsQuery(currentId as SessionId, { skip: currentId === null || draftSession !== null });
  const streamData = draftSession ? undefined : stream.currentData;
  const transcript = useTranscriptHistory({
    sessionId: draftSession ? null : currentId,
    streamOldestCursor: streamData?.oldestCursor,
    streamHasMore: streamData?.hasMore ?? false,
    streamReplacementRevision: streamData?.replacementRevision
  });
  const history = draftSession ? EMPTY_UI_ITEMS : transcript.items;
  const hiddenViewItemKeys = useMemo(
    () => new Set(currentId ? (hiddenViewItemKeysBySession[currentId] ?? []) : []),
    [currentId, hiddenViewItemKeysBySession]
  );
  const visibleHistory = useMemo(
    () => history.filter((item) => !hiddenViewItemKeys.has(viewItemKey(item) ?? '')),
    [history, hiddenViewItemKeys]
  );
  const liveItems = streamData?.items ?? EMPTY_UI_ITEMS;
  const visibleLiveItems = useMemo(
    () => liveItems.filter((item) => !hiddenViewItemKeys.has(viewItemKey(item) ?? '')),
    [liveItems, hiddenViewItemKeys]
  );
  const draftAgentLabel = useMemo(
    () =>
      resolveDraftAgentLabel({
        agentId: draftSession?.agentId,
        agents,
        defaultLabel: t('web.workspace.defaultAgent')
      }),
    [agents, draftSession?.agentId, t]
  );
  const draftMessages = useMemo<ViewItem[]>(
    () => (draftSession ? buildDraftSessionFeedback({ agentLabel: draftAgentLabel, draft: draftSession }) : []),
    [draftAgentLabel, draftSession]
  );
  const currentAgentId = currentSession?.agentIds?.[0];
  const assistantLabel = useMemo(() => {
    if (draftSession) return draftAgentLabel;
    return (
      (currentAgentId ? agents.find((agent) => agent.id === currentAgentId)?.name : undefined) ??
      t('web.workspace.defaultAgent')
    );
  }, [agents, currentAgentId, draftAgentLabel, draftSession, t]);
  const inspectorItems = useMemo(() => {
    const map = new Map<string, UIItem>();
    for (const item of [...visibleHistory, ...visibleLiveItems]) map.set(`${item.kind}:${item.id}`, item);
    return [...map.values()];
  }, [visibleHistory, visibleLiveItems]);
  const pendingApprovals = useMemo(
    () =>
      visibleLiveItems
        .filter((item): item is Extract<UIItem, { kind: 'approval' }> => item.kind === 'approval')
        .map((item) => ({
          requestId: item.id,
          tool: item.tool,
          input: item.input,
          display: item.display,
          key: item.key
        })),
    [visibleLiveItems]
  );
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
  const liveStreaming = liveItems.some(
    (item) =>
      (item.kind === 'message' && item.status === 'streaming') || (item.kind === 'tool' && item.status === 'running')
  );
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
  const unarchiveCurrentSession = useCallback(async () => {
    if (currentId === null) return;
    await updateSession({ id: currentId, archived: false }).unwrap();
    onSessionUnarchived();
  }, [currentId, onSessionUnarchived, updateSession]);
  const {
    isBusy,
    optimistic,
    setOptimistic,
    messageQueue,
    commandPending,
    handleSend,
    handleStop,
    handleBranch,
    handleRestore,
    handleSubmit,
    handleQueueSubmit,
    handleForceSteer,
    handleSteerQueued,
    cancelQueuedMessages,
    removeQueuedMessage
  } = useChatComposer({
    currentId: draftSession ? null : currentId,
    liveStreaming,
    history,
    liveItems,
    streamData,
    scrollToBottom,
    jumpToLive,
    setSessionUrl,
    followUpBehavior: composerSettings.followUpBehavior,
    assistantLabel,
    isProjectSession: currentSession ? sessionUsesProjectMessageRoute(currentSession) : false
  });
  const retryDraftSession = useCallback(async () => {
    if (!draftSession) return;
    try {
      const realSessionId = await createSession({
        title: draftSession.title,
        ...(draftSession.agentId ? { agentId: draftSession.agentId } : {}),
        idempotencyKey: draftSession.createIdempotencyKey
      }).unwrap();
      enqueueInitialUserMessage(realSessionId, draftSession.text);
      removeDraftChatSession(draftSession.id);
      replaceShellUrl(`/sessions/${realSessionId}`);
      void sendMessage({
        sessionId: realSessionId,
        text: draftSession.text,
        idempotencyKey: draftSession.sendIdempotencyKey
      });
    } catch (error) {
      failDraftChatSession(draftSession.id, workspaceLaunchErrorMessage(error) ?? t('web.workspace.launchError'));
    }
  }, [
    createSession,
    draftSession,
    enqueueInitialUserMessage,
    failDraftChatSession,
    removeDraftChatSession,
    sendMessage,
    t
  ]);
  const viewMessages = useMemo<ViewItem[]>(
    () =>
      buildViewMessages({
        commandPending,
        optimistic: [...draftMessages, ...optimistic],
        transcriptMode: transcript.mode,
        visibleHistory,
        visibleLiveItems
      }),
    [visibleHistory, visibleLiveItems, optimistic, draftMessages, commandPending, transcript.mode]
  );
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
      pendingScrollKeyRef.current = null;
      const scroll = () => transcriptRef.current?.scrollToKey(key, { align: 'center' });
      scroll();
      requestAnimationFrame(() => {
        scroll();
        requestAnimationFrame(() => {
          scroll();
          removeShellSearchParam('msg', key);
        });
      });
    }
  }, [viewMessages]);

  const applyItem = useCallback(
    (item: SessionCommandMenuItem) => {
      if (item.executeOnSelect) {
        clearComposerInput();
        void handleSend(item.insert.trim());
        return;
      }
      applyCommandInsert(item);
    },
    [applyCommandInsert, clearComposerInput, handleSend]
  );
  const handleTextareaKeyDown = createTextareaKeyDownHandler({
    activeSkill,
    applyItem,
    followUpBehavior: composerSettings.followUpBehavior,
    handleForceSteer,
    handleQueueSubmit,
    isBusy,
    menuItems,
    setActiveSkill,
    setSkillMenuDismissed,
    skillMenuOpen
  });
  const sessionContextUsage = useMemo(() => buildSessionContextUsage(usage), [usage]);
  const sessionModel = useMemo(() => {
    const agent = currentAgentId ? agents.find((item) => item.id === currentAgentId) : undefined;
    const agentProfileAlias =
      agent?.modelAlias ?? (agent?.model && agent.model !== 'inherit' ? agent.model : undefined);
    const profileDefault = resolveAgentProfileDefault(profiles, defaultProfileAlias, agentProfileAlias);
    const sessionModelValue = currentSession?.model;
    const separator = sessionModelValue?.indexOf(':') ?? -1;
    const rawModelSpec = separator > 0 ? sessionModelValue : undefined;
    const sessionProfile = sessionModelValue
      ? profiles.find((profile) => profile.alias === sessionModelValue)
      : undefined;
    const effectiveProfile = sessionProfile ?? (rawModelSpec ? undefined : profileDefault);
    const effectiveProvider = rawModelSpec?.slice(0, separator) ?? effectiveProfile?.routes.chat.provider;
    const effectiveModel = rawModelSpec
      ? rawModelSpec
      : effectiveProfile
        ? `${effectiveProfile.routes.chat.provider}:${effectiveProfile.routes.chat.modelId}`
        : undefined;
    const applyModelSelection = (target: SessionModelSelectionTarget) => {
      if (isBusy || isReadOnly) return;
      const command = nextSessionModelCommand({ effectiveModel, override: currentSession?.model }, target);
      if (command) void handleSend(command);
    };

    return {
      current: effectiveProvider,
      currentEffort:
        currentSession?.reasoningEffort ??
        effectiveProfile?.routeParams?.chat?.reasoningEffort ??
        effectiveProfile?.params.reasoningEffort,
      effortOverride: currentSession?.reasoningEffort,
      currentModel: effectiveModel,
      onModelChange: (_provider: string, modelSpec: string) => applyModelSelection({ type: 'model', value: modelSpec }),
      onEffortChange: (effort?: string) => {
        if (isBusy || isReadOnly) return;
        void handleSend(`/effort ${effort ?? 'default'}`);
      },
      onUseProfile: () => {
        if (!profileDefault?.alias) return;
        applyModelSelection({ type: 'profile' });
      },
      profileDefault: profileDefault
        ? {
            label: profileDefault.alias,
            modelLabel: profileDefault.routes.chat.modelId,
            effort: profileDefault.routeParams?.chat?.reasoningEffort ?? profileDefault.params.reasoningEffort
          }
        : undefined,
      providers: modelProviders
    };
  }, [
    agents,
    currentAgentId,
    currentSession?.model,
    currentSession?.reasoningEffort,
    defaultProfileAlias,
    handleSend,
    isBusy,
    isReadOnly,
    modelProviders,
    profiles
  ]);

  const sessionRouteModel = useMemo<SessionRouteModel | null>(
    () =>
      currentId
        ? {
            commands,
            identity: {
              assistantLabel,
              currentSession,
              currentSessionId: currentId,
              isArchived: Boolean(currentSession?.archived),
              isDeleted: isCurrentSessionDeleted,
              isDraft: sessionIsDraft(currentSession),
              isReadOnly,
              isUnarchiving: updateSessionState.isLoading,
              onRetryDraftSession: draftSession?.status === 'failed' ? retryDraftSession : undefined,
              onSelectSession: (sessionId) => {
                setOptimistic([]);
                setSessionUrl(sessionId);
              },
              onUnarchive: () => void unarchiveCurrentSession()
            },
            transcript: {
              highlightedMessageId: deepLinkMsg,
              isLoading: draftSession === null && streamData?.snapshotReceived !== true,
              showLoadingSkeleton: getActiveDaemonConnection(daemonBaseUrl).type === 'remote',
              onApproval: (approval, allow, scope, reason) => {
                void approveTool({ requestId: approval.requestId, allow, scope, reason });
              },
              onBranch: handleBranch,
              onClarifyAnswer: (requestId, answer) => void clarifyRespond({ requestId, answer }),
              onEndReached: transcript.loadNewer,
              onRestore: handleRestore,
              onScrollToBottom: scrollToBottom,
              onStartReached: transcript.loadOlder,
              pendingApprovals,
              pendingClarifications,
              transcriptRef,
              viewMessages
            },
            composer: {
              commandMenuLoading,
              composerSettings,
              contextUsage: sessionContextUsage,
              isBusy,
              menuItems,
              messageQueue,
              model: sessionModel,
              onCancelQueued: cancelQueuedMessages,
              onCommandItemApply: applyItem,
              onKeyDown: handleTextareaKeyDown,
              onRemoveQueuedMessage: removeQueuedMessage,
              onSteerQueued: () => void handleSteerQueued(),
              onStop: handleStop,
              onSubmit: () => void handleSubmit(),
              onVoiceSettingsClick: () => pushShellUrl(studioPath('models')),
              onVoiceTranscribe: async (audio) => {
                const body = await audioBlobToBase64(audio);
                return (await transcribeAudio(body).unwrap()).text;
              },
              skillMenuOpen,
              voiceModelConfigured
            },
            inspector: {
              items: inspectorItems
            }
          }
        : null,
    [
      currentId,
      commands,
      daemonBaseUrl,
      sessionContextUsage,
      currentSession,
      isCurrentSessionDeleted,
      isReadOnly,
      deepLinkMsg,
      inspectorItems,
      isBusy,
      commandMenuLoading,
      draftSession,
      menuItems,
      messageQueue,
      composerSettings,
      sessionModel,
      assistantLabel,
      approveTool,
      cancelQueuedMessages,
      handleBranch,
      clarifyRespond,
      removeQueuedMessage,
      applyItem,
      retryDraftSession,
      transcript.loadNewer,
      handleTextareaKeyDown,
      handleRestore,
      scrollToBottom,
      setOptimistic,
      setSessionUrl,
      transcript.loadOlder,
      handleStop,
      handleSubmit,
      handleSteerQueued,
      transcribeAudio,
      pendingApprovals,
      pendingClarifications,
      skillMenuOpen,
      streamData?.snapshotReceived,
      unarchiveCurrentSession,
      updateSessionState.isLoading,
      viewMessages,
      voiceModelConfigured
    ]
  );

  return {
    sessionRouteModel,
    setOptimistic,
    setSessionUrl
  };
}
