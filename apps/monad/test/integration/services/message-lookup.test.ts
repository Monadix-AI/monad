import type { ChatMessage, MessageId, SessionId } from '@monad/protocol';
import type { Store } from '#/store/db/index.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { MessageLookup } from '#/services/messages/lookup.ts';
import { createStore } from '#/store/db/index.ts';

function message(sessionId: SessionId, id = newId('msg')): ChatMessage {
  return {
    id,
    sessionId,
    role: 'user',
    text: 'visible',
    type: 'text',
    stream: { status: 'settled' },
    active: true,
    createdAt: new Date().toISOString()
  };
}

test('returns only authorized active messages from the requested transcript', () => {
  const store = createStore();
  const transcriptTargetId = newId('ses');
  const otherTranscriptTargetId = newId('ses');
  const active = message(transcriptTargetId);
  const inactive = message(transcriptTargetId);
  const crossTranscript = message(otherTranscriptTargetId);
  store.createMessage({ message: active, idempotencyKey: newId('idem'), fingerprint: 'lookup:active:v1' });
  store.createMessage({ message: inactive, idempotencyKey: newId('idem'), fingerprint: 'lookup:inactive:v1' });
  store.createMessage({
    message: crossTranscript,
    idempotencyKey: newId('idem'),
    fingerprint: 'lookup:cross-transcript:v1'
  });
  store.removeMessage({
    transcriptTargetId,
    messageId: inactive.id,
    idempotencyKey: newId('idem'),
    fingerprint: 'lookup:remove:v1',
    updatedAt: new Date().toISOString()
  });
  const lookup = new MessageLookup(store, () => true);
  const input = { transcriptTargetId, actor: { kind: 'user-client' as const } };

  expect(lookup.get({ ...input, messageId: active.id })).toEqual({ status: 'found', message: active });
  expect(lookup.get({ ...input, messageId: newId('msg') })).toEqual({ status: 'not-found' });
  expect(lookup.get({ ...input, messageId: inactive.id })).toEqual({ status: 'not-found' });
  expect(lookup.get({ ...input, messageId: crossTranscript.id })).toEqual({ status: 'not-found' });
  store.close();
});

test('does not probe storage before authorization and batch lookup is ordered, unique, and bounded', () => {
  const transcriptTargetId = newId('ses');
  const ids = Array.from({ length: 101 }, () => newId('msg'));
  const [firstId, secondId, ...remainingIds] = ids;
  if (!firstId || !secondId) throw new Error('expected generated message ids');
  const expectedIds = [secondId, firstId, ...remainingIds].slice(0, 100);
  const calls: MessageId[] = [];
  const store = {
    getMessage(_target: string, messageId: string) {
      calls.push(messageId as MessageId);
      return message(transcriptTargetId, messageId as MessageId);
    }
  } as unknown as Pick<Store, 'getMessage'>;
  const lookup = new MessageLookup(store, (input) => input.actor.kind !== 'daemon-agent');

  expect(
    lookup.get({
      transcriptTargetId,
      messageId: firstId,
      actor: { kind: 'daemon-agent', sessionId: transcriptTargetId }
    })
  ).toEqual({ status: 'not-found' });
  expect(calls).toEqual([]);
  expect(
    lookup
      .getMany({
        transcriptTargetId,
        messageIds: [secondId, firstId, secondId, ...remainingIds],
        actor: { kind: 'user-client' }
      })
      .map((entry) => entry.id)
  ).toEqual(expectedIds);
  expect(calls).toEqual(expectedIds);
});

test('returns a replying message without loading or expanding its ancestor', () => {
  const transcriptTargetId = newId('ses');
  const ancestorId = newId('msg');
  const reply = { ...message(transcriptTargetId), replyToMessageId: ancestorId };
  const calls: MessageId[] = [];
  const store = {
    getMessage(_target: string, messageId: string) {
      calls.push(messageId as MessageId);
      return messageId === reply.id ? reply : message(transcriptTargetId, messageId as MessageId);
    }
  } as unknown as Pick<Store, 'getMessage'>;
  const lookup = new MessageLookup(store, () => true);

  expect(lookup.get({ transcriptTargetId, messageId: reply.id, actor: { kind: 'user-client' } })).toEqual({
    status: 'found',
    message: reply
  });
  expect(calls).toEqual([reply.id]);
});
