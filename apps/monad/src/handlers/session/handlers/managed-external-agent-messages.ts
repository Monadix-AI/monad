import type { Event, MessageAttachmentRef, MessageId, NativeAgentDeliveryId, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { newId } from '@monad/protocol';

export function createManagedExternalAgentMessages(ctx: SessionContext) {
  const {
    deps: { store },
    makeEmit,
    persistAndRetire
  } = ctx;

  const pendingManagedExternalAgentWakeMessages = new Map<
    string,
    { messageId: MessageId; deliveryId?: NativeAgentDeliveryId }
  >();

  function deliveryIdFromMessageData(sessionId: SessionId, messageId: MessageId): NativeAgentDeliveryId | undefined {
    const data = store.getMessage(sessionId, messageId)?.data;
    if (!data || typeof data !== 'object') return undefined;
    const deliveryId = (data as { deliveryId?: unknown }).deliveryId;
    return typeof deliveryId === 'string' && deliveryId.startsWith('deliv_')
      ? (deliveryId as NativeAgentDeliveryId)
      : undefined;
  }

  function emitManagedExternalAgentThinking(
    sessionId: SessionId,
    externalAgentSessionId: string,
    agentName: string,
    deliveryId?: NativeAgentDeliveryId
  ): MessageId {
    const pending = pendingManagedExternalAgentWakeMessages.get(externalAgentSessionId);
    const existing =
      pending?.messageId ??
      store.findManagedExternalAgentStreamingMessage(sessionId, externalAgentSessionId, agentName);
    if (existing) return existing as MessageId;
    const messageId = newId('msg');
    if (pendingManagedExternalAgentWakeMessages.size >= 256) {
      const oldest = pendingManagedExternalAgentWakeMessages.keys().next().value;
      if (oldest !== undefined) pendingManagedExternalAgentWakeMessages.delete(oldest);
    }
    pendingManagedExternalAgentWakeMessages.set(externalAgentSessionId, {
      messageId,
      ...(deliveryId ? { deliveryId } : {})
    });
    store.insertMessage(messageId, sessionId, '', new Date().toISOString(), 'assistant', {
      data: {
        agentName,
        externalAgentSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        reasoning: 'Thinking',
        source: 'managed-external-agent'
      },
      includeInContext: false,
      streamStatus: 'streaming'
    });
    const round: Event[] = [];
    const emit = makeEmit(round);
    emit({
      id: newId('evt'),
      sessionId: sessionId as SessionId,
      type: 'agent.token',
      actorAgentId: null,
      payload: {
        messageId,
        agentName,
        externalAgentSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        delta: '',
        index: 0,
        source: 'managed-external-agent'
      },
      at: new Date().toISOString()
    });
    emit({
      id: newId('evt'),
      sessionId: sessionId as SessionId,
      type: 'agent.reasoning',
      actorAgentId: null,
      payload: {
        messageId,
        externalAgentSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        delta: 'Thinking',
        index: 0,
        source: 'managed-external-agent'
      },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
    return messageId;
  }

  function completeManagedExternalAgentThinking({
    sessionId,
    externalAgentSessionId,
    agentName,
    text,
    threadId,
    attachments,
    source = 'managed-external-agent',
    error = false
  }: {
    sessionId: SessionId;
    externalAgentSessionId: string;
    agentName: string;
    text: string;
    threadId?: string;
    attachments?: MessageAttachmentRef[];
    source?: 'managed-external-agent' | 'external-agent-provider';
    error?: boolean;
  }): { messageId: MessageId } {
    const pending = pendingManagedExternalAgentWakeMessages.get(externalAgentSessionId);
    const pendingMessageId =
      pending?.messageId ??
      store.findManagedExternalAgentStreamingMessage(sessionId, externalAgentSessionId, agentName);
    pendingManagedExternalAgentWakeMessages.delete(externalAgentSessionId);
    const messageId = (pendingMessageId ?? newId('msg')) as MessageId;
    const deliveryId = pending?.deliveryId ?? deliveryIdFromMessageData(sessionId, messageId);
    const data = {
      agentName,
      externalAgentSessionId,
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
      sessionId: sessionId as SessionId,
      type: 'agent.message',
      actorAgentId: null,
      payload: {
        messageId,
        agentName,
        externalAgentSessionId,
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

  function retireManagedExternalAgentThinking(
    sessionId: SessionId,
    externalAgentSessionId: string,
    agentName: string
  ): MessageId | null {
    const pending = pendingManagedExternalAgentWakeMessages.get(externalAgentSessionId);
    const pendingMessageId =
      pending?.messageId ??
      store.findManagedExternalAgentStreamingMessage(sessionId, externalAgentSessionId, agentName);
    pendingManagedExternalAgentWakeMessages.delete(externalAgentSessionId);
    if (!pendingMessageId) return null;
    const retired = store.retireManagedExternalAgentStreamingMessage(
      sessionId,
      pendingMessageId,
      externalAgentSessionId,
      agentName
    );
    if (!retired) return null;
    const round: Event[] = [];
    makeEmit(round)({
      id: newId('evt'),
      sessionId: sessionId as SessionId,
      type: 'agent.message',
      actorAgentId: null,
      payload: {
        messageId: pendingMessageId,
        agentName,
        text: '{"visibility":"silent","display":{"kind":"markdown","content":""},"attachments":[],"next":[]}',
        source: 'managed-external-agent'
      },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
    return pendingMessageId as MessageId;
  }

  return {
    emitManagedExternalAgentThinking,
    completeManagedExternalAgentThinking,
    retireManagedExternalAgentThinking
  };
}
