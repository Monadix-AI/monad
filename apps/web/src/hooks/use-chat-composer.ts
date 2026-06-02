import type {
  ChatMessage,
  ComposerFollowUpBehavior,
  MessageId,
  SendMessageAttachment,
  SessionId,
  UIItem
} from '@monad/protocol';

import {
  useAbortSessionMutation,
  useBranchSessionMutation,
  useGenerateMutation,
  useResetSessionMutation,
  useRestoreSessionMutation,
  useSendMessageMutation,
  useSendProjectMessageMutation
} from '@monad/client-rtk';
import { parseSlashCommand } from '@monad/protocol';
import { type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';

import { branchFromMessage } from '#/features/session/branch-from-message';
import { type Msg } from '#/features/session/ChatMessage';
import { viewItemKey } from '#/features/session/chat-view-items';
import { buildPendingTurnFeedback } from '#/features/session/draft-session-feedback';
import { rewindUserMessage } from '#/features/session/rewind-user-message';
import { type SessionQueuedMessage, sessionMessagesCanSteer } from '#/features/session/session-route-contract';
import { type InitialUserMessage, useSessionUiStoreForSession } from '#/features/session/session-ui-store';
import { countServerUserMessagesByText, reconcileOptimisticMessages } from '#/features/session/session-view';
import { messageAttachmentsFromSend } from '#/features/session/use-composer-attachments';

type CommandEffect = { type: string; sessionId?: string; compacted?: number; mode?: 'detail' | 'summary' };

const EMPTY_MESSAGES: Msg[] = [];
const EMPTY_INITIAL_MESSAGE_QUEUE: InitialUserMessage[] = [];

const EMPTY_MESSAGE_QUEUE: SessionQueuedMessage[] = [];
const LOCAL_IMAGE_PREVIEW_CACHE_MAX_BYTES = 20_000_000;

const isEmptyMessages = (value: Msg[]) => value.length === 0;
const isEmptyMessageQueue = (value: SessionQueuedMessage[]) => value.length === 0;
const isEmptyPendingCommand = (value: string | null) => value === null;

function hasLocalImagePreview(message: Msg): boolean {
  return Boolean(message.attachments?.some((attachment) => attachment.imageSrc));
}

function boundedLocalImagePreviews(messages: Msg[]): Msg[] {
  const retained: Msg[] = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const messageBytes =
      message.attachments?.reduce((total, attachment) => total + (attachment.imageSrc?.length ?? 0), 0) ?? 0;
    if (messageBytes === 0 || bytes + messageBytes > LOCAL_IMAGE_PREVIEW_CACHE_MAX_BYTES) continue;
    retained.unshift(message);
    bytes += messageBytes;
  }
  return retained;
}

export function steerSendMessageRequest(sessionId: SessionId, followUps: string[]) {
  if (followUps.length === 0) throw new Error('steer requires at least one follow-up');
  if (followUps.length === 1) return { sessionId, steer: true as const, text: followUps[0] ?? '' };
  return { sessionId, steer: true as const, steerMessages: followUps, text: '' };
}

export function parseComposerSlashCommand(text: string, attachments: readonly SendMessageAttachment[]) {
  return attachments.length === 0 ? parseSlashCommand(text) : null;
}

interface UseChatComposerArgs {
  clearComposerAttachments: () => void;
  composerAttachments: SendMessageAttachment[];
  currentId: SessionId | null;
  liveStreaming: boolean;
  history: UIItem[];
  liveItems: UIItem[];
  streamData: { items: UIItem[] } | undefined;
  scrollToBottom: (behavior?: 'smooth' | 'auto') => void;
  jumpToLive: () => void;
  setSessionUrl: (id: SessionId | null) => void;
  followUpBehavior: ComposerFollowUpBehavior;
  assistantLabel: string;
  isProjectSession: boolean;
  replyTargetId: string | null;
  replyGeneration: number;
  finishReplySend: (generation: number, succeeded: boolean) => void;
}

