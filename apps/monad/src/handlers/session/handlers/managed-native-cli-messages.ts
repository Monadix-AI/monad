import type { Event, MessageAttachmentRef, MessageId, TranscriptTargetId } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';

import { newId } from '@monad/protocol';

/** "Thinking" placeholder lifecycle + durable Q&A wall messages for managed native-CLI project
 *  members: the store/event bookkeeping that mirrors a native CLI process's streamed reply into the
 *  transcript. Extracted from managed-native-cli-delivery.ts — this half owns message state
 *  (`pendingManagedNativeCliWakeMessages`); process start/resume lives in
 *  managed-native-cli-runtime.ts, and fan-out/direct delivery stays in managed-native-cli-delivery.ts. */
export function createManagedNativeCliMessages(ctx: SessionContext) {
  const {
    deps: { store },
    makeEmit,
    persistAndRetire
  } = ctx;

  const pendingManagedNativeCliWakeMessages = new Map<string, MessageId>();

  function emitManagedNativeCliThinking(
    sessionId: TranscriptTargetId,
    nativeCliSessionId: string,
    agentName: string
  ): MessageId {
    const existing =
      pendingManagedNativeCliWakeMessages.get(nativeCliSessionId) ??
      store.findManagedNativeCliStreamingMessage(sessionId, nativeCliSessionId, agentName);
    if (existing) return existing as MessageId;
    const messageId = newId('msg');
    // Entries are deleted on completion, but a native CLI session that dies mid-turn never
    // completes; cap the map so abandoned wake placeholders can't accumulate for the daemon's
    // lifetime (oldest-first eviction — Map preserves insertion order).
    if (pendingManagedNativeCliWakeMessages.size >= 256) {
      const oldest = pendingManagedNativeCliWakeMessages.keys().next().value;
      if (oldest !== undefined) pendingManagedNativeCliWakeMessages.delete(oldest);
    }
    pendingManagedNativeCliWakeMessages.set(nativeCliSessionId, messageId);
    store.insertMessage(messageId, sessionId, '', new Date().toISOString(), 'assistant', {
      data: { agentName, nativeCliSessionId, reasoning: 'Thinking', source: 'managed-native-cli' },
      includeInContext: false,
      streamStatus: 'streaming'
    });
    const round: Event[] = [];
    const emit = makeEmit(round);
    emit({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.token',
      actorAgentId: null,
      payload: { messageId, agentName, delta: '', index: 0, source: 'managed-native-cli' },
      at: new Date().toISOString()
    });
    emit({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.reasoning',
      actorAgentId: null,
      payload: { messageId, delta: 'Thinking', index: 0, source: 'managed-native-cli' },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
    return messageId;
  }

  function completeManagedNativeCliThinking({
    sessionId,
    nativeCliSessionId,
    agentName,
    text,
    threadId,
    attachments,
    source = 'managed-native-cli',
    error = false
  }: {
    sessionId: TranscriptTargetId;
    nativeCliSessionId: string;
    agentName: string;
    text: string;
    threadId?: string;
    attachments?: MessageAttachmentRef[];
    source?: 'managed-native-cli' | 'native-cli-provider';
    error?: boolean;
  }): { messageId: MessageId } {
    const pendingMessageId =
      pendingManagedNativeCliWakeMessages.get(nativeCliSessionId) ??
      store.findManagedNativeCliStreamingMessage(sessionId, nativeCliSessionId, agentName);
    pendingManagedNativeCliWakeMessages.delete(nativeCliSessionId);
    const messageId = (pendingMessageId ?? newId('msg')) as MessageId;
    const data = {
      agentName,
      nativeCliSessionId,
      source,
      ...(threadId ? { threadId } : {}),
      ...(attachments?.length ? { attachments } : {})
    };
    // Post order is the wall order, and created_at is millisecond-resolution: two replies settling
    // in the same tick would tie and fall back to placeholder (fan-out) order. Keep the completion
    // stamp strictly monotonic per session so a later post always sorts after an earlier one.
    const floor = store.maxMessageCreatedAt(sessionId);
    const now = new Date().toISOString();
    const completedAt = floor && floor >= now ? new Date(Date.parse(floor) + 1).toISOString() : now;
    const completed = store.setGenStatus(sessionId, messageId, 'complete', completedAt, {
      data,
      ...(error ? { type: 'error' as const } : {}),
      includeInContext: true,
      text,
      // Re-stamp created_at to the post time so the wall orders by when this agent replied, not when
      // its "thinking" placeholder was reserved at fan-out (see setGenStatus). The live projection
      // already anchors these to the completion event; this keeps the reloaded order identical.
      createdAt: completedAt
    });
    if (!completed && !store.getMessage(sessionId, messageId)) {
      store.insertMessage(messageId, sessionId, text, completedAt, 'assistant', {
        ...(error ? { type: 'error' as const } : {}),
        data
      });
    }
    const round: Event[] = [];
    makeEmit(round)({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.message',
      actorAgentId: null,
      payload: { messageId, agentName, text, source, ...(attachments?.length ? { attachments } : {}) },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
    return { messageId };
  }

  function retireManagedNativeCliThinking(
    sessionId: TranscriptTargetId,
    nativeCliSessionId: string,
    agentName: string
  ): MessageId | null {
    const pendingMessageId =
      pendingManagedNativeCliWakeMessages.get(nativeCliSessionId) ??
      store.findManagedNativeCliStreamingMessage(sessionId, nativeCliSessionId, agentName);
    pendingManagedNativeCliWakeMessages.delete(nativeCliSessionId);
    if (!pendingMessageId) return null;
    const retired = store.retireManagedNativeCliStreamingMessage(
      sessionId,
      pendingMessageId,
      nativeCliSessionId,
      agentName
    );
    if (!retired) return null;
    const round: Event[] = [];
    makeEmit(round)({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.message',
      actorAgentId: null,
      payload: {
        messageId: pendingMessageId,
        agentName,
        text: '{"visibility":"silent","display":{"kind":"markdown","content":""},"attachments":[],"next":[]}',
        source: 'managed-native-cli'
      },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
    return pendingMessageId as MessageId;
  }

  function beginProjectQaWallMessage({
    sessionId,
    agentName,
    text
  }: {
    sessionId: TranscriptTargetId;
    agentName: string;
    text: string;
  }): { messageId: MessageId } {
    const messageId = newId('msg');
    store.insertMessage(messageId, sessionId, text, new Date().toISOString(), 'assistant', {
      data: { agentName, kind: 'project-qa' },
      includeInContext: false,
      streamStatus: 'streaming'
    });
    const round: Event[] = [];
    makeEmit(round)({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.message',
      actorAgentId: null,
      payload: { messageId, agentName, text },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
    return { messageId };
  }

  function completeProjectQaWallMessage({
    sessionId,
    messageId,
    agentName,
    text
  }: {
    sessionId: TranscriptTargetId;
    messageId: MessageId;
    agentName: string;
    text: string;
  }): void {
    store.setGenStatus(sessionId, messageId, 'complete', new Date().toISOString(), { text });
    const round: Event[] = [];
    makeEmit(round)({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.message',
      actorAgentId: null,
      payload: { messageId, agentName, text },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
  }

  return {
    emitManagedNativeCliThinking,
    completeManagedNativeCliThinking,
    retireManagedNativeCliThinking,
    beginProjectQaWallMessage,
    completeProjectQaWallMessage
  };
}
