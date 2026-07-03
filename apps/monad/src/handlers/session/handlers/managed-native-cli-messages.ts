import type {
  Event,
  MessageAttachmentRef,
  MessageId,
  NativeAgentDeliveryId,
  TranscriptTargetId
} from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';

import { newId } from '@monad/protocol';

export function createManagedNativeCliMessages(ctx: SessionContext) {
  const {
    deps: { store },
    makeEmit,
    persistAndRetire
  } = ctx;

  const pendingManagedNativeCliWakeMessages = new Map<
    string,
    { messageId: MessageId; deliveryId?: NativeAgentDeliveryId }
  >();

  function deliveryIdFromMessageData(
    sessionId: TranscriptTargetId,
    messageId: MessageId
  ): NativeAgentDeliveryId | undefined {
    const data = store.getMessage(sessionId, messageId)?.data;
    if (!data || typeof data !== 'object') return undefined;
    const deliveryId = (data as { deliveryId?: unknown }).deliveryId;
    return typeof deliveryId === 'string' && deliveryId.startsWith('deliv_')
      ? (deliveryId as NativeAgentDeliveryId)
      : undefined;
  }

  function emitManagedNativeCliThinking(
    sessionId: TranscriptTargetId,
    nativeCliSessionId: string,
    agentName: string,
    deliveryId?: NativeAgentDeliveryId
  ): MessageId {
    const pending = pendingManagedNativeCliWakeMessages.get(nativeCliSessionId);
    const existing =
      pending?.messageId ?? store.findManagedNativeCliStreamingMessage(sessionId, nativeCliSessionId, agentName);
    if (existing) return existing as MessageId;
    const messageId = newId('msg');
    if (pendingManagedNativeCliWakeMessages.size >= 256) {
      const oldest = pendingManagedNativeCliWakeMessages.keys().next().value;
      if (oldest !== undefined) pendingManagedNativeCliWakeMessages.delete(oldest);
    }
    pendingManagedNativeCliWakeMessages.set(nativeCliSessionId, {
      messageId,
      ...(deliveryId ? { deliveryId } : {})
    });
    store.insertMessage(messageId, sessionId, '', new Date().toISOString(), 'assistant', {
      data: {
        agentName,
        nativeCliSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        reasoning: 'Thinking',
        source: 'managed-native-cli'
      },
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
      payload: {
        messageId,
        agentName,
        nativeCliSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        delta: '',
        index: 0,
        source: 'managed-native-cli'
      },
      at: new Date().toISOString()
    });
    emit({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.reasoning',
      actorAgentId: null,
      payload: {
        messageId,
        nativeCliSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        delta: 'Thinking',
        index: 0,
        source: 'managed-native-cli'
      },
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
    const pending = pendingManagedNativeCliWakeMessages.get(nativeCliSessionId);
    const pendingMessageId =
      pending?.messageId ?? store.findManagedNativeCliStreamingMessage(sessionId, nativeCliSessionId, agentName);
    pendingManagedNativeCliWakeMessages.delete(nativeCliSessionId);
    const messageId = (pendingMessageId ?? newId('msg')) as MessageId;
    const deliveryId = pending?.deliveryId ?? deliveryIdFromMessageData(sessionId, messageId);
    const data = {
      agentName,
      nativeCliSessionId,
      ...(deliveryId ? { deliveryId } : {}),
      source,
      ...(threadId ? { threadId } : {}),
      ...(attachments?.length ? { attachments } : {})
    };
    const floor = store.maxMessageCreatedAt(sessionId);
    const now = new Date().toISOString();
    const completedAt = floor && floor >= now ? new Date(Date.parse(floor) + 1).toISOString() : now;
    const completed = store.setGenStatus(sessionId, messageId, 'complete', completedAt, {
      data,
      ...(error ? { type: 'error' as const } : {}),
      includeInContext: true,
      text,
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
      payload: {
        messageId,
        agentName,
        nativeCliSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        text,
        source,
        ...(attachments?.length ? { attachments } : {})
      },
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
    const pending = pendingManagedNativeCliWakeMessages.get(nativeCliSessionId);
    const pendingMessageId =
      pending?.messageId ?? store.findManagedNativeCliStreamingMessage(sessionId, nativeCliSessionId, agentName);
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

  return {
    emitManagedNativeCliThinking,
    completeManagedNativeCliThinking,
    retireManagedNativeCliThinking
  };
}
