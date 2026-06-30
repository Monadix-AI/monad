import type { ChatMessage, MessageId, SessionId, UIItem, UIMessageItem } from '@monad/protocol';

import {
  useAbortSessionMutation,
  useBranchSessionMutation,
  useGenerateMutation,
  useResetSessionMutation,
  useRestoreSessionMutation,
  useSendMessageMutation
} from '@monad/client-rtk';
import { parseSlashCommand } from '@monad/protocol';
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';

import { type Msg } from '@/features/session/ChatMessage';
import { textFromParts, viewItemKey } from '@/features/session/chat-view-items';

type CommandEffect = { type: string; sessionId?: string; compacted?: number };

interface UseChatComposerArgs {
  currentId: SessionId | null;
  liveStreaming: boolean;
  history: UIItem[];
  liveItems: UIItem[];
  streamData: { items: UIItem[] } | undefined;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  scrollToBottom: (behavior?: 'smooth' | 'auto') => void;
  jumpToLive: () => void;
  setSessionUrl: (id: SessionId | null) => void;
  setHiddenViewItemKeysBySession: Dispatch<SetStateAction<Record<string, string[]>>>;
}

// Owns the send pipeline: optimistic echo, slash-command dispatch + structured effects, the
// queue-while-busy → drain-on-idle flow, and the rewind/branch/reset turn actions.
export function useChatComposer({
  currentId,
  liveStreaming,
  history,
  liveItems,
  streamData,
  input,
  setInput,
  scrollToBottom,
  jumpToLive,
  setSessionUrl,
  setHiddenViewItemKeysBySession
}: UseChatComposerArgs) {
  const [generate, { isLoading: generating }] = useGenerateMutation();
  const [sendMessage, { isLoading: sending }] = useSendMessageMutation();
  const [abortSession] = useAbortSessionMutation();
  const [resetSession] = useResetSessionMutation();
  const [branchSession] = useBranchSessionMutation();
  const [restoreSession] = useRestoreSessionMutation();

  const [optimistic, setOptimistic] = useState<Msg[]>([]);
  const [commandPending, setCommandPending] = useState<string | null>(null);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const messageQueueRef = useRef<string[]>([]);
  const prevBusyRef = useRef(false);
  const handleSendRef = useRef<((text: string) => Promise<void>) | null>(null);

  const streamDataRef = useRef(streamData);
  useEffect(() => {
    streamDataRef.current = streamData;
  }, [streamData]);

  const isBusy = sending || generating || commandPending !== null || liveStreaming;

  // Drop an optimistic user message once the live stream echoes it back.
  useEffect(() => {
    if (optimistic.length === 0) return;
    const liveUserTexts = new Set(
      liveItems
        .filter((item): item is UIMessageItem => item.kind === 'message' && item.role === 'user')
        .map((item) => textFromParts(item.parts))
    );
    setOptimistic((prev) => prev.filter((m) => !(m.role === 'user' && liveUserTexts.has(m.text))));
  }, [liveItems, optimistic.length]);

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
  }, [currentId, isBusy, resetSession, jumpToLive, setHiddenViewItemKeysBySession]);

  // Fork the conversation into a child session at this message, then jump to it.
  const handleBranch = useCallback(
    async (atMessageId: string) => {
      if (!currentId) return;
      const res = await branchSession({ id: currentId, atMessageId: atMessageId as MessageId })
        .unwrap()
        .catch(() => null);
      if (res) {
        setOptimistic([]);
        setSessionUrl(res.sessionId);
      }
    },
    [currentId, branchSession, setSessionUrl]
  );

  // Rewind the conversation to this message, dropping everything after it.
  const handleRestore = useCallback(
    async (toMessageId: string) => {
      if (!currentId || isBusy) return;
      await restoreSession({ id: currentId, toMessageId: toMessageId as MessageId })
        .unwrap()
        .catch(() => {});
      setOptimistic([]);
      jumpToLive();
    },
    [currentId, isBusy, restoreSession, jumpToLive]
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
    [setSessionUrl, jumpToLive, currentId, history, liveItems, setHiddenViewItemKeysBySession]
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

      const userMsg: Msg = { id: `local-${crypto.randomUUID()}`, role: 'user', text };
      setOptimistic((prev) => [...prev, userMsg]);
      requestAnimationFrame(() => scrollToBottom('smooth'));

      try {
        // Count assistant messages before sending so we can detect the reply (success or error)
        // landing via the event stream. Scoped to assistant: the stream also carries the
        // user-turn echo, which must not be mistaken for the turn ending.
        const assistantCount = () =>
          streamDataRef.current?.items.filter((item) => item.kind === 'message' && item.role === 'assistant').length ??
          0;
        const beforeStreamMsgs = assistantCount();
        await sendMessage({ sessionId: currentId, text }).unwrap();
        // Wait for the assistant reply to land on the live stream so the turn always shows up.
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 750));
          if (assistantCount() > beforeStreamMsgs) break;
        }
      } catch {
        setOptimistic((prev) => prev.filter((m) => m.id !== userMsg.id));
      }
    },
    [currentId, sendMessage, generate, scrollToBottom, handleReset, applyCommandEffect, jumpToLive]
  );

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);
  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);

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
  }, [isBusy]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || !currentId) return;
    setInput('');
    if (isBusy) {
      setMessageQueue((q) => [...q, text]);
      return;
    }
    await handleSend(text);
  }, [input, currentId, isBusy, handleSend, setInput]);

  const handleForceSteer = useCallback(async () => {
    if (!currentId) return;
    const text = input.trim();
    const merged = [...messageQueue, ...(text ? [text] : [])].join('\n\n');
    if (!merged) return;
    setMessageQueue([]);
    messageQueueRef.current = [];
    setInput('');
    void abortSession(currentId);
    await new Promise((r) => setTimeout(r, 100));
    await handleSend(merged);
  }, [currentId, input, messageQueue, abortSession, handleSend, setInput]);

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
    handleForceSteer
  };
}
