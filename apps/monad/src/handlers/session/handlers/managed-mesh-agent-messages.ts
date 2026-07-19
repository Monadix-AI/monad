import type { Event, MessageAttachmentRef, MessageId, NativeAgentDeliveryId, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { meshSessionIdSchema, newId } from '@monad/protocol';

import { meshAgentProjectMemberDisplayNameForAgent } from '#/handlers/session/handlers/messaging-members.ts';
import { makeEvent } from '#/services/event-bus.ts';

export function createManagedMeshAgentMessages(ctx: SessionContext) {
  const {
    deps: { store },
    makeEmit,
    persistAndRetire,
    messageIngress
  } = ctx;

  const pendingManagedMeshAgentWakeMessages = new Map<
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

  async function emitManagedMeshAgentThinking(
    sessionId: SessionId,
    meshSessionId: string,
    agentName: string,
    deliveryId?: NativeAgentDeliveryId,
    agentDisplayName = meshAgentProjectMemberDisplayNameForAgent(store, sessionId, agentName)
  ): Promise<MessageId> {
    const pending = pendingManagedMeshAgentWakeMessages.get(meshSessionId);
    const existing =
      pending?.messageId ?? store.findManagedMeshAgentStreamingMessage(sessionId, meshSessionId, agentName);
    if (existing) return existing as MessageId;
    const message = await messageIngress.begin({
      transcriptTargetId: sessionId,
      idempotencyKey: newId('idem'),
      producer: {
        kind: 'mesh-agent',
        meshSessionId: meshSessionIdSchema.parse(meshSessionId),
        agentName,
        ...(deliveryId ? { deliveryId } : {})
      },
      role: 'assistant',
      type: 'text',
      text: '',
      data: {
        agentName,
        agentDisplayName,
        meshSessionId,
        ...(deliveryId ? { deliveryId } : {}),
        reasoning: 'Thinking',
        source: 'managed-mesh-agent'
      },
      includeInContext: false
    });
    const messageId = message.id;
    if (pendingManagedMeshAgentWakeMessages.size >= 256) {
      const oldest = pendingManagedMeshAgentWakeMessages.keys().next().value;
      if (oldest !== undefined) pendingManagedMeshAgentWakeMessages.delete(oldest);
    }
    pendingManagedMeshAgentWakeMessages.set(meshSessionId, {
      messageId,
      ...(deliveryId ? { deliveryId } : {})
    });
    return messageId;
  }

  async function completeManagedMeshAgentThinking({
    sessionId,
    meshSessionId,
    agentName,
    agentDisplayName,
    text,
    threadId,
    attachments,
    source = 'managed-mesh-agent',
    error = false
  }: {
    sessionId: SessionId;
    meshSessionId: string;
    agentName: string;
    agentDisplayName?: string;
    text: string;
    threadId?: string;
    attachments?: MessageAttachmentRef[];
    source?: 'managed-mesh-agent' | 'mesh-agent-provider';
    error?: boolean;
  }): Promise<{ messageId: MessageId }> {
    const pending = pendingManagedMeshAgentWakeMessages.get(meshSessionId);
    const pendingMessageId =
      pending?.messageId ?? store.findManagedMeshAgentStreamingMessage(sessionId, meshSessionId, agentName);
    pendingManagedMeshAgentWakeMessages.delete(meshSessionId);
    const messageId = pendingMessageId as MessageId | undefined;
    const deliveryId = pending?.deliveryId ?? (messageId ? deliveryIdFromMessageData(sessionId, messageId) : undefined);
    const persistedDisplayName = messageId ? store.getMessage(sessionId, messageId)?.data : undefined;
    const resolvedAgentDisplayName =
      agentDisplayName ??
      (persistedDisplayName && typeof persistedDisplayName === 'object'
        ? (persistedDisplayName as { agentDisplayName?: unknown }).agentDisplayName
        : undefined) ??
      meshAgentProjectMemberDisplayNameForAgent(store, sessionId, agentName);
    const data = {
      agentName,
      ...(typeof resolvedAgentDisplayName === 'string' && resolvedAgentDisplayName
        ? { agentDisplayName: resolvedAgentDisplayName }
        : {}),
      meshSessionId,
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
            kind: 'mesh-agent',
            meshSessionId: meshSessionIdSchema.parse(meshSessionId),
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
            kind: 'mesh-agent',
            meshSessionId: meshSessionIdSchema.parse(meshSessionId),
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
      makeEvent(sessionId as SessionId, 'mesh.turn_settled', {
        meshSessionId,
        ...(error ? { error: true } : {})
      })
    );
    persistAndRetire(sessionId, round);
    return { messageId: completed.id };
  }

  async function retireManagedMeshAgentThinking(
    sessionId: SessionId,
    meshSessionId: string,
    agentName: string
  ): Promise<MessageId | null> {
    const pending = pendingManagedMeshAgentWakeMessages.get(meshSessionId);
    const pendingMessageId =
      pending?.messageId ?? store.findManagedMeshAgentStreamingMessage(sessionId, meshSessionId, agentName);
    pendingManagedMeshAgentWakeMessages.delete(meshSessionId);
    const round: Event[] = [];
    const emit = makeEmit(round);
    if (pendingMessageId) {
      await messageIngress.remove({
        transcriptTargetId: sessionId,
        messageId: pendingMessageId as MessageId,
        idempotencyKey: newId('idem'),
        producer: {
          kind: 'mesh-agent',
          meshSessionId: meshSessionIdSchema.parse(meshSessionId),
          agentName
        }
      });
    }
    emit(makeEvent(sessionId as SessionId, 'mesh.turn_settled', { meshSessionId }));
    persistAndRetire(sessionId, round);
    return (pendingMessageId as MessageId | undefined) ?? null;
  }

  return {
    emitManagedMeshAgentThinking,
    completeManagedMeshAgentThinking,
    retireManagedMeshAgentThinking
  };
}
