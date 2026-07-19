import type { Event, MessageAttachmentRef, MessageId, NativeAgentDeliveryId, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { externalAgentSessionIdSchema, newId } from '@monad/protocol';

import { externalAgentProjectMemberDisplayNameForAgent } from '#/handlers/session/handlers/messaging-members.ts';
import { makeEvent } from '#/services/event-bus.ts';

export function createManagedExternalAgentMessages(ctx: SessionContext) {
  const {
    deps: { store },
    makeEmit,
    persistAndRetire,
    messageIngress
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

  async function emitManagedExternalAgentThinking(
    sessionId: SessionId,
    externalAgentSessionId: string,
    agentName: string,
    deliveryId?: NativeAgentDeliveryId,
    agentDisplayName = externalAgentProjectMemberDisplayNameForAgent(store, sessionId, agentName)
  ): Promise<MessageId> {
    const pending = pendingManagedExternalAgentWakeMessages.get(externalAgentSessionId);
    const existing =
      pending?.messageId ??
      store.findManagedExternalAgentStreamingMessage(sessionId, externalAgentSessionId, agentName);
    if (existing) return existing as MessageId;
    const message = await messageIngress.begin({
      transcriptTargetId: sessionId,
      idempotencyKey: newId('idem'),
      producer: {
        kind: 'external-agent',
        externalAgentSessionId: externalAgentSessionIdSchema.parse(externalAgentSessionId),
        agentName,
        ...(deliveryId ? { deliveryId } : {})
      },
      role: 'assistant',
      type: 'text',
      text: '',
      data: {
        agentName,
        agentDisplayName,
        externalAgentSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        reasoning: 'Thinking',
        source: 'managed-external-agent'
      },
      includeInContext: false
    });
    const messageId = message.id;
    if (pendingManagedExternalAgentWakeMessages.size >= 256) {
      const oldest = pendingManagedExternalAgentWakeMessages.keys().next().value;
      if (oldest !== undefined) pendingManagedExternalAgentWakeMessages.delete(oldest);
    }
    pendingManagedExternalAgentWakeMessages.set(externalAgentSessionId, {
      messageId,
      ...(deliveryId ? { deliveryId } : {})
    });
    return messageId;
  }

  async function completeManagedExternalAgentThinking({
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
  }): Promise<{ messageId: MessageId }> {
    const pending = pendingManagedExternalAgentWakeMessages.get(externalAgentSessionId);
    const pendingMessageId =
      pending?.messageId ??
      store.findManagedExternalAgentStreamingMessage(sessionId, externalAgentSessionId, agentName);
    pendingManagedExternalAgentWakeMessages.delete(externalAgentSessionId);
    const messageId = pendingMessageId as MessageId | undefined;
    const deliveryId = pending?.deliveryId ?? (messageId ? deliveryIdFromMessageData(sessionId, messageId) : undefined);
    const persistedDisplayName = messageId ? store.getMessage(sessionId, messageId)?.data : undefined;
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
    const completed = messageId
      ? await messageIngress.settle({
          transcriptTargetId: sessionId,
          messageId,
          idempotencyKey: newId('idem'),
          producer: {
            kind: 'external-agent',
            externalAgentSessionId: externalAgentSessionIdSchema.parse(externalAgentSessionId),
            agentName,
            ...(deliveryId ? { deliveryId } : {})
          },
          text,
          type: error ? 'error' : 'text',
          data,
          includeInContext: true
        })
      : await messageIngress.deliver({
          transcriptTargetId: sessionId,
          idempotencyKey: newId('idem'),
          producer: {
            kind: 'external-agent',
            externalAgentSessionId: externalAgentSessionIdSchema.parse(externalAgentSessionId),
            agentName,
            ...(deliveryId ? { deliveryId } : {})
          },
          role: 'assistant',
          type: error ? 'error' : 'text',
          text,
          data,
          includeInContext: true
        });
    const round: Event[] = [];
    const emit = makeEmit(round);
    emit(
      makeEvent(sessionId as SessionId, 'external_agent.turn_settled', {
        externalAgentSessionId,
        ...(error ? { error: true } : {})
      })
    );
    persistAndRetire(sessionId, round);
    return { messageId: completed.id };
  }

  async function retireManagedExternalAgentThinking(
    sessionId: SessionId,
    externalAgentSessionId: string,
    agentName: string
  ): Promise<MessageId | null> {
    const pending = pendingManagedExternalAgentWakeMessages.get(externalAgentSessionId);
    const pendingMessageId =
      pending?.messageId ??
      store.findManagedExternalAgentStreamingMessage(sessionId, externalAgentSessionId, agentName);
    pendingManagedExternalAgentWakeMessages.delete(externalAgentSessionId);
    const round: Event[] = [];
    const emit = makeEmit(round);
    if (pendingMessageId) {
      await messageIngress.remove({
        transcriptTargetId: sessionId,
        messageId: pendingMessageId as MessageId,
        idempotencyKey: newId('idem'),
        producer: {
          kind: 'external-agent',
          externalAgentSessionId: externalAgentSessionIdSchema.parse(externalAgentSessionId),
          agentName
        }
      });
    }
    emit(makeEvent(sessionId as SessionId, 'external_agent.turn_settled', { externalAgentSessionId }));
    persistAndRetire(sessionId, round);
    return (pendingMessageId as MessageId | undefined) ?? null;
  }

  return {
    emitManagedExternalAgentThinking,
    completeManagedExternalAgentThinking,
    retireManagedExternalAgentThinking
  };
}
