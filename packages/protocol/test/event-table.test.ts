import { expect, test } from 'bun:test';
import { z } from 'zod';

import { eventTypeSchema } from '../src/domain.ts';
import { EVENT_DEFINITIONS, EVENT_TABLE, eventDefinition, parseEventPayload } from '../src/event-table.ts';

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
  expect(eventDefinition('mesh.session.connection.opened')).toEqual({
    schema: EVENT_TABLE['mesh.session.connection.opened'],
    delivery: 'control',
    persistence: 'transient'
  });
});
