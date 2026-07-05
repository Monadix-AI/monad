import type { Event, SessionUiEvent, UIPart } from '@monad/protocol';
import type { ProjectionMutations } from './ui-projection-state.ts';

import { channelDisplayText, channelStructuredVisibility, parseEventPayload } from '@monad/protocol';

import { CHANNEL_REPARSE_MIN_DELTA, channelPartialDisplayText } from './ui-projection-helpers.ts';

export function applyMessageEvent(m: ProjectionMutations, event: Event): SessionUiEvent[] | undefined {
  switch (event.type) {
    case 'user.message': {
      const p = parseEventPayload('user.message', event.payload);
      return [
        m.setMessage({
          kind: 'message',
          id: p.messageId,
          role: 'user',
          parts: [{ type: 'text', text: p.text }],
          status: 'done',
          seq: event.at
        })
      ];
    }
    case 'agent.token': {
      const p = parseEventPayload('agent.token', event.payload);
      const existing = m.findMessage(p.messageId);
      const text = existing?.parts.find((part) => part.type === 'text');
      const parts = existing ? existing.parts.slice() : [];
      // Accumulate the full streamed text for every session, not just channel-structured ones: each
      // `agent.token` carries only its own delta, so the running text is reassembled here. The
      // existing text part holds *display* text (for a channel session, a filtered projection of the
      // raw JSON) and can't be appended to directly. Cleared on agent.message / agent.error.
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
          ...(p.agentName ? { agentName: p.agentName } : existing?.agentName ? { agentName: existing.agentName } : {}),
          ...(p.source ? { source: p.source } : existing?.source ? { source: existing.source } : {}),
          ...m.messageObservationPointers(p, existing),
          parts,
          status: 'streaming',
          seq: existing?.seq ?? event.at
        })
      ];
    }
    case 'agent.reasoning': {
      const p = parseEventPayload('agent.reasoning', event.payload);
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
          ...(p.source ? { source: p.source } : existing?.source ? { source: existing.source } : {}),
          ...m.messageObservationPointers(p, existing),
          parts,
          status: 'streaming',
          seq: existing?.seq ?? event.at
        })
      ];
    }
    case 'agent.message': {
      const p = parseEventPayload('agent.message', event.payload);
      const existing = m.findMessage(p.messageId);
      m.rawStreamingText.delete(p.messageId);
      m.channelDisplayCache.delete(p.messageId);
      if (m.opts.channelStructured && channelStructuredVisibility(p.text) === 'silent') {
        return existing ? [m.remove('message', p.messageId)] : [];
      }
      const parts: UIPart[] = existing?.parts.filter((part) => part.type !== 'text') ?? [];
      const text = m.opts.channelStructured ? channelDisplayText(p.text) : p.text;
      parts.push(
        p.data !== undefined
          ? { type: 'artifact', messageType: 'directive', text, data: p.data }
          : { type: 'text', text }
      );
      if (p.attachments?.length && !parts.some((part) => part.type === 'custom' && part.name === 'attachment')) {
        for (const attachment of p.attachments) parts.push({ type: 'custom', name: 'attachment', data: attachment });
      }
      return [
        m.setMessage({
          kind: 'message',
          id: p.messageId,
          role: 'assistant',
          ...(p.agentName ? { agentName: p.agentName } : existing?.agentName ? { agentName: existing.agentName } : {}),
          ...(p.source ? { source: p.source } : existing?.source ? { source: existing.source } : {}),
          ...m.messageObservationPointers(p, existing),
          parts,
          status: 'done',
          seq: p.source === 'managed-native-cli' ? event.at : (existing?.seq ?? event.at)
        })
      ];
    }
    case 'agent.error': {
      const p = parseEventPayload('agent.error', event.payload);
      const id = p.messageId ?? `err-${event.id}`;
      if (p.messageId) {
        m.rawStreamingText.delete(p.messageId);
        m.channelDisplayCache.delete(p.messageId);
      }
      return [
        m.setMessage({
          kind: 'message',
          id,
          role: 'assistant',
          parts: [{ type: 'text', text: p.code ? `[${p.code}] ${p.message}` : p.message }],
          status: 'error',
          seq: (p.messageId ? m.findMessage(p.messageId)?.seq : undefined) ?? event.at
        })
      ];
    }
    case 'message.delta': {
      const p = parseEventPayload('message.delta', event.payload);
      const existing = m.findMessage(p.messageId);
      const artifact = existing?.parts.find((part) => part.type === 'artifact' && part.messageType === p.type);
      const parts = existing ? existing.parts.slice() : [];
      if (artifact?.type === 'artifact') artifact.text = `${artifact.text ?? ''}${p.delta}`;
      else parts.push({ type: 'artifact', messageType: p.type, text: p.delta });
      return [
        m.setMessage({
          kind: 'message',
          id: p.messageId,
          role: 'assistant',
          parts,
          status: 'streaming',
          seq: existing?.seq ?? event.at
        })
      ];
    }
    case 'message.complete': {
      const p = parseEventPayload('message.complete', event.payload);
      return [
        m.setMessage({
          kind: 'message',
          id: p.messageId,
          role: 'assistant',
          parts: [
            {
              type: 'artifact',
              messageType: p.type,
              ...(p.text ? { text: p.text } : {}),
              ...(p.data !== undefined ? { data: p.data } : {})
            }
          ],
          status: p.ok ? 'done' : 'error',
          seq: m.findMessage(p.messageId)?.seq ?? event.at
        })
      ];
    }
    default:
      return undefined;
  }
}
