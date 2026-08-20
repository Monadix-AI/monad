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
    // The locator keys on meshSessionId, never the stored member key — a wrong meshSessionId misses even
    // with the right identity, and the right meshSessionId hits regardless of what member key is stored.
    expect(store.findManagedMeshAgentStreamingMessage(target, 'mesh_wrong0000000')).toBeNull();
    expect(store.findManagedMeshAgentStreamingMessage(target, 'mesh_memberid0000')).toBe(streaming.id);
    expect(store.retireManagedMeshAgentStreamingMessage(target, streaming.id, 'mesh_memberid0000', laterAt)).toBe(true);
    expect(store.getMessage(target, streaming.id)).toEqual({
      ...streaming,
      stream: { status: 'complete', source: undefined },
      active: false,
      updatedAt: laterAt
    });
    // Once settled, the row is history: the locator no longer returns it, so a settled placeholder can
    // never be re-completed or retired a second time.
    expect(store.findManagedMeshAgentStreamingMessage(target, 'mesh_memberid0000')).toBeNull();
  } finally {
    store.close();
  }
});

test('message replies round-trip through durable storage', () => {
  const store = createStore();
  const sessionId = newId('ses');
  const question = newId('msg');
  const answer = newId('msg');

  try {
    store.insertMessage(question, sessionId, 'question', createdAt);
    store.insertMessage(answer, sessionId, 'answer', createdAt, 'user', { replyToMessageId: question });

    expect(store.getMessage(sessionId, answer)).toEqual({
      id: answer,
      sessionId,
      role: 'user',
      text: 'answer',
      type: 'text',
      replyToMessageId: question,
      stream: { status: 'settled', source: undefined },
      active: true,
      createdAt: expect.any(String),
      updatedAt: undefined
    });
  } finally {
    store.close();
  }
});

test('createMessage rejects a missing reply target atomically', () => {
  const store = createStore();
  const sessionId = newId('ses');

  try {
    expect(() =>
      store.createMessage({
        message: message(sessionId, { replyToMessageId: newId('msg') }),
        idempotencyKey: newId('idem'),
        fingerprint: 'reply:missing:v1'
      })
    ).toThrow('reply_target_not_found');
    expect(store.listMessages(sessionId)).toEqual([]);
    expect(store.getMessageRevision(sessionId)).toBe(0);
  } finally {
    store.close();
  }
});

test('createMessage rejects a cross-transcript reply target', () => {
  const store = createStore();
  const sessionId = newId('ses');
  const otherSessionId = newId('ses');
  const crossTranscriptTarget = message(otherSessionId);

  try {
    store.insertMessage(crossTranscriptTarget.id, otherSessionId, crossTranscriptTarget.text, createdAt);
    expect(() =>
      store.createMessage({
        message: message(sessionId, { replyToMessageId: crossTranscriptTarget.id }),
        idempotencyKey: newId('idem'),
        fingerprint: 'reply:cross-transcript:v1'
      })
    ).toThrow('reply_target_not_found');
    expect(store.listMessages(sessionId)).toEqual([]);
  } finally {
    store.close();
  }
});

test('createMessage rejects a self reply target', () => {
  const store = createStore();
  const sessionId = newId('ses');
  const self = message(sessionId);

  try {
    expect(() =>
      store.createMessage({
        message: { ...self, replyToMessageId: self.id },
        idempotencyKey: newId('idem'),
        fingerprint: 'reply:self:v1'
      })
    ).toThrow('invalid_reply_target');
  } finally {
    store.close();
  }
});

test('createMessage rejects an inactive reply target', () => {
  const store = createStore();
  const sessionId = newId('ses');
  const target = message(sessionId);

  try {
    store.createMessage({ message: target, idempotencyKey: newId('idem'), fingerprint: 'reply:inactive-target:v1' });
    store.removeMessage({
      transcriptTargetId: sessionId,
      messageId: target.id,
      idempotencyKey: newId('idem'),
      fingerprint: 'reply:remove-target:v1',
      updatedAt
    });
    const self = message(sessionId);
    expect(() =>
      store.createMessage({
        message: { ...self, replyToMessageId: target.id },
        idempotencyKey: newId('idem'),
        fingerprint: 'reply:inactive:v1'
      })
    ).toThrow('reply_target_not_found');
  } finally {
    store.close();
  }
});

test('createMessage rejects a streaming reply target', () => {
  const store = createStore();
  const sessionId = newId('ses');
  const target = message(sessionId, {
    stream: { status: 'pending', source: { transcriptTargetId: sessionId, messageId: newId('msg') } }
  });

  try {
    store.createMessage({ message: target, idempotencyKey: newId('idem'), fingerprint: 'reply:streaming-target:v1' });
    expect(() =>
      store.createMessage({
        message: message(sessionId, { replyToMessageId: target.id }),
        idempotencyKey: newId('idem'),
        fingerprint: 'reply:streaming:v1'
      })
    ).toThrow('invalid_reply_target');
  } finally {
    store.close();
  }
});

test('createMessage rejects a non-replyable reply target', () => {
  const store = createStore();
  const sessionId = newId('ses');
  const target = message(sessionId, { type: 'directive' });

  try {
    store.createMessage({ message: target, idempotencyKey: newId('idem'), fingerprint: 'reply:directive-target:v1' });
    expect(() =>
      store.createMessage({
        message: message(sessionId, { replyToMessageId: target.id }),
        idempotencyKey: newId('idem'),
        fingerprint: 'reply:directive:v1'
      })
    ).toThrow('invalid_reply_target');
  } finally {
    store.close();
  }
});

test('cloned messages remap reply edges only within the cloned set', () => {
  const store = createStore();
  const sourceId = newId('ses');
  const targetId = newId('ses');
  const question = message(sourceId, { role: 'user', text: 'question' });
  const answer = message(sourceId, { role: 'assistant', text: 'answer', replyToMessageId: question.id });
  const outsideReply = message(sourceId, { role: 'assistant', text: 'outside', replyToMessageId: newId('msg') });

  try {
    const clonedIds = store.cloneMessages(targetId, [question, answer, outsideReply]);
    const clonedQuestionId = clonedIds.get(question.id);
    const clonedAnswerId = clonedIds.get(answer.id);
    const clonedOutsideReplyId = clonedIds.get(outsideReply.id);
    if (!clonedQuestionId || !clonedAnswerId || !clonedOutsideReplyId) throw new Error('expected cloned ids');

    expect(store.getMessage(targetId, clonedAnswerId)).toMatchObject({
      id: clonedAnswerId,
      replyToMessageId: clonedQuestionId
    });
    expect(store.getMessage(targetId, clonedOutsideReplyId)).toMatchObject({
      id: clonedOutsideReplyId,
      replyToMessageId: undefined
    });
  } finally {
    store.close();
  }
});