export async function completeReplySend(
  send: () => Promise<boolean>,
  finish: (succeeded: boolean) => void
): Promise<boolean> {
  const succeeded = await send();
  finish(succeeded);
  return succeeded;
}

export function drainSessionMessageQueue(
  queue: readonly SessionQueuedMessage[]
): { next: SessionQueuedMessage; remaining: SessionQueuedMessage[] } | null {
  const first = queue[0];
  if (!first) return null;
  let drainCount = 1;
  while (
    drainCount < queue.length &&
    !first.attachments?.length &&
    !queue[drainCount]?.attachments?.length &&
    queue[drainCount]?.replyToMessageId === first.replyToMessageId &&
    queue[drainCount]?.replyGeneration === first.replyGeneration
  ) {
    drainCount += 1;
  }
  return {
    next: {
      ...first,
      text: queue
        .slice(0, drainCount)
        .map((item) => item.text)
        .join('\n\n')
    },
    remaining: queue.slice(drainCount)
  };
}

export function removeSessionQueuedMessage(
  queue: readonly SessionQueuedMessage[],
  index: number
): SessionQueuedMessage[] {
  return queue.filter((_, itemIndex) => itemIndex !== index);
}

function useSessionScopedState<T>({
  empty,
  isEmpty,
  sessionId
}: {
  empty: T;
  isEmpty: (value: T) => boolean;
  sessionId: SessionId | null;
}): [T, (action: SetStateAction<T>) => void] {
  const [bySession, setBySession] = useState<Record<string, T>>({});
  const value = sessionId ? (bySession[sessionId] ?? empty) : empty;
  const setValue = useCallback(
    (action: SetStateAction<T>) => {
      if (!sessionId) return;
      setBySession((prev) => {
        const current = prev[sessionId] ?? empty;
        const next = typeof action === 'function' ? (action as (value: T) => T)(current) : action;
        if (isEmpty(next)) {
          const copy = { ...prev };
          delete copy[sessionId];
          return copy;
        }
        return { ...prev, [sessionId]: next };
      });
    },
    [empty, isEmpty, sessionId]
  );
  return [value, setValue];
}

