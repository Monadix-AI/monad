// Server-side producer for a generative, non-assistant message (e.g. a card). Any caller with the
// store + an event sink (a tool, an atom pack bridge, a command) can create a message that streams to
// clients over the general `message.delta` / `message.complete` channel and settles into a persisted
// row — the producer half of the message-type streaming contract. `complete()` validates the final
// `data` against the type's registry schema, so a malformed rich payload is rejected at this boundary
// rather than reaching clients or the prompt.

import type { Event, MessageId, MessageType, SessionId } from '@monad/protocol';
import type { Store } from '@/store/db/index.ts';

import { newId, validateMessageData } from '@monad/protocol';

export interface GenerativeMessageHandle {
  readonly messageId: MessageId;
  readonly channel: string;
  /** Stream one text delta; the first delta flips the row pending → streaming. */
  delta(text: string): void;
  /** Settle successfully. Throws if `data` fails the type's schema (nothing is persisted/emitted). */
  complete(result: { text: string; data?: unknown }): void;
  /** Settle as an error with a human-facing message. */
  fail(message: string): void;
}

export interface StartGenerativeMessageOptions {
  store: Store;
  /** MUST be the persisted session event sink (EventBus.publish), not a per-request sink: the
   * `message.delta`/`message.complete` events have to land in the event log so a client that joins or
   * reconnects mid-generation can replay them via `afterEventId` through the message's StreamRef. */
  emit: (event: Event) => void;
  sessionId: SessionId;
  type: MessageType;
}

export function startGenerativeMessage(opts: StartGenerativeMessageOptions): GenerativeMessageHandle {
  const { store, emit, sessionId, type } = opts;
  const messageId = newId('msg');
  const channel = `message:${messageId}`;
  let index = 0;
  let started = false;
  let settled = false;

  const event = (etype: Event['type'], payload: Record<string, unknown>): Event => ({
    id: newId('evt'),
    transcriptTargetId: sessionId,
    type: etype,
    actorAgentId: null,
    payload,
    at: new Date().toISOString()
  });

  // Inserted `pending` so a mid-flight refetch exposes a subscription source. insertMessage snapshots
  // the type's context policy (for atom types) so it stays correct even if the atom pack is unloaded.
  store.insertMessage(messageId, sessionId, '', new Date().toISOString(), 'assistant', {
    type,
    streamStatus: 'pending'
  });

  return {
    messageId,
    channel,
    delta(text: string) {
      if (settled) return;
      if (!started) {
        started = true;
        store.setGenStatus(sessionId, messageId, 'streaming', new Date().toISOString());
      }
      emit(event('message.delta', { messageId, channel, type, delta: text, index: index++ }));
    },
    complete(result: { text: string; data?: unknown }) {
      if (settled) return;
      const check = validateMessageData(type, result.data);
      if (!check.ok) throw new Error(`generative message data invalid for type ${type}: ${check.error}`);
      settled = true;
      store.setGenStatus(sessionId, messageId, 'complete', new Date().toISOString(), {
        text: result.text,
        data: result.data
      });
      emit(event('message.complete', { messageId, channel, type, ok: true, text: result.text, data: result.data }));
    },
    fail(message: string) {
      if (settled) return;
      settled = true;
      store.setGenStatus(sessionId, messageId, 'error', new Date().toISOString(), { text: message });
      emit(event('message.complete', { messageId, channel, type, ok: false, text: message }));
    }
  };
}
