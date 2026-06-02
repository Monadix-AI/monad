import { expect, test } from 'bun:test';

import {
  nativeAgentProjectAskCancelRequestSchema,
  nativeAgentProjectAskCancelResponseSchema,
  nativeAgentProjectAskRequestSchema,
  nativeAgentProjectAskResponseSchema,
  nativeAgentProjectInboxAckResponseSchema
} from '../src/mesh-agent/mesh-agent-project-messaging.ts';

test('project ask cancellation contracts preserve exact request identity and cause', () => {
  expect(nativeAgentProjectAskCancelRequestSchema.parse({ requestId: 'ask_native_timeout', cause: 'timeout' })).toEqual(
    { requestId: 'ask_native_timeout', cause: 'timeout' }
  );
  expect(
    nativeAgentProjectAskCancelResponseSchema.parse({
      ok: true,
      requestId: 'ask_native_timeout',
      status: 'timed_out'
    })
  ).toEqual({ ok: true, requestId: 'ask_native_timeout', status: 'timed_out' });
});

test('normalizes a legacy scalar ask into a defaulted question card', () => {
  const request = nativeAgentProjectAskRequestSchema.parse({
    sessionId: 'ses_123456789012',
    question: 'Pick one',
    options: ['A', 'B']
  });

  expect(request).toEqual({
    sessionId: 'ses_123456789012',
    questions: [
      {
        id: 'q1',
        question: 'Pick one',
        options: ['A', 'B'],
        mode: 'single',
        allowOther: true
      }
    ],
    blocking: false,
    autoResolutionMs: 240_000
  });
});

test('parses per-item inbox acknowledgement without losing the cursor compatibility fields', () => {
  const response = {
    ok: true,
    sessionId: 'ses_123456789012',
    cursor: 42,
    requestedCursor: 42,
    visibleCursor: 40,
    consumedDeliveryIds: ['deliv_123456789012'],
    deferredDeliveryIds: ['deliv_abcdefghijkl']
  };

  const parsed = nativeAgentProjectInboxAckResponseSchema.parse(response);
  expect(parsed).toEqual(response as typeof parsed);
});

test('normalizes one blocking call with multiple questions into one card', () => {
  const request = nativeAgentProjectAskRequestSchema.parse({
    sessionId: 'ses_123456789012',
    blocking: true,
    questions: [
      { question: 'Pick one', options: ['A', 'B'] },
      { id: 'details', question: 'Why?' }
    ]
  });

  expect(request).toEqual({
    sessionId: 'ses_123456789012',
    questions: [
      {
        id: 'q1',
        question: 'Pick one',
        options: ['A', 'B'],
        mode: 'single',
        allowOther: true
      },
      {
        id: 'details',
        question: 'Why?',
        options: [],
        mode: 'single',
        allowOther: true
      }
    ],
    blocking: true
  });
});

test('rejects duplicate question ids in one ask card', () => {
  expect(() =>
    nativeAgentProjectAskRequestSchema.parse({
      questions: [
        { id: 'same', question: 'First?' },
        { id: 'same', question: 'Second?' }
      ]
    })
  ).toThrow('Question ids must be unique');
});

test('parses every durable project ask outcome', () => {
  const outcomes: unknown[] = [
    { ok: true, requestId: 'ask-1', status: 'answered', answer: 'A', answers: { q1: 'A' } },
    { ok: true, requestId: 'ask-1', status: 'skipped' },
    { ok: true, requestId: 'ask-1', status: 'timed_out' },
    { ok: true, requestId: 'ask-1', status: 'cancelled' },
    { ok: true, requestId: 'ask-1', status: 'awaiting_human', instruction: 'end_turn' }
  ];

  const parsed = outcomes.map((outcome) => nativeAgentProjectAskResponseSchema.parse(outcome));
  expect(parsed).toEqual(outcomes as typeof parsed);
});
