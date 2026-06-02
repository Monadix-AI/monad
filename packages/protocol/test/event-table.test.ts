import { expect, test } from 'bun:test';
import { z } from 'zod';

import { eventTypeSchema } from '../src/domain.ts';
import {
  EVENT_DEFINITIONS,
  EVENT_TABLE,
  eventDefinition,
  eventSchema,
  parseEventPayload,
  parsePersistedEvent
} from '../src/event-table.ts';
import { uiMessageItemSchema } from '../src/ui.ts';

test('removed message and raw-output event names are rejected', () => {
  const removed = [
    'user.message',
    'agent.message',
    'agent.token',
    'agent.reasoning',
    'agent.error',
    'message.delta',
    'message.complete',
    'mesh.output'
  ];
  expect(removed.map((type) => eventTypeSchema.safeParse(type).success)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false
  ]);
});

test('every EVENT_TABLE entry is a ZodType', () => {
  for (const [type, schema] of Object.entries(EVENT_TABLE)) {
    expect(schema instanceof z.ZodType, `${type} is not a ZodType`).toBe(true);
  }
});

test('event schema rejects a payload that violates its event type contract', () => {
  const parsed = eventSchema.safeParse({
    id: 'evt_100000000000',
    sessionId: 'ses_100000000000',
    type: 'mesh.resume_failed',
    actorAgentId: null,
    payload: {
      agentName: 'reviewer',
      provider: 'claude-code',
      providerSessionRef: 'thread-42',
      message: 'resume failed',
      fallback: 'cold-start'
    },
    at: '2026-07-20T00:00:00.000Z'
  });

  expect(parsed.success).toBe(false);
  expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['payload', 'code']]);
});

test('MeshAgent connection required events carry provider reconnect guidance', () => {
  const payload = parseEventPayload('mesh.connection_required', {
    meshSessionId: 'mesh_100000000000',
    agentName: 'gemini',
    provider: 'gemini',
    reason: 'Gemini CLI is waiting for provider authentication to complete.',
    reconnectIn: 'studio'
  });

  expect(payload).toEqual({
    meshSessionId: 'mesh_100000000000',
    agentName: 'gemini',
    provider: 'gemini',
    reason: 'Gemini CLI is waiting for provider authentication to complete.',
    reconnectIn: 'studio'
  });
});

const message = {
  id: 'msg_100000000000',
  sessionId: 'prj_100000000000',
  role: 'assistant',
  text: 'Done',
  type: 'text',
  stream: { status: 'complete' },
  active: true,
  createdAt: '2026-07-18T00:00:00.000Z'
} as const;

const externalProducer = {
  kind: 'mesh-agent',
  meshSessionId: 'mesh_100000000000',
  agentName: 'reviewer'
} as const;

test('canonical message events carry the complete durable contract', () => {
  expect(
    parseEventPayload('session.message.created', {
      transcriptTargetId: 'prj_100000000000',
      producer: externalProducer,
      message,
      messageRevision: 1
    })
  ).toEqual({ transcriptTargetId: 'prj_100000000000', producer: externalProducer, message, messageRevision: 1 });

  expect(
    parseEventPayload('session.message.updated', {
      transcriptTargetId: 'prj_100000000000',
      producer: externalProducer,
      message,
      messageRevision: 2
    })
  ).toEqual({ transcriptTargetId: 'prj_100000000000', producer: externalProducer, message, messageRevision: 2 });

  expect(
    parseEventPayload('session.message.deleted', {
      transcriptTargetId: 'prj_100000000000',
      producer: externalProducer,
      messageId: 'msg_100000000000',
      messageRevision: 3
    })
  ).toEqual({
    transcriptTargetId: 'prj_100000000000',
    producer: externalProducer,
    messageId: 'msg_100000000000',
    messageRevision: 3
  });

  expect(
    parseEventPayload('session.message.delta.appended', {
      transcriptTargetId: 'prj_100000000000',
      producer: externalProducer,
      messageId: 'msg_100000000000',
      channel: 'reasoning',
      index: 4,
      delta: 'Checking'
    })
  ).toEqual({
    transcriptTargetId: 'prj_100000000000',
    producer: externalProducer,
    messageId: 'msg_100000000000',
    channel: 'reasoning',
    index: 4,
    delta: 'Checking'
  });

  for (const type of ['session.message.completed', 'session.message.failed'] as const) {
    expect(
      parseEventPayload(type, {
        transcriptTargetId: 'prj_100000000000',
        producer: externalProducer,
        message,
        messageRevision: 5
      })
    ).toEqual({ transcriptTargetId: 'prj_100000000000', producer: externalProducer, message, messageRevision: 5 });
  }
});

