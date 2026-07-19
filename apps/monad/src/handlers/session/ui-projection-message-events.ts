import type { ChatMessage, Event, SessionUiEvent } from '@monad/protocol';
import type { ProjectionMutations } from './ui-projection-state.ts';

import { parseEventPayload } from '@monad/protocol';

import {
  agentDisplayNameFromData,
  agentNameFromData,
  CHANNEL_REPARSE_MIN_DELTA,
  channelPartialDisplayText,
  deliveryIdFromData,
  externalAgentSessionIdFromData,
  isSilentChannelMessage,
  partsFromMessage,
  sourceFromData,
  statusFromMessage
} from './ui-projection-helpers.ts';

function applyCanonicalMessage(
  m: ProjectionMutations,
  event: Event,
  message: ChatMessage,
  failed = false
): SessionUiEvent[] {
  const existing = m.findMessage(message.id);
  const agentName = agentNameFromData(message.data);
  const agentDisplayName = agentDisplayNameFromData(message.data);
  const source = sourceFromData(message.data);
  const externalAgentSessionId = externalAgentSessionIdFromData(message.data);
  const deliveryId = deliveryIdFromData(message.data);
  m.rawStreamingText.delete(message.id);
  m.streamingDeltaIndex.delete(`${message.id}:content`);
  m.streamingDeltaIndex.delete(`${message.id}:reasoning`);
  m.channelDisplayCache.delete(message.id);
  if (isSilentChannelMessage(message, m.opts)) return existing ? [m.remove('message', message.id)] : [];
  return [
    m.setMessage({
      kind: 'message',
      id: message.id,
      role: message.role === 'user' ? 'user' : 'assistant',
      ...(agentName ? { agentName } : existing?.agentName ? { agentName: existing.agentName } : {}),
      ...(agentDisplayName
        ? { agentDisplayName }
        : existing?.agentDisplayName
          ? { agentDisplayName: existing.agentDisplayName }
          : {}),
      ...(source ? { source } : existing?.source ? { source: existing.source } : {}),
      ...m.messageObservationPointers(
        {
          ...(externalAgentSessionId ? { externalAgentSessionId } : {}),
          ...(deliveryId ? { deliveryId } : {})
        },
        existing
      ),
      parts: partsFromMessage(message, m.opts),
      status: failed ? 'error' : statusFromMessage(message),
      seq:
        event.type === 'session.message.completed' && source === 'managed-external-agent'
          ? event.at
          : (existing?.seq ?? message.createdAt ?? event.at)
    })
  ];
}

export function applyMessageEvent(m: ProjectionMutations, event: Event): SessionUiEvent[] | undefined {
  switch (event.type) {
    case 'session.message.created': {
      return applyCanonicalMessage(m, event, parseEventPayload('session.message.created', event.payload).message);
    }
    case 'session.message.updated': {
      return applyCanonicalMessage(m, event, parseEventPayload('session.message.updated', event.payload).message);
    }
    case 'session.message.completed': {
      return applyCanonicalMessage(m, event, parseEventPayload('session.message.completed', event.payload).message);
    }
    case 'session.message.failed': {
      return applyCanonicalMessage(m, event, parseEventPayload('session.message.failed', event.payload).message, true);
    }
    case 'session.message.deleted': {
      const { messageId } = parseEventPayload('session.message.deleted', event.payload);
      return [m.remove('message', messageId)];
    }
    case 'session.message.delta.appended': {
      const p = parseEventPayload('session.message.delta.appended', event.payload);
      const key = `${p.messageId}:${p.channel}`;
      if ((m.streamingDeltaIndex.get(key) ?? -1) >= p.index) return [];
      if (p.channel === 'reasoning') {
        m.streamingDeltaIndex.set(key, p.index);
        const existing = m.findMessage(p.messageId);
        const reasoning = existing?.parts.find((part) => part.type === 'reasoning');
        const parts = existing ? existing.parts.slice() : [];
        if (reasoning?.type === 'reasoning') reasoning.text += p.delta;
        else parts.unshift({ type: 'reasoning', text: p.delta });
        return [
          m.setMessage({
            kind: 'message',
            id: p.messageId,
            role: 'assistant',
            ...(existing?.agentName ? { agentName: existing.agentName } : {}),
            ...(existing?.agentDisplayName ? { agentDisplayName: existing.agentDisplayName } : {}),
            ...(existing?.source ? { source: existing.source } : {}),
            ...m.messageObservationPointers({}, existing),
            parts,
            status: 'streaming',
            seq: existing?.seq ?? event.at
          })
        ];
      }
      const contentKey = `${p.messageId}:content`;
      if ((m.streamingDeltaIndex.get(contentKey) ?? -1) >= p.index) return [];
      m.streamingDeltaIndex.set(contentKey, p.index);
      const existing = m.findMessage(p.messageId);
      const text = existing?.parts.find((part) => part.type === 'text');
      const parts = existing ? existing.parts.slice() : [];
      // Accumulate the full streamed text for every session, not just channel-structured ones: each
      // delta event carries only its own delta, so the running text is reassembled here. The
      // existing text part holds *display* text (for a channel session, a filtered projection of the
      // raw JSON) and can't be appended to directly. Cleared when the canonical message settles.
      const rawText = `${m.rawStreamingText.get(p.messageId) ?? ''}${p.delta}`;
      m.rawStreamingText.set(p.messageId, rawText);
      let visibleText: string;
      if (m.opts.channelStructured) {
        const cached = m.channelDisplayCache.get(p.messageId);
        if (cached && rawText.length - cached.len < CHANNEL_REPARSE_MIN_DELTA && !p.delta.includes('}')) {
          visibleText = cached.text;
        } else {
          visibleText = channelPartialDisplayText(rawText);
          m.channelDisplayCache.set(p.messageId, { len: rawText.length, text: visibleText });
        }
      } else {
        visibleText = rawText;
      }
      if (text?.type === 'text') text.text = visibleText;
      else parts.push({ type: 'text', text: visibleText });
      return [
        m.setMessage({
          kind: 'message',
          id: p.messageId,
          role: 'assistant',
          ...(existing?.agentName ? { agentName: existing.agentName } : {}),
          ...(existing?.agentDisplayName ? { agentDisplayName: existing.agentDisplayName } : {}),
          ...(existing?.source ? { source: existing.source } : {}),
          ...m.messageObservationPointers({}, existing),
          parts,
          status: 'streaming',
          seq: existing?.seq ?? event.at
        })
      ];
    }
    default:
      return undefined;
  }
}
