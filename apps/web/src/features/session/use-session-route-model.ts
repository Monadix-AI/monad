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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import {
  isTransientAttentionUiItem,
  type ViewItem,
  viewItemContainsTargetId,
  viewItemFromUi,
  viewItemKey
} from '#/features/session/chat-view-items';
import {
  buildCommandMenuItems,
  type SessionCommandMenuItem,
  shouldActivateSlashCommandDiscovery
} from '#/features/session/command-menu';
import { enqueueInitialUserMessageForSession, useSessionUiStoreForSession } from '#/features/session/session-ui-store';
import { messageAttachmentsFromSend, useComposerAttachments } from '#/features/session/use-composer-attachments';
import { useContextNotices } from '#/features/session/use-context-notices';
import { audioBlobToBase64 } from '#/features/session/voice-transcription';
import { studioPath } from '#/features/shell/routing/paths';
import { useShellRoute } from '#/features/shell/routing/use-shell-route';
import { createAndSendWorkspaceDraft, workspaceLaunchErrorMessage } from '#/features/workspace/workspace-home-model';
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
import {
  resolveSessionComposerReplyTarget,
  sessionIsDraft,
  sessionUsesProjectMessageRoute
} from './session-route-contract';
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
  const {
    addFiles: addComposerFiles,
    attachmentItems,
    clearAttachments: clearComposerAttachments,
    error: composerAttachmentError,
    openAttachment,
    removeAttachment,
    sendableAttachments: composerAttachments
  } = useComposerAttachments(currentId ?? 'no-session');
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
  const addDraftChatSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.addDraftChatSession);
  const removeDraftChatSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.removeDraftChatSession);
  const failDraftChatSession = useWorkspaceShellStore((state: WorkspaceShellState) => state.failDraftChatSession);
  const hiddenViewItemKeysBySession = useSessionUiStoreForSession(
    currentId,
    (state) => state.hiddenViewItemKeysBySession
  );
  const input = useSessionUiStoreForSession(currentId, (state) => state.input);
  const replyTargetId = useSessionUiStoreForSession(currentId, (state) => state.replyTargetId);
  const replyGeneration = useSessionUiStoreForSession(currentId, (state) => state.replyGeneration);
  const activeSkill = useSessionUiStoreForSession(currentId, (state) => state.activeSkill);
  const applyCommandInsert = useSessionUiStoreForSession(currentId, (state) => state.applyCommandInsert);
  const clearComposerInput = useSessionUiStoreForSession(currentId, (state) => state.clearComposerInput);
  const setActiveSkill = useSessionUiStoreForSession(currentId, (state) => state.setActiveSkill);
  const setReplyTargetId = useSessionUiStoreForSession(currentId, (state) => state.setReplyTargetId);
  const finishReplySend = useSessionUiStoreForSession(currentId, (state) => state.finishReplySend);
  const skillMenuDismissed = useSessionUiStoreForSession(currentId, (state) => state.skillMenuDismissed);
  const setSkillMenuDismissed = useSessionUiStoreForSession(currentId, (state) => state.setSkillMenuDismissed);
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
    void loadCommands(currentId ? { sessionId: currentId } : undefined, true);
  }, [
    commandsQuery.isFetching,
    commandsQuery.isLoading,
    commandsQuery.isSuccess,
    commandsQuery.isUninitialized,
    currentId,
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

  // Session write admission is no longer a session-owned, per-transport policy (single local
  // Operator; admission lives at connection/ingress). The web client can always compose.
  const isReadOnly = false;
  const stream = useStreamUiItemsQuery(currentId as SessionId, { skip: currentId === null || draftSession !== null });
  const streamData = draftSession ? undefined : stream.currentData;
  const transcript = useTranscriptHistory({
    sessionId: draftSession ? null : currentId,
    streamOldestCursor: streamData?.oldestCursor,
    streamHasMore: streamData?.hasMore ?? false,
    streamReplacementRevision: streamData?.replacementRevision,
    streamCanonicalMessageChanges: streamData?.canonicalMessageChanges,
    streamCanonicalMessageDroppedRevision: streamData?.canonicalMessageDroppedRevision,
    liveItems: streamData?.items ?? EMPTY_UI_ITEMS
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
    () =>
      liveItems.filter((item) => isTransientAttentionUiItem(item) || !hiddenViewItemKeys.has(viewItemKey(item) ?? '')),
    [liveItems, hiddenViewItemKeys]
  );
  useContextNotices(visibleLiveItems);
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
        .map((item) => ({
          requestId: item.id,
          question: item.question,
          options: item.options,
          asker: item.asker,
          form: item.form,
          urlElicitation: item.urlElicitation
        })),
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
  const renameCurrentSession = useCallback(
    async (title: string) => {
      if (currentId === null) return;
      await updateSession({ id: currentId, title }).unwrap();
    },
    [currentId, updateSession]
  );
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
    clearComposerAttachments,
    composerAttachments,
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
    isProjectSession: currentSession ? sessionUsesProjectMessageRoute(currentSession) : false,
    replyTargetId,
    replyGeneration,
    finishReplySend
  });
  const retryDraftSession = useCallback(async () => {
    if (!draftSession) return;
    try {
      const realSessionId = await createAndSendWorkspaceDraft(draftSession, {
        createSession,
        sendMessage,
        onSessionCreated: (serverSessionId) => {
          addDraftChatSession({
            ...draftSession,
            serverSessionId,
            updatedAt: new Date().toISOString()
          });
        }
      });
      enqueueInitialUserMessageForSession(realSessionId, {
        attachments: messageAttachmentsFromSend(draftSession.attachments, {
          createdAt: draftSession.createdAt
        }),
        text: draftSession.text
      });
      addDraftChatSession({
        ...draftSession,
        id: realSessionId,
        status: 'creating',
        updatedAt: new Date().toISOString()
      });
      removeDraftChatSession(draftSession.id);
      replaceShellUrl(`/sessions/${realSessionId}`);
    } catch (error) {
      failDraftChatSession(draftSession.id, workspaceLaunchErrorMessage(error) ?? t('web.workspace.launchError'));
    }
  }, [createSession, addDraftChatSession, draftSession, failDraftChatSession, removeDraftChatSession, sendMessage, t]);
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
  const [replyNavigationTargetId, setReplyNavigationTargetId] = useState<string | null>(null);
  const replyNavigationRequestRef = useRef(0);
  const openAtMessage = transcript.openAtMessage;
  const replyTargets = useMemo(() => {
    const resolved = new Map<string, import('./ChatMessage').Msg | null>();
    for (const [id, item] of transcript.replyTargets) {
      if (!item) {
        resolved.set(id, null);
        continue;
      }
      const view = viewItemFromUi(item);
      if (!view || !('role' in view)) continue;
      resolved.set(id, {
        ...view,
        label: view.label ?? (view.role === 'user' ? t('web.chat.you') : assistantLabel)
      });
    }
    return resolved;
  }, [assistantLabel, t, transcript.replyTargets]);
  const replyTarget = useMemo(
    () =>
      resolveSessionComposerReplyTarget({
        assistantLabel,
        replyTargetId,
        viewMessages,
        youLabel: t('web.chat.you')
      }),
    [assistantLabel, replyTargetId, t, viewMessages]
  );

  useEffect(() => {
    if (!deepLinkMsg || currentId === null) return;
    void openAtMessage(deepLinkMsg as MessageId).then((opened) => {
      if (!opened) removeShellSearchParam('msg', deepLinkMsg);
    });
  }, [deepLinkMsg, currentId, openAtMessage]);

  const handleOpenMessage = useCallback(
    (messageId: string) => {
      const request = ++replyNavigationRequestRef.current;
      setReplyNavigationTargetId(messageId);
      const targetVisible = viewMessages.some((item) => viewItemContainsTargetId(item, messageId));
      void openAtMessage(messageId as MessageId, { targetVisible }).then((opened) => {
        if (opened || request !== replyNavigationRequestRef.current) return;
        setReplyNavigationTargetId(null);
      });
    },
    [openAtMessage, viewMessages]
  );

  const handleHighlightedMessageResolved = useCallback((messageId: string) => {
    removeShellSearchParam('msg', messageId);
    setReplyNavigationTargetId((current) => (current === messageId ? null : current));
  }, []);

  const applyItem = useCallback(
    (item: SessionCommandMenuItem) => {
      if (item.executeOnSelect) {
        clearComposerInput();
        const replyToMessageId = replyTargetId ?? undefined;
        const generation = replyGeneration;
        void handleSend(item.insert.trim(), [], replyToMessageId, undefined, generation).then((succeeded) => {
          if (replyToMessageId) finishReplySend(generation, succeeded);
        });
        return;
      }
      applyCommandInsert(item);
    },
    [applyCommandInsert, clearComposerInput, finishReplySend, handleSend, replyGeneration, replyTargetId]
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
              onRename: currentSession ? renameCurrentSession : undefined,
              onRetryDraftSession: draftSession?.status === 'failed' ? retryDraftSession : undefined,
              onSelectSession: (sessionId) => {
                setOptimistic([]);
                setSessionUrl(sessionId);
              },
              onUnarchive: () => void unarchiveCurrentSession()
            },
            transcript: {
              highlightedMessageId: deepLinkMsg ?? replyNavigationTargetId,
              isLoading: draftSession === null && streamData?.snapshotReceived !== true,
              messageOutline: streamData?.messageOutline ?? [],
              showLoadingSkeleton: getActiveDaemonConnection(daemonBaseUrl).type === 'remote',
              onApproval: (approval, allow, scope, reason) => {
                void approveTool({ requestId: approval.requestId, allow, scope, reason });
              },
              onBranch: handleBranch,
              onClarifyAnswer: (requestId, response) => void clarifyRespond({ requestId, ...response }),
              onEndReached: transcript.loadNewer,
              onHighlightedMessageResolved: handleHighlightedMessageResolved,
              onOpenMessage: handleOpenMessage,
              onReply: setReplyTargetId,
              onRestore: handleRestore,
              onScrollToBottom: scrollToBottom,
              onStartReached: transcript.loadOlder,
              pendingApprovals,
              pendingClarifications,
              replyTargets,
              transcriptRef,
              viewMessages
            },
            composer: {
              attachmentError: composerAttachmentError,
              attachments: attachmentItems,
              commandMenuLoading,
              composerSettings,
              contextUsage: sessionContextUsage,
              isBusy,
              menuItems,
              messageQueue,
              model: sessionModel,
              onCancelQueued: cancelQueuedMessages,
              onAttachFiles: addComposerFiles,
              onCommandItemApply: applyItem,
              onKeyDown: handleTextareaKeyDown,
              onRemoveQueuedMessage: removeQueuedMessage,
              onCancelReply: () => setReplyTargetId(null),
              onOpenReplyTarget: () => {
                if (replyTarget) handleOpenMessage(replyTarget.id);
              },
              onOpenAttachment: (localId) => void openAttachment(localId),
              onRemoveAttachment: removeAttachment,
              onSteerQueued: () => void handleSteerQueued(),
              onStop: handleStop,
              onSubmit: () => void handleSubmit(),
              onVoiceSettingsClick: () => pushShellUrl(studioPath('models')),
              onVoiceTranscribe: async (audio) => {
                const body = await audioBlobToBase64(audio);
                return (await transcribeAudio(body).unwrap()).text;
              },
              skillMenuOpen,
              replyTarget,
              replyTargetId,
              voiceModelConfigured
            },
            inspector: {
              items: inspectorItems
            }
          }
        : null,
    [
      currentId,
      attachmentItems,
      composerAttachmentError,
      commands,
      daemonBaseUrl,
      sessionContextUsage,
      currentSession,
      isCurrentSessionDeleted,
      deepLinkMsg,
      replyNavigationTargetId,
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
      addComposerFiles,
      cancelQueuedMessages,
      openAttachment,
      handleBranch,
      handleHighlightedMessageResolved,
      handleOpenMessage,
      clarifyRespond,
      removeQueuedMessage,
      removeAttachment,
      renameCurrentSession,
      replyTarget,
      replyTargetId,
      replyTargets,
      setReplyTargetId,
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
      streamData?.messageOutline,
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