test('clarification events link the question and optional answer messages', () => {
  expect(
    parseEventPayload('clarify.requested', {
      requestId: 'clarify_TEST00000',
      question: 'Which path?',
      questionMessageId: 'msg_QUESTION0000'
    })
  ).toEqual({
    requestId: 'clarify_TEST00000',
    question: 'Which path?',
    questionMessageId: 'msg_QUESTION0000'
  });
  expect(
    parseEventPayload('clarify.resolved', {
      requestId: 'clarify_TEST00000',
      answer: 'Ship',
      questionMessageId: 'msg_QUESTION0000',
      answerMessageId: 'msg_ANSWER000000'
    })
  ).toEqual({
    requestId: 'clarify_TEST00000',
    answer: 'Ship',
    questionMessageId: 'msg_QUESTION0000',
    answerMessageId: 'msg_ANSWER000000'
  });
  expect(
    parseEventPayload('clarify.resolved', {
      requestId: 'clarify_TEST00000',
      answer: '',
      questionMessageId: 'msg_QUESTION0000',
      reason: 'timeout'
    })
  ).toEqual({
    requestId: 'clarify_TEST00000',
    answer: '',
    questionMessageId: 'msg_QUESTION0000',
    reason: 'timeout'
  });
  expect(() =>
    parseEventPayload('clarify.requested', { requestId: 'clarify_TEST00000', question: 'Which path?' })
  ).toThrow();
  expect(() => parseEventPayload('clarify.resolved', { requestId: 'clarify_TEST00000', answer: 'Ship' })).toThrow();
});

test('persisted event parsing recognizes and omits pre-canonical clarification lifecycle rows', () => {
  const legacy = {
    id: 'evt_LEGACY000000',
    sessionId: 'ses_TEST00000000',
    type: 'clarify.requested',
    actorAgentId: null,
    payload: { requestId: 'clarify_LEGACY000', question: 'Old question' },
    at: '2026-07-20T00:00:00.000Z'
  };

  expect(parsePersistedEvent(legacy)).toBeNull();
  expect(
    parsePersistedEvent({
      ...legacy,
      type: 'clarify.resolved',
      payload: { requestId: 'clarify_LEGACY000', answer: 'Old answer' }
    })
  ).toBeNull();
  expect(() =>
    parsePersistedEvent({
      ...legacy,
      payload: { ...legacy.payload, questionMessageId: 42 }
    })
  ).toThrow();
});

test('UI message items round-trip the registry-derived reply projection', () => {
  const item = {
    kind: 'message' as const,
    id: 'msg_ANSWER000000',
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: 'answer' }],
    replyToMessageId: 'msg_QUESTION0000' as const,
    replyable: true,
    seq: 'msg_ANSWER000000'
  };
  expect(uiMessageItemSchema.parse(item)).toEqual(item);
  expect(
    uiMessageItemSchema.parse({
      kind: 'message',
      id: 'msg_TEXT00000000',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Done' }],
      seq: 'msg_TEXT00000000'
    }).replyable
  ).toBe(false);
});

