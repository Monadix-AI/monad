// Server-side producer for a generative, non-assistant message (e.g. a card). Any caller with
// Message Ingress can create a message that streams over its canonical message generation channel
// and settles into a persisted row. `complete()` validates the final `data` against the type's
// registry schema, so a malformed rich payload is rejected at this boundary rather than reaching
// clients or the prompt.

import type { MessageId, MessageType, SessionId } from '@monad/protocol';
import type { MessageIngress } from '#/services/messages/types.ts';

import { newId, validateMessageData } from '@monad/protocol';

import { messageIdempotencyKey } from '#/services/messages/ingress.ts';

export interface GenerativeMessageHandle {
  readonly messageId: MessageId;
  readonly channel: string;
  /** Stream one text delta; the first delta flips the row pending → streaming. */
  delta(text: string): Promise<void>;
  /** Settle successfully. Throws if `data` fails the type's schema (nothing is persisted/emitted). */
  complete(result: { text: string; data?: unknown }): Promise<void>;
  /** Settle as an error with a human-facing message. */
  fail(message: string): Promise<void>;
}

export interface StartGenerativeMessageOptions {
  messageIngress: MessageIngress;
  sessionId: SessionId;
  type: MessageType;
}

export async function startGenerativeMessage(opts: StartGenerativeMessageOptions): Promise<GenerativeMessageHandle> {
  const { messageIngress, sessionId, type } = opts;
  const generationId = newId('evt');
  const message = await messageIngress.begin({
    transcriptTargetId: sessionId,
    idempotencyKey: messageIdempotencyKey('generative-message', generationId, 'begin'),
    producer: { kind: 'system', subsystem: 'generative-message' },
    role: 'assistant',
    type,
    text: ''
  });
  const messageId = message.id;
  const channel = `message:${messageId}`;
  let index = 0;
  let settled = false;

  return {
    messageId,
    channel,
    async delta(text: string) {
      if (settled) return;
      const nextIndex = index++;
      await messageIngress.append({
        transcriptTargetId: sessionId,
        messageId,
        producer: { kind: 'system', subsystem: 'generative-message' },
        channel,
        index: nextIndex,
        delta: text
      });
    },
    async complete(result: { text: string; data?: unknown }) {
      if (settled) return;
      const check = validateMessageData(type, result.data);
      if (!check.ok) throw new Error(`generative message data invalid for type ${type}: ${check.error}`);
      settled = true;
      await messageIngress.settle({
        transcriptTargetId: sessionId,
        messageId,
        idempotencyKey: messageIdempotencyKey('generative-message', generationId, 'complete'),
        producer: { kind: 'system', subsystem: 'generative-message' },
        text: result.text,
        type,
        data: result.data
      });
    },
    async fail(message: string) {
      if (settled) return;
      settled = true;
      await messageIngress.fail({
        transcriptTargetId: sessionId,
        messageId,
        idempotencyKey: messageIdempotencyKey('generative-message', generationId, 'fail'),
        producer: { kind: 'system', subsystem: 'generative-message' },
        error: { code: 'generation_failed', message },
        type
      });
    }
  };
}
