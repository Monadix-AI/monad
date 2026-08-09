import type { ChatMessage, Event, SessionUiEvent } from '@monad/protocol';
import type { ProjectionMutations } from './ui-projection-state.ts';

import { isReplyableMessage, parseEventPayload } from '@monad/protocol';

import {
  agentDisplayNameFromData,
  agentNameFromData,
  CHANNEL_REPARSE_MIN_DELTA,
  channelPartialDisplayText,
  deliveryIdFromData,
  isSilentChannelMessage,
  meshSessionIdFromData,
  partsFromMessage,
  projectQaAnswerItem,
  projectQaQuestionMessageId,
  questionPresentationFromMessage,
  sourceFromData,
  statusFromMessage
} from './ui-projection-helpers.ts';

function applyCanonicalMessage(
  m: ProjectionMutations,
  event: Event,
  message: ChatMessage,
  failed = false
): SessionUiEvent[] {
  if (m.toolIntermediateMessageIds.has(message.id)) {
    const parts = partsFromMessage(message, m.opts);
    const hasVisibleContent = parts.some(
      (part) => part.type !== 'reasoning' && (part.type !== 'text' || part.text.trim() !== '')
    );
    if (!hasVisibleContent) {
      m.toolIntermediateMessageIds.delete(message.id);
      return [];
    }
    m.toolIntermediateMessageIds.delete(message.id);
  }
  const questionMessageId = projectQaQuestionMessageId(message);
  const projectQaAnswer = projectQaAnswerItem(
    message,
    questionMessageId ? m.findMessage(questionMessageId) : undefined
  );
  if (projectQaAnswer) return [m.setMessage(projectQaAnswer)];
  const existing = m.findMessage(message.id);
  const agentName = agentNameFromData(message.data);
  const agentDisplayName = agentDisplayNameFromData(message.data);
  const source = sourceFromData(message.data);
  const meshSessionId = meshSessionIdFromData(message.data);
  const deliveryId = deliveryIdFromData(message.data);
  const question = questionPresentationFromMessage(message);
  const status = failed ? 'error' : statusFromMessage(message);
  const isNewlyPublished =
    source !== undefined &&
    (status === 'done' || status === 'error') &&
    existing?.status !== 'done' &&
    existing?.status !== 'error';
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
          ...(meshSessionId ? { meshSessionId } : {}),
          ...(deliveryId ? { deliveryId } : {})
        },
        existing
      ),
      ...(message.metadata?.origin
        ? { origin: message.metadata.origin }
        : existing?.origin
          ? { origin: existing.origin }
          : {}),
      parts: partsFromMessage(message, m.opts),
      ...(message.replyToMessageId
        ? { replyToMessageId: message.replyToMessageId }
        : existing?.replyToMessageId
          ? { replyToMessageId: existing.replyToMessageId }
          : {}),
      replyable: isReplyableMessage(message),
      ...(question ? { question } : existing?.question ? { question: existing.question } : {}),
      status,
      seq: isNewlyPublished ? m.nextMessageSeq(event.at, message.id) : (existing?.seq ?? message.createdAt ?? event.at)
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
      // The terminal event (created/updated/completed/failed, via applyCanonicalMessage) is always
      // authoritative: any delta arriving AFTER settlement is necessarily a stale tail of the round
      // that just completed (e.g. a control-plane completed event outracing a lagging
      // generation-plane delta across a reconnect), never a real live continuation — re-applying it,
      // even at index 0, would reopen a done/error message and corrupt its already-final text. A
      // message id being legitimately reused for a brand-new streaming round (edit/retry/regenerate)
      // must be signaled explicitly by a fresh canonical created/updated event (which resets status to
      // pending/streaming through applyCanonicalMessage), never inferred from a delta's own index —
      // see "clears accumulated streaming text after the message settles".
      const settledStatus = m.findMessage(p.messageId)?.status;
      if (settledStatus === 'done' || settledStatus === 'error') return [];
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
            ...(existing?.origin ? { origin: existing.origin } : {}),
            ...m.messageObservationPointers({}, existing),
            parts,
            ...(existing?.replyToMessageId ? { replyToMessageId: existing.replyToMessageId } : {}),
            replyable: existing?.replyable ?? false,
            ...(existing?.question ? { question: existing.question } : {}),
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
          ...(existing?.origin ? { origin: existing.origin } : {}),
          ...m.messageObservationPointers({}, existing),
          parts,
          ...(existing?.replyToMessageId ? { replyToMessageId: existing.replyToMessageId } : {}),
          replyable: existing?.replyable ?? false,
          ...(existing?.question ? { question: existing.question } : {}),
          status: 'streaming',
          seq: existing?.seq ?? event.at
        })
      ];
    }
    default:
      return undefined;
  }
}
