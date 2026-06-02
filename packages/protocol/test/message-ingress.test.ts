import { expect, test } from 'bun:test';

import { nativeAgentProjectMessageSchema, nativeAgentProjectPostRequestSchema } from '../src/mesh-agent/index.ts';
import {
  appendMessageCommandSchema,
  beginMessageCommandSchema,
  deliverMessageCommandSchema,
  failMessageCommandSchema,
  removeMessageCommandSchema,
  settleMessageCommandSchema,
  updateMessageCommandSchema
} from '../src/message-ingress.ts';
import { sendMessageRequestSchema } from '../src/rpc/control.ts';

const producer = { kind: 'agent', agentId: 'agt_100000000000' } as const;
const durableBase = {
  transcriptTargetId: 'prj_100000000000',
  idempotencyKey: 'idem_100000000000',
  producer
} as const;

test('message ingress delivery and streaming commands parse exact contracts', () => {
  expect(
    deliverMessageCommandSchema.parse({
      ...durableBase,
      role: 'assistant',
      type: 'text',
      text: 'Done',
      includeInContext: true
    })
  ).toEqual({
    ...durableBase,
    role: 'assistant',
    type: 'text',
    text: 'Done',
    includeInContext: true
  });
  expect(
    deliverMessageCommandSchema.parse({
      transcriptTargetId: 'ses_TEST00000000',
      idempotencyKey: 'idem_TEST00000000',
      producer: { kind: 'user' },
      role: 'user',
      type: 'text',
      text: 'answer',
      replyToMessageId: 'msg_QUESTION0000'
    })
  ).toEqual({
    transcriptTargetId: 'ses_TEST00000000',
    idempotencyKey: 'idem_TEST00000000',
    producer: { kind: 'user' },
    role: 'user',
    type: 'text',
    text: 'answer',
    replyToMessageId: 'msg_QUESTION0000'
  });
  expect(
    beginMessageCommandSchema.parse({
      ...durableBase,
      role: 'assistant',
      type: 'text',
      text: ''
    })
  ).toEqual({ ...durableBase, role: 'assistant', type: 'text', text: '' });
  expect(
    appendMessageCommandSchema.parse({
      transcriptTargetId: 'prj_100000000000',
      messageId: 'msg_100000000000',
      producer,
      channel: 'content',
      index: 0,
      delta: 'D'
    })
  ).toEqual({
    transcriptTargetId: 'prj_100000000000',
    messageId: 'msg_100000000000',
    producer,
    channel: 'content',
    index: 0,
    delta: 'D'
  });
});

test('message creation contracts preserve one canonical reply edge', () => {
  expect(sendMessageRequestSchema.parse({ text: 'answer', replyToMessageId: 'msg_QUESTION0000' })).toEqual({
    text: 'answer',
    replyToMessageId: 'msg_QUESTION0000'
  });
  expect(
    nativeAgentProjectPostRequestSchema.parse({
      requestId: 'reply-request',
      text: 'answer',
      replyToMessageId: 'msg_QUESTION0000'
    })
  ).toEqual({
    requestId: 'reply-request',
    text: 'answer',
    replyToMessageId: 'msg_QUESTION0000'
  });
  expect(
    nativeAgentProjectMessageSchema.parse({
      id: 'msg_ANSWER000000',
      sessionId: 'ses_TEST00000000',
      text: 'answer',
      replyToMessageId: 'msg_QUESTION0000',
      createdAt: '2026-07-21T00:00:00.000Z'
    })
  ).toEqual({
    id: 'msg_ANSWER000000',
    sessionId: 'ses_TEST00000000',
    text: 'answer',
    replyToMessageId: 'msg_QUESTION0000',
    createdAt: '2026-07-21T00:00:00.000Z'
  });
});

test('message ingress durable mutations carry identity and idempotency', () => {
  expect(
    updateMessageCommandSchema.parse({
      ...durableBase,
      messageId: 'msg_100000000000',
      updates: { text: 'Updated', includeInContext: false }
    })
  ).toEqual({
    ...durableBase,
    messageId: 'msg_100000000000',
    updates: { text: 'Updated', includeInContext: false }
  });
  expect(
    settleMessageCommandSchema.parse({
      ...durableBase,
      messageId: 'msg_100000000000',
      text: 'Done'
    })
  ).toEqual({ ...durableBase, messageId: 'msg_100000000000', text: 'Done' });
  expect(
    failMessageCommandSchema.parse({
      ...durableBase,
      messageId: 'msg_100000000000',
      error: { code: 'provider_error', message: 'Provider failed' }
    })
  ).toEqual({
    ...durableBase,
    messageId: 'msg_100000000000',
    error: { code: 'provider_error', message: 'Provider failed' }
  });
  expect(
    removeMessageCommandSchema.parse({
      ...durableBase,
      messageId: 'msg_100000000000'
    })
  ).toEqual({ ...durableBase, messageId: 'msg_100000000000' });
});

test('message ingress rejects invalid identities and delta ordering', () => {
  expect(() =>
    appendMessageCommandSchema.parse({
      transcriptTargetId: 'agt_100000000000',
      messageId: 'msg_100000000000',
      channel: 'content',
      index: -1,
      delta: 'D'
    })
  ).toThrow();
  expect(() =>
    removeMessageCommandSchema.parse({
      ...durableBase,
      idempotencyKey: 'not-stable',
      messageId: 'msg_100000000000'
    })
  ).toThrow();
});