test('canonical run and provider connection payloads are exact', () => {
  expect(
    parseEventPayload('session.run.started', {
      transcriptTargetId: 'ses_100000000000'
    })
  ).toEqual({ transcriptTargetId: 'ses_100000000000' });
  expect(
    parseEventPayload('session.run.failed', {
      transcriptTargetId: 'ses_100000000000',
      error: { code: 'provider_error', message: 'Provider failed' }
    })
  ).toEqual({
    transcriptTargetId: 'ses_100000000000',
    error: { code: 'provider_error', message: 'Provider failed' }
  });
  expect(
    parseEventPayload('mesh.session.connection.opened', {
      meshSessionId: 'mesh_100000000000',
      provider: 'codex',
      observationEpoch: 'epoch-1'
    })
  ).toEqual({ meshSessionId: 'mesh_100000000000', provider: 'codex', observationEpoch: 'epoch-1' });
  expect(
    parseEventPayload('mesh.session.connection.closed', {
      meshSessionId: 'mesh_100000000000',
      provider: 'codex',
      observationEpoch: 'epoch-1',
      reason: 'disconnected'
    })
  ).toEqual({
    meshSessionId: 'mesh_100000000000',
    provider: 'codex',
    observationEpoch: 'epoch-1',
    reason: 'disconnected'
  });
});

test('event definitions are exhaustive and own delivery metadata', () => {
  expect(Object.keys(EVENT_DEFINITIONS).sort()).toEqual(Object.keys(EVENT_TABLE).sort());
  expect(eventDefinition('session.message.created')).toEqual({
    schema: EVENT_TABLE['session.message.created'],
    delivery: 'control',
    persistence: 'durable'
  });
  expect(eventDefinition('session.message.delta.appended')).toEqual({
    schema: EVENT_TABLE['session.message.delta.appended'],
    delivery: 'generation',
    persistence: 'transient'
  });
  expect(eventDefinition('session.message.completed')).toEqual({
    schema: EVENT_TABLE['session.message.completed'],
    delivery: 'both',
    persistence: 'durable'
  });
  expect(eventDefinition('tool.approval_requested')).toEqual({
    schema: EVENT_TABLE['tool.approval_requested'],
    delivery: 'both',
    persistence: 'durable'
  });
  expect(eventDefinition('tool.approval_resolved')).toEqual({
    schema: EVENT_TABLE['tool.approval_resolved'],
    delivery: 'both',
    persistence: 'durable'
  });
  expect(eventDefinition('mesh.approval_requested')).toEqual({
    schema: EVENT_TABLE['mesh.approval_requested'],
    delivery: 'both',
    persistence: 'durable'
  });
  expect(eventDefinition('mesh.approval_resolved')).toEqual({
    schema: EVENT_TABLE['mesh.approval_resolved'],
    delivery: 'both',
    persistence: 'durable'
  });
  expect(eventDefinition('mesh.session.connection.opened')).toEqual({
    schema: EVENT_TABLE['mesh.session.connection.opened'],
    delivery: 'control',
    persistence: 'transient'
  });
  expect(eventDefinition('clarify.requested')).toEqual({
    schema: EVENT_TABLE['clarify.requested'],
    delivery: 'both',
    persistence: 'durable'
  });
  expect(eventDefinition('clarify.resolved')).toEqual({
    schema: EVENT_TABLE['clarify.resolved'],
    delivery: 'both',
    persistence: 'durable'
  });
  expect(eventDefinition('session.attention.updated')).toEqual({
    schema: EVENT_TABLE['session.attention.updated'],
    delivery: 'control',
    persistence: 'transient'
  });
  expect(eventDefinition('session.attention.consumed')).toEqual({
    schema: EVENT_TABLE['session.attention.consumed'],
    delivery: 'control',
    persistence: 'durable'
  });
  expect(eventDefinition('mesh.catalog.updated')).toEqual({
    schema: EVENT_TABLE['mesh.catalog.updated'],
    delivery: 'control',
    persistence: 'transient'
  });
});

test('MeshAgent catalog updates identify the cache resources clients must refresh', () => {
  expect(
    parseEventPayload('mesh.catalog.updated', {
      resources: ['agents', 'presets', 'invitable-agents'],
      updatedAt: '2026-08-03T05:00:00.000Z'
    })
  ).toEqual({
    resources: ['agents', 'presets', 'invitable-agents'],
    updatedAt: '2026-08-03T05:00:00.000Z'
  });
});
