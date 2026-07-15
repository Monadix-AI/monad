import type { ChatMessage, ComposerFollowUpBehavior, MessageId, SessionId, UIItem } from '@monad/protocol';

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
import { messageTextFromParts, viewItemKey } from '#/features/session/chat-view-items';
import { rewindUserMessage } from '#/features/session/rewind-user-message';
import { useSessionUiStore } from '#/features/session/session-ui-store';

type CommandEffect = { type: string; sessionId?: string; compacted?: number };

const EMPTY_MESSAGES: Msg[] = [];
const EMPTY_QUEUE: string[] = [];

const isEmptyMessages = (value: Msg[]) => value.length === 0;
const isEmptyQueue = (value: string[]) => value.length === 0;
const isEmptyPendingCommand = (value: string | null) => value === null;

interface UseChatComposerArgs {
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
  isProjectSession
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
    empty: EMPTY_QUEUE,
    isEmpty: isEmptyQueue,
    sessionId: currentId
  });
  const input = useSessionUiStore((state) => state.input);
  const clearComposerInput = useSessionUiStore((state) => state.clearComposerInput);
  const setComposerInput = useSessionUiStore((state) => state.setComposerInput);
  const initialUserMessages = useSessionUiStore((state) =>
    currentId ? (state.initialUserMessagesBySession[currentId] ?? EMPTY_QUEUE) : EMPTY_QUEUE
  );
  const clearInitialUserMessages = useSessionUiStore((state) => state.clearInitialUserMessages);
  const setHiddenViewItemKeysBySession = useSessionUiStore((state) => state.setHiddenViewItemKeysBySession);
  const messageQueueRef = useRef<string[]>([]);
  const prevBusyRef = useRef(false);
  const handleSendRef = useRef<((text: string) => Promise<void>) | null>(null);

  const streamDataRef = useRef(streamData);
  useEffect(() => {
    streamDataRef.current = streamData;
  }, [streamData]);

  const isBusy = sending || sendingProjectMessage || generating || commandPending !== null || liveStreaming;

  useEffect(() => {
    if (!currentId || initialUserMessages.length === 0) return;
    const messages = initialUserMessages.map((text) => ({
      id: `local-home-${crypto.randomUUID()}`,
      role: 'user' as const,
      text
    }));
    setOptimistic((prev) => [...prev, ...messages]);
    clearInitialUserMessages(currentId);
    requestAnimationFrame(() => scrollToBottom('smooth'));
  }, [currentId, initialUserMessages, clearInitialUserMessages, scrollToBottom, setOptimistic]);

  // Drop optimistic user messages one-for-one as the live stream echoes them back. Text is the only
  // correlation key available today, so counts matter: two identical submits must not both disappear
  // when only one server echo has arrived.
  useEffect(() => {
    if (optimistic.length === 0) return;
    const liveUserTextCounts = new Map<string, number>();
    for (const item of liveItems) {
      if (item.kind !== 'message' || item.role !== 'user') continue;
      const text = messageTextFromParts(item.parts);
      liveUserTextCounts.set(text, (liveUserTextCounts.get(text) ?? 0) + 1);
    }
    setOptimistic((prev) =>
      prev.filter((message) => {
        if (message.role !== 'user') return true;
        const count = liveUserTextCounts.get(message.text) ?? 0;
        if (count <= 0) return true;
        liveUserTextCounts.set(message.text, count - 1);
        return false;
      })
    );
  }, [liveItems, optimistic.length, setOptimistic]);

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

  // Fork the conversation into a child session at this message, then jump to it.
  const handleBranch = useCallback(
    async (atMessageId: string, role: Msg['role']) => {
      if (!currentId) return;
      await branchFromMessage({
        branch: (messageId) => branchSession({ id: currentId, atMessageId: messageId }).unwrap(),
        continueFromHistory: (sessionId) => sendMessage({ continueFromHistory: true, sessionId, text: '' }).unwrap(),
        messageId: atMessageId as MessageId,
        onBranched: (sessionId) => {
          setOptimistic([]);
          setSessionUrl(sessionId);
        },
        role
      }).catch(() => null);
    },
    [currentId, branchSession, sendMessage, setSessionUrl, setOptimistic]
  );

  // Rewind from this user message, then put its raw text back into the composer.
  const handleRestore = useCallback(
    async (toMessageId: string, text: string) => {
      if (!currentId || isBusy) return;
      const restoredText = await rewindUserMessage({
        messageId: toMessageId as MessageId,
        restore: (request) => restoreSession(request).unwrap(),
        sessionId: currentId,
        text
      });
      if (restoredText === null) return;
      setComposerInput(restoredText);
      setOptimistic([]);
      jumpToLive();
    },
    [currentId, isBusy, restoreSession, setComposerInput, jumpToLive, setOptimistic]
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
      }
      return effect.type;
    },
    [setSessionUrl, jumpToLive, currentId, history, liveItems, setHiddenViewItemKeysBySession, setOptimistic]
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (!text || !currentId) return;

      if (text === '/reset') {
        void handleReset();
        return;
      }

      const parsedCommand = parseSlashCommand(text);
      if (parsedCommand) {
        setCommandPending(parsedCommand.name);
        if (parsedCommand.name === 'compact') {
          setOptimistic((prev) => [...prev, { id: `compact-${crypto.randomUUID()}`, role: 'user', text }]);
          requestAnimationFrame(() => scrollToBottom('smooth'));
        }
        try {
          const msg = (await generate({ id: currentId, text }).unwrap()) as ChatMessage;
          const effect = (msg.data as { effect?: CommandEffect } | undefined)?.effect;
          const effectType = applyCommandEffect(effect);
          if (parsedCommand.name === 'compact' && effect?.compacted && effect.compacted > 0) {
            jumpToLive();
          } else if (effectType === 'view-clear') {
            return;
          } else {
            jumpToLive();
          }
        } catch {
          jumpToLive();
        } finally {
          setCommandPending(null);
        }
        return;
      }

      const localId = crypto.randomUUID();
      const userMsg: Msg = { id: `local-${localId}`, role: 'user', text };
      const assistantActivity: Msg = {
        id: `local-assistant-${localId}`,
        role: 'assistant',
        text: '',
        pending: true,
        label: assistantLabel
      };
      setOptimistic((prev) => [...prev, userMsg, assistantActivity]);
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
          await sendProjectMessage({ sessionId: currentId, text }).unwrap();
          setOptimistic((prev) => prev.filter((m) => m.id !== assistantActivity.id));
          return;
        }
        await sendMessage({ sessionId: currentId, text }).unwrap();
        // Wait for the assistant reply to land on the live stream so the turn always shows up.
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 750));
          if (assistantCount() > beforeStreamMsgs) {
            setOptimistic((prev) => prev.filter((m) => m.id !== assistantActivity.id));
            break;
          }
        }
      } catch {
        setOptimistic((prev) =>
          prev
            .filter((m) => m.id !== assistantActivity.id)
            .map((m) => (m.id === userMsg.id ? { ...m, error: true } : m))
        );
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
      assistantLabel
    ]
  );

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);
  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);

  const handleForceSteerText = useCallback(
    async (text: string) => {
      if (!currentId) return;
      const merged = [...messageQueueRef.current, ...(text ? [text] : [])].join('\n\n');
      if (!merged) return;
      setMessageQueue([]);
      messageQueueRef.current = [];
      clearComposerInput();
      void abortSession(currentId);
      await new Promise((r) => setTimeout(r, 100));
      await handleSend(merged);
    },
    [currentId, abortSession, clearComposerInput, handleSend, setMessageQueue]
  );

  // When generation ends (stream or block), drain the queue: merge all queued messages and send as one turn.
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = isBusy;
    if (wasBusy && !isBusy && messageQueueRef.current.length > 0) {
      const text = messageQueueRef.current.join('\n\n');
      setMessageQueue([]);
      messageQueueRef.current = [];
      void handleSendRef.current?.(text);
    }
  }, [isBusy, setMessageQueue]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || !currentId) return;
    clearComposerInput();
    if (isBusy) {
      if (followUpBehavior === 'steer') {
        await handleForceSteerText(text);
        return;
      }
      setMessageQueue((q) => [...q, text]);
      return;
    }
    await handleSend(text);
  }, [
    input,
    currentId,
    isBusy,
    followUpBehavior,
    handleSend,
    handleForceSteerText,
    clearComposerInput,
    setMessageQueue
  ]);

  const handleQueueSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || !currentId) return;
    clearComposerInput();
    if (isBusy) {
      setMessageQueue((queue) => [...queue, text]);
      return;
    }
    await handleSend(text);
  }, [input, currentId, isBusy, handleSend, clearComposerInput, setMessageQueue]);

  const handleForceSteer = useCallback(async () => {
    if (!currentId) return;
    const text = input.trim();
    await handleForceSteerText(text);
  }, [currentId, input, handleForceSteerText]);

  const removeQueuedMessage = useCallback(
    (index: number) => {
      setMessageQueue((queue) => queue.filter((_, itemIndex) => itemIndex !== index));
    },
    [setMessageQueue]
  );

  return {
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
    handleQueueSubmit,
    handleForceSteer,
    removeQueuedMessage
  };
}
