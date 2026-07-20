import type { ChatMessage, TranscriptTargetId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '#/store/db/index.ts';

const createdAt = '2026-07-18T14:00:00.000Z';
const updatedAt = '2026-07-18T14:01:00.000Z';
const laterAt = '2026-07-18T14:02:00.000Z';

function message<T extends TranscriptTargetId>(
  transcriptTargetId: T,
  overrides: Partial<Omit<ChatMessage, 'sessionId'>> = {}
): ChatMessage & { sessionId: T } {
  const id = overrides.id ?? newId('msg');
  return {
    id,
    sessionId: transcriptTargetId,
    role: 'assistant',
    text: 'hello',
    type: 'text',
    stream: { status: 'settled' },
    active: true,
    createdAt,
    ...overrides
  };
}

test('canonical message mutations advance one transcript revision per durable change', () => {
  const store = createStore();
  const target = newId('ses');
  const delivered = message(target);

  expect(
    store.createMessage({
      message: delivered,
      idempotencyKey: 'idem_deliver',
      fingerprint: 'deliver:v1'
    })
  ).toEqual({ message: delivered, messageRevision: 1, changed: true });

  const edited = { ...delivered, text: 'edited', updatedAt };
  expect(
    store.updateMessage({
      transcriptTargetId: target,
      messageId: delivered.id,
      idempotencyKey: 'idem_update',
      fingerprint: 'update:v1',
      updates: { text: 'edited' },
      updatedAt
    })
  ).toEqual({ message: edited, messageRevision: 2, changed: true });

  expect(
    store.updateMessage({
      transcriptTargetId: target,
      messageId: delivered.id,
      idempotencyKey: 'idem_nochange',
      fingerprint: 'update:nochange:v1',
      updates: { text: 'edited' },
      updatedAt: laterAt
    })
  ).toEqual({ message: edited, messageRevision: 2, changed: false });
  expect(store.getMessageRevision(target)).toBe(2);

  const streaming = message(target, {
    id: newId('msg'),
    text: '',
    stream: { status: 'pending', source: { transcriptTargetId: target, messageId: newId('msg') } }
  });
  streaming.stream.source = { transcriptTargetId: target, messageId: streaming.id };
  expect(
    store.createMessage({
      message: streaming,
      idempotencyKey: 'idem_begin',
      fingerprint: 'begin:v1'
    })
  ).toEqual({ message: streaming, messageRevision: 3, changed: true });

  const settled = {
    ...streaming,
    text: 'done',
    data: { answer: 42 },
    stream: { status: 'complete' as const },
    updatedAt
  };
  expect(
    store.settleMessage({
      transcriptTargetId: target,
      messageId: streaming.id,
      idempotencyKey: 'idem_settle',
      fingerprint: 'settle:v1',
      text: 'done',
      data: { answer: 42 },
      updatedAt
    })
  ).toEqual({ message: settled, messageRevision: 4, changed: true });

  const failing = message(target, {
    id: newId('msg'),
    text: '',
    stream: { status: 'pending', source: { transcriptTargetId: target, messageId: newId('msg') } }
  });
  failing.stream.source = { transcriptTargetId: target, messageId: failing.id };
  expect(
    store.createMessage({ message: failing, idempotencyKey: 'idem_begin_fail', fingerprint: 'begin:fail:v1' })
  ).toEqual({ message: failing, messageRevision: 5, changed: true });

  const failed = {
    ...failing,
    data: { error: { code: 'provider_error', message: 'boom' } },
    stream: { status: 'error' as const },
    updatedAt
  };
  expect(
    store.failMessage({
      transcriptTargetId: target,
      messageId: failing.id,
      idempotencyKey: 'idem_fail',
      fingerprint: 'fail:v1',
      data: { error: { code: 'provider_error', message: 'boom' } },
      updatedAt
    })
  ).toEqual({ message: failed, messageRevision: 6, changed: true });

  const removed = { ...edited, active: false, updatedAt };
  expect(
    store.removeMessage({
      transcriptTargetId: target,
      messageId: delivered.id,
      idempotencyKey: 'idem_remove',
      fingerprint: 'remove:v1',
      updatedAt
    })
  ).toEqual({ message: removed, messageRevision: 7, changed: true });
  expect(store.getMessageRevision(target)).toBe(7);
  expect(store.listMessagesSnapshot(target, { includeInactive: true })).toEqual({
    messages: [removed, settled, failed],
    messageRevision: 7
  });
  expect(
    store.updateMessage({
      transcriptTargetId: target,
      messageId: delivered.id,
      idempotencyKey: 'idem_update',
      fingerprint: 'update:v1',
      updates: { text: 'edited' },
      updatedAt
    })
  ).toEqual({ message: edited, messageRevision: 2, changed: false });
  expect(store.getMessageRevision(target)).toBe(7);
  expect(() =>
    store.updateMessage({
      transcriptTargetId: target,
      messageId: delivered.id,
      idempotencyKey: 'idem_update',
      fingerprint: 'update:v2',
      updates: { text: 'other' },
      updatedAt
    })
  ).toThrow('idempotency key reused with a different command');
  store.close();
});

test('duplicate idempotency keys replay the original snapshot without advancing revision', () => {
  const store = createStore();
  const target = newId('prj');
  const delivered = message(target, { role: 'user' });
  const input = {
    message: delivered,
    idempotencyKey: 'idem_project_message',
    fingerprint: 'deliver:project:v1'
  } as const;

  expect(store.createMessage(input)).toEqual({ message: delivered, messageRevision: 1, changed: true });
  expect(store.createMessage(input)).toEqual({ message: delivered, messageRevision: 1, changed: false });
  expect(store.getMessageRevision(target)).toBe(1);
  expect(store.listMessagesSnapshot(target)).toEqual({ messages: [delivered], messageRevision: 1 });

  expect(() => store.createMessage({ ...input, fingerprint: 'deliver:project:v2' })).toThrow(
    'idempotency key reused with a different command'
  );
  expect(store.getMessageRevision(target)).toBe(1);
  store.close();
});

test('managed mesh streaming messages match by stable member id instead of agent display name', () => {
  const store = createStore();
  const target = newId('ses');
  const streaming = message(target, {
    id: newId('msg'),
    text: '',
    data: {
      source: 'managed-mesh-agent',
      meshSessionId: 'mesh_memberid0000',
      memberId: 'pmem_reviewer0000',
      agentName: 'Renamed reviewer'
    },
    stream: { status: 'streaming', source: { transcriptTargetId: target, messageId: newId('msg') } }
  });

  try {
    expect(
      store.createMessage({
        message: streaming,
        idempotencyKey: 'idem_stream_memberid',
        fingerprint: 'stream:memberid:v1'
      })
    ).toEqual({ message: streaming, messageRevision: 1, changed: true });
    expect(store.findManagedMeshAgentStreamingMessage(target, 'mesh_memberid0000', 'pmem_reviewer0000')).toBe(
      streaming.id
    );
    expect(
      store.retireManagedMeshAgentStreamingMessage(
        target,
        streaming.id,
        'mesh_memberid0000',
        'pmem_reviewer0000',
        laterAt
      )
    ).toBe(true);
    expect(store.getMessage(target, streaming.id)).toEqual({
      ...streaming,
      stream: { status: 'complete', source: undefined },
      active: false,
      updatedAt: laterAt
    });
  } finally {
    store.close();
  }
});
