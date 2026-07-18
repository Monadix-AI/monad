import type { Event, MessageAttachmentRef, MessageId, NativeAgentDeliveryId, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { newId } from '@monad/protocol';

import { externalAgentProjectMemberDisplayNameForAgent } from '#/handlers/session/handlers/messaging-members.ts';
import { makeEvent } from '#/services/event-bus.ts';

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
    deliveryId?: NativeAgentDeliveryId,
    agentDisplayName = externalAgentProjectMemberDisplayNameForAgent(store, sessionId, agentName)
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
        agentDisplayName,
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
    emit(
      makeEvent(sessionId as SessionId, 'agent.token', {
        messageId,
        agentName,
        agentDisplayName,
        externalAgentSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        delta: '',
        index: 0,
        source: 'managed-external-agent'
      })
    );
    emit(
      makeEvent(sessionId as SessionId, 'agent.reasoning', {
        messageId,
        externalAgentSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        delta: 'Thinking',
        index: 0,
        source: 'managed-external-agent'
      })
    );
    persistAndRetire(sessionId, round);
    return messageId;
  }

  function completeManagedExternalAgentThinking({
    sessionId,
    externalAgentSessionId,
    agentName,
    agentDisplayName,
    text,
    threadId,
    attachments,
    source = 'managed-external-agent',
    error = false
  }: {
    sessionId: SessionId;
    externalAgentSessionId: string;
    agentName: string;
    agentDisplayName?: string;
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
    const persistedDisplayName = store.getMessage(sessionId, messageId)?.data;
    const resolvedAgentDisplayName =
      agentDisplayName ??
      (persistedDisplayName && typeof persistedDisplayName === 'object'
        ? (persistedDisplayName as { agentDisplayName?: unknown }).agentDisplayName
        : undefined) ??
      externalAgentProjectMemberDisplayNameForAgent(store, sessionId, agentName);
    const data = {
      agentName,
      ...(typeof resolvedAgentDisplayName === 'string' && resolvedAgentDisplayName
        ? { agentDisplayName: resolvedAgentDisplayName }
        : {}),
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
    const emit = makeEmit(round);
    emit(
      makeEvent(sessionId as SessionId, 'agent.message', {
        messageId,
        agentName,
        ...(typeof resolvedAgentDisplayName === 'string' && resolvedAgentDisplayName
          ? { agentDisplayName: resolvedAgentDisplayName }
          : {}),
        externalAgentSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        text,
        source,
        ...(attachments?.length ? { attachments } : {})
      })
    );
    emit(
      makeEvent(sessionId as SessionId, 'external_agent.turn_settled', {
        externalAgentSessionId,
        ...(error ? { error: true } : {})
      })
    );
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
    const retired = pendingMessageId
      ? store.retireManagedExternalAgentStreamingMessage(sessionId, pendingMessageId, externalAgentSessionId, agentName)
      : false;
    const round: Event[] = [];
    const emit = makeEmit(round);
    if (retired && pendingMessageId) {
      emit(
        makeEvent(sessionId as SessionId, 'agent.message', {
          messageId: pendingMessageId,
          agentName,
          text: '{"visibility":"silent","display":{"kind":"markdown","content":""},"attachments":[],"next":[]}',
          source: 'managed-external-agent'
        })
      );
    }
    emit(makeEvent(sessionId as SessionId, 'external_agent.turn_settled', { externalAgentSessionId }));
    persistAndRetire(sessionId, round);
    return retired ? (pendingMessageId as MessageId) : null;
  }

  return {
    emitManagedExternalAgentThinking,
    completeManagedExternalAgentThinking,
    retireManagedExternalAgentThinking
  };
}