// Owns the send pipeline: optimistic echo, slash-command dispatch + structured effects, the
// queue-while-busy → drain-on-idle flow, and the rewind/branch/reset turn actions.
export function useChatComposer({
  clearComposerAttachments,
  composerAttachments,
  currentId,
  liveStreaming,
  history,
  liveItems,
  streamData,
  scrollToBottom,
  jumpToLive,
  setSessionUrl,
  followUpBehavior,
  assistantLabel,
  isProjectSession,
  replyTargetId,
  replyGeneration,
  finishReplySend
}: UseChatComposerArgs) {
  const [generate, { isLoading: generating }] = useGenerateMutation();
  const [sendMessage, { isLoading: sending }] = useSendMessageMutation();
  const [sendProjectMessage, { isLoading: sendingProjectMessage }] = useSendProjectMessageMutation();
  const [abortSession] = useAbortSessionMutation();
  const [resetSession] = useResetSessionMutation();
  const [branchSession] = useBranchSessionMutation();
  const [restoreSession] = useRestoreSessionMutation();

  const [optimistic, setOptimistic] = useSessionScopedState({
    empty: EMPTY_MESSAGES,
    isEmpty: isEmptyMessages,
    sessionId: currentId
  });
  const [commandPending, setCommandPending] = useSessionScopedState({
    empty: null as string | null,
    isEmpty: isEmptyPendingCommand,
    sessionId: currentId
  });
  const [messageQueue, setMessageQueue] = useSessionScopedState({
    empty: EMPTY_MESSAGE_QUEUE,
    isEmpty: isEmptyMessageQueue,
    sessionId: currentId
  });
  const input = useSessionUiStoreForSession(currentId, (state) => state.input);
  const clearComposerInput = useSessionUiStoreForSession(currentId, (state) => state.clearComposerInput);
  const initialUserMessages = useSessionUiStoreForSession(currentId, (state) =>
    currentId
      ? (state.initialUserMessagesBySession[currentId] ?? EMPTY_INITIAL_MESSAGE_QUEUE)
      : EMPTY_INITIAL_MESSAGE_QUEUE
  );
  const clearInitialUserMessages = useSessionUiStoreForSession(currentId, (state) => state.clearInitialUserMessages);
  const setHiddenViewItemKeysBySession = useSessionUiStoreForSession(
    currentId,
    (state) => state.setHiddenViewItemKeysBySession
  );
  const setTranscriptRenderMode = useSessionUiStoreForSession(currentId, (state) => state.setTranscriptRenderMode);
  const messageQueueRef = useRef<SessionQueuedMessage[]>([]);
  const prevBusyRef = useRef(false);
  const submitBusyRef = useRef(false);
  const handleSendRef = useRef<
    | ((
        text: string,
        attachments?: SendMessageAttachment[],
        replyToMessageId?: string,
        existingMessageId?: string,
        generation?: number
      ) => Promise<boolean>)
    | null
  >(null);

  const streamDataRef = useRef(streamData);
  useEffect(() => {
    streamDataRef.current = streamData;
  }, [streamData]);

  const optimisticAssistantPending = optimistic.some((message) => message.role === 'assistant' && message.pending);
  const isBusy =
    sending ||
    sendingProjectMessage ||
    generating ||
    commandPending !== null ||
    liveStreaming ||
    optimisticAssistantPending;
  if (isBusy) submitBusyRef.current = true;

  useEffect(() => {
    if (!isBusy) submitBusyRef.current = false;
  }, [isBusy]);

  useEffect(() => {
    if (!currentId || initialUserMessages.length === 0) return;
    const messages = initialUserMessages.flatMap((message) =>
      buildPendingTurnFeedback({
        agentLabel: assistantLabel,
        id: `local-home-${crypto.randomUUID()}`,
        message
      })
    );
    setOptimistic((prev) => [...prev, ...messages]);
    clearInitialUserMessages(currentId);
    requestAnimationFrame(() => scrollToBottom('smooth'));
  }, [assistantLabel, currentId, initialUserMessages, clearInitialUserMessages, scrollToBottom, setOptimistic]);

  useEffect(() => {
    if (optimistic.length === 0) return;
    setOptimistic((prev) => {
      const next = reconcileOptimisticMessages({
        legacyServerItems: liveItems,
        optimistic: prev,
        serverItems: [...history, ...liveItems]
      });
      if (next.length === prev.length) return prev;
      const pendingIds = new Set(next.map((message) => message.id));
      const settledPreviews = boundedLocalImagePreviews(
        prev.filter((message) => !pendingIds.has(message.id) && hasLocalImagePreview(message))
      );
      return [...next, ...settledPreviews];
    });
  }, [history, liveItems, optimistic.length, setOptimistic]);

  const handleStop = useCallback(() => {
    if (currentId) void abortSession(currentId);
  }, [currentId, abortSession]);

  const handleReset = useCallback(async () => {
    if (!currentId || isBusy) return;
    await resetSession(currentId);
    setHiddenViewItemKeysBySession((prev) => {
      const next = { ...prev };
      delete next[currentId];
      return next;
    });
    setOptimistic([]);
    jumpToLive();
  }, [currentId, isBusy, resetSession, jumpToLive, setHiddenViewItemKeysBySession, setOptimistic]);

  // Copy the conversation through this message into an independent session, then jump to it.
  const handleBranch = useCallback(
    async (atMessageId: string) => {
      if (!currentId) return;
      await branchFromMessage({
        branch: (messageId) => branchSession({ id: currentId, atMessageId: messageId }).unwrap(),
        continueFromHistory: (sessionId) => sendMessage({ continueFromHistory: true, sessionId, text: '' }).unwrap(),
        messageId: atMessageId as MessageId,
        onBranched: (sessionId) => {
          setOptimistic([]);
          setSessionUrl(sessionId);
        }
      }).catch(() => null);
    },
    [currentId, branchSession, sendMessage, setSessionUrl, setOptimistic]
  );

  // React to a host command's structured effect (rich-client behaviour; dumb clients just show text).
  const applyCommandEffect = useCallback(
    (effect: CommandEffect | undefined) => {
      if (!effect) return undefined;
      if ((effect.type === 'session-created' || effect.type === 'session-switched') && effect.sessionId) {
        setSessionUrl(effect.sessionId as SessionId);
      } else if (effect.type === 'history-reset' || effect.type === 'compacted') {
        setOptimistic([]);
        jumpToLive();
      } else if (effect.type === 'view-clear' && currentId) {
        const keys = [...history, ...liveItems].flatMap((item) => {
          const key = viewItemKey(item);
          return key ? [key] : [];
        });
        setHiddenViewItemKeysBySession((prev) => ({ ...prev, [currentId]: keys }));
        setOptimistic([]);
      } else if (effect.type === 'observation-render-mode-changed') {
        if (effect.mode === 'detail' || effect.mode === 'summary') setTranscriptRenderMode(effect.mode);
      }
      return effect.type;
    },
    [
      setSessionUrl,
      jumpToLive,
      currentId,
      history,
      liveItems,
      setHiddenViewItemKeysBySession,
      setOptimistic,
      setTranscriptRenderMode
    ]
  );

  const handleSend = useCallback(
    async (
      text: string,
      attachments: SendMessageAttachment[] = [],
      replyToMessageId?: string,
      existingMessageId?: string,
      generation?: number
    ): Promise<boolean> => {
      if ((!text && attachments.length === 0) || !currentId) return false;

      if (attachments.length === 0 && text === '/reset') {
        void handleReset();
        return false;
      }

      const parsedCommand = parseComposerSlashCommand(text, attachments);
      if (parsedCommand) {
        setCommandPending(parsedCommand.name);
        if (parsedCommand.name === 'compact') {
          setOptimistic((prev) => [...prev, { id: `compact-${crypto.randomUUID()}`, role: 'user', text }]);
          requestAnimationFrame(() => scrollToBottom('smooth'));
        }
        try {
          const msg = (await generate({
            id: currentId,
            text,
            replyToMessageId: replyToMessageId as MessageId | undefined
          }).unwrap()) as ChatMessage;
          const effect = (msg.data as { effect?: CommandEffect } | undefined)?.effect;
          const effectType = applyCommandEffect(effect);
          if (parsedCommand.name === 'compact' && effect?.compacted && effect.compacted > 0) {
            jumpToLive();
          } else if (effectType === 'view-clear') {
            return true;
          } else {
            jumpToLive();
          }
        } catch {
          jumpToLive();
          return false;
        } finally {
          setCommandPending(null);
        }
        return true;
      }

      const localId = crypto.randomUUID();
      const userMessageId = existingMessageId ?? `local-${localId}`;
      const retrySend = () => {
        void handleSendRef
          .current?.(text, attachments, replyToMessageId, userMessageId, generation)
          .then((succeeded) => generation !== undefined && finishReplySend(generation, succeeded));
      };
      const userMsg: Msg = {
        id: userMessageId,
        role: 'user',
        text,
        ...(attachments.length ? { attachments: messageAttachmentsFromSend(attachments) } : {}),
        ...(replyToMessageId ? { replyToMessageId } : {}),
        retrySend
      };
      const assistantActivity: Msg = {
        id: `local-assistant-${localId}`,
        role: 'assistant',
        text: '',
        pending: true,
        label: assistantLabel
      };
      setOptimistic((prev) => [
        ...(existingMessageId
          ? prev.map((message) => (message.id === existingMessageId ? userMsg : message))
          : [...prev, userMsg]),
        assistantActivity
      ]);
      requestAnimationFrame(() => scrollToBottom('smooth'));

      try {
        // Count assistant messages before sending so we can detect the reply (success or error)
        // landing via the event stream. Scoped to assistant: the stream also carries the
        // user-turn echo, which must not be mistaken for the turn ending.
        const assistantCount = () =>
          streamDataRef.current?.items.filter((item) => item.kind === 'message' && item.role === 'assistant').length ??
          0;
        const beforeStreamMsgs = assistantCount();
        if (isProjectSession) {
          await sendProjectMessage({
            sessionId: currentId,
            text,
            ...(attachments.length ? { attachments } : {}),
            replyToMessageId: replyToMessageId as MessageId | undefined
          }).unwrap();
          setOptimistic((prev) => prev.filter((m) => m.id !== assistantActivity.id));
          return true;
        }
        await sendMessage({
          sessionId: currentId,
          text,
          ...(attachments.length ? { attachments } : {}),
          replyToMessageId: replyToMessageId as MessageId | undefined
        }).unwrap();
        // Wait for the assistant reply to land on the live stream so the turn always shows up.
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 750));
          if (assistantCount() > beforeStreamMsgs) {
            setOptimistic((prev) => prev.filter((m) => m.id !== assistantActivity.id));
            break;
          }
        }
        return true;
      } catch {
        setOptimistic((prev) =>
          prev
            .filter((m) => m.id !== assistantActivity.id)
            .map((m) => (m.id === userMsg.id ? { ...m, error: true, retrySend } : m))
        );
        return false;
      }
    },
    [
      currentId,
      sendMessage,
      sendProjectMessage,
      isProjectSession,
      generate,
      scrollToBottom,
      handleReset,
      applyCommandEffect,
      jumpToLive,
      setOptimistic,
      setCommandPending,
      assistantLabel,
      finishReplySend
    ]
  );

  const handleRestore = useCallback(
    async (toMessageId: string, text: string) => {
      if (!currentId) return false;
      const succeeded = await rewindUserMessage({
        messageId: toMessageId as MessageId,
        restore: (request) => restoreSession(request).unwrap(),
        send: async (replacement) => {
          setOptimistic([]);
          jumpToLive();
          void handleSend(replacement);
        },
        sessionId: currentId,
        text
      });
      if (!succeeded) return false;
      return true;
    },
    [currentId, handleSend, restoreSession, jumpToLive, setOptimistic]
  );

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);
  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);

  const handleForceSteerText = useCallback(
    async (current?: SessionQueuedMessage) => {
      if (!currentId) return;
      const followUpItems = [...messageQueueRef.current, ...(current ? [current] : [])];
      const followUps = followUpItems.map((item) => item.text);
      if (followUps.length === 0) return;
      if (isProjectSession || !sessionMessagesCanSteer(followUpItems)) {
        setMessageQueue(followUpItems);
        messageQueueRef.current = followUpItems;
        return;
      }
      setMessageQueue([]);
      messageQueueRef.current = [];
      const serverUserTextCounts = countServerUserMessagesByText([...history, ...liveItems]);
      const optimisticMessages = followUps.map<Msg>((followUp) => {
        const serverEchoOrdinal = (serverUserTextCounts.get(followUp) ?? 0) + 1;
        serverUserTextCounts.set(followUp, serverEchoOrdinal);
        return {
          id: `local-steer-${crypto.randomUUID()}`,
          role: 'user',
          serverEchoOrdinal,
          text: followUp
        };
      });
      setOptimistic((prev) => [...prev, ...optimisticMessages]);
      requestAnimationFrame(() => scrollToBottom('smooth'));
      try {
        await sendMessage(steerSendMessageRequest(currentId, followUps)).unwrap();
      } catch {
        const failedIds = new Set(optimisticMessages.map((message) => message.id));
        setOptimistic((prev) =>
          prev.map((message) => (failedIds.has(message.id) ? { ...message, error: true } : message))
        );
      }
    },
    [currentId, history, isProjectSession, liveItems, scrollToBottom, sendMessage, setMessageQueue, setOptimistic]
  );

  // When generation ends (stream or block), drain the next compatible queue prefix as one turn.
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = isBusy;
    if (wasBusy && !isBusy && messageQueueRef.current.length > 0) {
      const drained = drainSessionMessageQueue(messageQueueRef.current);
      if (!drained) return;
      setMessageQueue(drained.remaining);
      messageQueueRef.current = drained.remaining;
      const queued = drained.next;
      void handleSendRef
        .current?.(queued.text, queued.attachments, queued.replyToMessageId, undefined, queued.replyGeneration)
        .then(
          (succeeded) => queued.replyGeneration !== undefined && finishReplySend(queued.replyGeneration, succeeded)
        );
    }
  }, [finishReplySend, isBusy, setMessageQueue]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    const attachments = composerAttachments;
    if ((!text && attachments.length === 0) || !currentId) return;
    const replyToMessageId = replyTargetId ?? undefined;
    const generation = replyGeneration;
    clearComposerInput();
    clearComposerAttachments();
    const busy = submitBusyRef.current || isBusy;
    const queuedMessage = {
      text,
      ...(attachments.length ? { attachments } : {}),
      ...(replyToMessageId ? { replyGeneration: generation, replyToMessageId } : {})
    };
    if (busy) {
      if (followUpBehavior === 'steer' && sessionMessagesCanSteer([queuedMessage])) {
        await handleForceSteerText(queuedMessage);
        return;
      }
      setMessageQueue((queue) => [...queue, queuedMessage]);
      return;
    }
    submitBusyRef.current = true;
    try {
      await completeReplySend(
        () => handleSend(text, attachments, replyToMessageId, undefined, generation),
        (succeeded) => replyToMessageId && finishReplySend(generation, succeeded)
      );
    } finally {
      submitBusyRef.current = false;
    }
  }, [
    input,
    composerAttachments,
    currentId,
    isBusy,
    followUpBehavior,
    handleSend,
    handleForceSteerText,
    clearComposerInput,
    clearComposerAttachments,
    setMessageQueue,
    replyTargetId,
    replyGeneration,
    finishReplySend
  ]);

  const handleQueueSubmit = useCallback(async () => {
    const text = input.trim();
    const attachments = composerAttachments;
    if ((!text && attachments.length === 0) || !currentId) return;
    const replyToMessageId = replyTargetId ?? undefined;
    const generation = replyGeneration;
    clearComposerInput();
    clearComposerAttachments();
    const busy = submitBusyRef.current || isBusy;
    if (busy) {
      setMessageQueue((queue) => [
        ...queue,
        {
          text,
          ...(attachments.length ? { attachments } : {}),
          ...(replyToMessageId ? { replyGeneration: generation, replyToMessageId } : {})
        }
      ]);
      return;
    }
    submitBusyRef.current = true;
    try {
      await completeReplySend(
        () => handleSend(text, attachments, replyToMessageId, undefined, generation),
        (succeeded) => replyToMessageId && finishReplySend(generation, succeeded)
      );
    } finally {
      submitBusyRef.current = false;
    }
  }, [
    input,
    composerAttachments,
    currentId,
    isBusy,
    handleSend,
    clearComposerInput,
    clearComposerAttachments,
    setMessageQueue,
    replyTargetId,
    replyGeneration,
    finishReplySend
  ]);

  const handleForceSteer = useCallback(async () => {
    if (!currentId) return;
    const text = input.trim();
    const attachments = composerAttachments;
    if (!text && attachments.length === 0) return;
    const replyToMessageId = replyTargetId ?? undefined;
    const generation = replyGeneration;
    clearComposerInput();
    clearComposerAttachments();
    await handleForceSteerText({
      text,
      ...(attachments.length ? { attachments } : {}),
      ...(replyToMessageId ? { replyGeneration: generation, replyToMessageId } : {})
    });
  }, [
    currentId,
    input,
    composerAttachments,
    clearComposerInput,
    clearComposerAttachments,
    handleForceSteerText,
    replyGeneration,
    replyTargetId
  ]);

  const handleSteerQueued = useCallback(async () => {
    await handleForceSteerText();
  }, [handleForceSteerText]);

  const removeQueuedMessage = useCallback(
    (index: number) => {
      setMessageQueue((queue) => {
        return removeSessionQueuedMessage(queue, index);
      });
    },
    [setMessageQueue]
  );

  const cancelQueuedMessages = useCallback(() => {
    messageQueueRef.current = [];
    setMessageQueue([]);
  }, [setMessageQueue]);

  return {
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
  };
}
