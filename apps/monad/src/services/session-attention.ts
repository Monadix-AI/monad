import type { ChatMessage, Event, Session, SessionAttentionState, SessionId } from '@monad/protocol';
import type { EventBus } from '#/services/event-bus.ts';
import type { Store } from '#/store/db/index.ts';

import { parseEventPayload } from '@monad/protocol';

import { makeEvent } from '#/services/event-bus.ts';

interface SessionAttentionServiceDeps {
  store: Store;
  bus: EventBus;
}

export class SessionAttentionService {
  constructor(private readonly deps: SessionAttentionServiceDeps) {}

  start(): () => void {
    this.deps.store.reconcileSessionActionAttention(new Date().toISOString());
    return this.deps.bus.subscribeAll((event) => this.handleEvent(event));
  }

  handleEvent(event: Event): void {
    if (!event.sessionId.startsWith('ses_')) return;
    const session = this.deps.store.getSession(event.sessionId);
    if (!session) return;
    switch (event.type) {
      case 'session.message.created':
      case 'session.message.completed': {
        const payload = parseEventPayload(event.type, event.payload);
        this.recordMessage(session, payload.message, payload.producer.kind, event.at);
        return;
      }
      case 'session.run.completed':
        this.recordRunCompleted(session, event.at);
        return;
      case 'session.run.failed':
      case 'session.run.cancelled':
        this.recordActivity(session.id, event.at);
        return;
      case 'tool.approval_requested': {
        const payload = parseEventPayload(event.type, event.payload);
        this.recordRequest(session, 'approval', payload.requestId, event.at);
        return;
      }
      case 'tool.approval_resolved': {
        const payload = parseEventPayload(event.type, event.payload);
        this.resolveRequest(session.id, 'approval', payload.requestId, event.at);
        return;
      }
      case 'mesh.approval_requested': {
        const payload = parseEventPayload(event.type, event.payload);
        this.recordRequest(session, 'approval', payload.requestId, event.at);
        return;
      }
      case 'mesh.approval_resolved': {
        const payload = parseEventPayload(event.type, event.payload);
        this.resolveRequest(session.id, 'approval', payload.requestId, event.at);
        return;
      }
      case 'clarify.requested': {
        const payload = parseEventPayload(event.type, event.payload);
        this.recordRequest(session, 'response', payload.requestId, event.at);
        return;
      }
      case 'clarify.resolved': {
        const payload = parseEventPayload(event.type, event.payload);
        this.resolveRequest(session.id, 'response', payload.requestId, event.at);
        return;
      }
      case 'mesh.login_required': {
        const payload = parseEventPayload(event.type, event.payload);
        this.recordRequest(session, 'login', payload.agentName, event.at);
        return;
      }
      case 'mesh.login_resolved': {
        const payload = parseEventPayload(event.type, event.payload);
        this.resolveRequest(session.id, 'login', payload.agentName, event.at);
        return;
      }
      default:
        return;
    }
  }

  recordMessage(session: Session, message: ChatMessage, producerKind: string, occurredAt: string): void {
    if (message.role === 'user') {
      this.recordActivity(session.id, occurredAt);
      return;
    }
    if (
      session.projectId &&
      message.role === 'assistant' &&
      (producerKind === 'agent' || producerKind === 'mesh-agent') &&
      (message.stream.status === 'settled' || message.stream.status === 'complete')
    ) {
      this.recordPending(session.id, `message:${message.id}`, 'unread', 'message', message.id, occurredAt);
    }
  }

  recordRunCompleted(session: Session, occurredAt: string): void {
    if (session.projectId) {
      this.recordActivity(session.id, occurredAt);
      return;
    }
    const finalMessage = this.deps.store
      .listMessages(session.id)
      .findLast((message) => message.role === 'assistant' && message.stream.status === 'complete');
    if (!finalMessage) {
      this.recordActivity(session.id, occurredAt);
      return;
    }
    this.recordPending(session.id, `message:${finalMessage.id}`, 'unread', 'message', finalMessage.id, occurredAt);
  }

  recordRequest(session: Session, sourceType: 'approval' | 'response' | 'login', sourceId: string, at: string): void {
    const kind: SessionAttentionState = sourceType === 'approval' ? 'need-approval' : 'need-response';
    this.recordPending(session.id, `${sourceType}:${sourceId}`, kind, sourceType, sourceId, at);
  }

  resolveRequest(
    sessionId: SessionId,
    sourceType: 'approval' | 'response' | 'login',
    sourceId: string,
    at: string
  ): void {
    this.deps.store.advanceSessionActivity(sessionId, at);
    const changed = this.deps.store.resolveSessionAttentionSource(sessionId, sourceType, sourceId);
    if (changed > 0) this.publishUpdated(sessionId);
  }

  private recordActivity(sessionId: SessionId, occurredAt: string): void {
    this.deps.store.advanceSessionActivity(sessionId, occurredAt);
    this.publishUpdated(sessionId);
  }

  private recordPending(
    sessionId: SessionId,
    itemKey: string,
    kind: SessionAttentionState,
    sourceType: string,
    sourceId: string,
    occurredAt: string
  ): void {
    this.deps.store.applySessionAttentionSource({ sessionId, itemKey, kind, sourceType, sourceId, occurredAt });
    this.publishUpdated(sessionId);
  }

  private publishUpdated(sessionId: SessionId): void {
    this.deps.bus.publish(makeEvent(sessionId, 'session.attention.updated', { transcriptTargetId: sessionId }));
  }
}
