import { expect, test } from 'bun:test';

import { meshAgentIdleResumedPayloadSchema, meshAgentIdleSuspendedPayloadSchema } from '../src/event-table.ts';
import { meshAgentSystemEventSchema } from '../src/mesh-agent/index.ts';
import { listUiItemsResponseSchema, sessionUiEventSchema, uiSnapshotEventSchema } from '../src/ui.ts';

test('sessionUiEventSchema accepts snapshot and upsert payloads', () => {
  expect(
    sessionUiEventSchema.parse({
      kind: 'snapshot',
      items: [
        {
          kind: 'message',
          id: 'msg_100000000000',
          role: 'assistant',
          parts: [{ type: 'text', text: 'hello' }],
          status: 'done',
          seq: 'msg_100000000000'
        }
      ]
    }).kind
  ).toBe('snapshot');

  expect(
    sessionUiEventSchema.parse({
      kind: 'upsert',
      item: {
        kind: 'tool',
        id: 'tool_1',
        tool: 'search',
        status: 'running',
        seq: 'evt_100000000000'
      }
    }).kind
  ).toBe('upsert');
});

test('mesh-agent system events preserve exact typed variants and legacy system items', () => {
  const suspended = {
    agentId: 'pmem_codex_1',
    agentName: 'Reviewer',
    type: 'idle_suspended' as const,
    payload: { meshSessionId: 'mesh_idle00000000', idleTimeoutMs: 300 }
  };
  const resumed = {
    agentId: 'pmem_codex_1',
    agentName: 'Reviewer',
    type: 'idle_resumed' as const,
    payload: { meshSessionId: 'mesh_idle00000000' }
  };
  const current = sessionUiEventSchema.parse({
    kind: 'upsert',
    item: {
      kind: 'system',
      id: 'mesh-agent-idle-suspended:pmem_codex_1:evt_1',
      text: 'fell asleep.',
      event: suspended,
      seq: 'evt_1'
    }
  });
  const legacy = sessionUiEventSchema.parse({
    kind: 'upsert',
    item: { kind: 'system', id: 'legacy', text: 'Legacy notice', seq: 'evt_0' }
  });

  expect(meshAgentSystemEventSchema.parse(suspended)).toEqual(suspended);
  expect(meshAgentSystemEventSchema.parse(resumed)).toEqual(resumed);
  expect(meshAgentIdleSuspendedPayloadSchema.parse(suspended)).toEqual(suspended);
  expect(meshAgentIdleResumedPayloadSchema.parse(resumed)).toEqual(resumed);
  expect(current).toEqual({
    kind: 'upsert',
    item: {
      kind: 'system',
      id: 'mesh-agent-idle-suspended:pmem_codex_1:evt_1',
      text: 'fell asleep.',
      event: suspended,
      seq: 'evt_1'
    }
  });
  expect(legacy).toEqual({
    kind: 'upsert',
    item: { kind: 'system', id: 'legacy', text: 'Legacy notice', seq: 'evt_0' }
  });
});

test('mesh-agent system events reject mismatched lifecycle payloads', () => {
  expect(() =>
    meshAgentSystemEventSchema.parse({
      agentId: 'pmem_codex_1',
      agentName: 'Reviewer',
      type: 'idle_resumed',
      payload: { meshSessionId: 'mesh_idle00000000', idleTimeoutMs: 300 }
    })
  ).toThrow();
  expect(() =>
    meshAgentSystemEventSchema.parse({
      agentId: 'pmem_codex_1',
      agentName: 'Reviewer',
      type: 'idle_suspended',
      payload: { meshSessionId: 'mesh_idle00000000' }
    })
  ).toThrow();
});

test('idle suspension requires a positive integer timeout', () => {
  const event = {
    agentId: 'pmem_codex_1',
    agentName: 'Reviewer',
    type: 'idle_suspended',
    payload: { meshSessionId: 'mesh_idle00000000', idleTimeoutMs: 0 }
  };

  expect(() => meshAgentSystemEventSchema.parse(event)).toThrow();
  expect(() =>
    meshAgentSystemEventSchema.parse({
      ...event,
      payload: { ...event.payload, idleTimeoutMs: 1.5 }
    })
  ).toThrow();
});

test('sessionUiEventSchema preserves authoritative transcript replacement snapshots', () => {
  expect(
    uiSnapshotEventSchema.parse({ kind: 'snapshot', items: [], replacesTranscript: true }).replacesTranscript
  ).toBe(true);
});

test('listUiItemsResponseSchema accepts mixed ui items', () => {
  const parsed = listUiItemsResponseSchema.parse({
    items: [
      {
        kind: 'message',
        id: 'msg_100000000000',
        role: 'user',
        parts: [{ type: 'text', text: 'ping' }],
        seq: 'msg_100000000000'
      },
      {
        kind: 'context',
        id: 'context',
        usage: {
          contextLimit: 1000,
          used: 100,
          free: 884,
          autocompactBuffer: 16,
          approximate: true,
          segments: [{ category: 'messages', label: 'messages', tokens: 100 }]
        },
        seq: 'evt_100000000000'
      },
      {
        kind: 'memory_summary',
        id: 'memory-summary:msg_100000000000',
        summary: 'Earlier turns discussed setup and constraints.',
        uptoMessageId: 'msg_100000000000',
        seq: 'msg_100000000000'
      },
      {
        kind: 'custom',
        id: 'tsk_100000000000',
        name: 'task.created',
        data: { taskId: 'tsk_100000000000', title: 'Plan' },
        status: 'streaming',
        seq: 'evt_200000000000'
      }
    ]
  });

  expect(parsed.items).toHaveLength(4);
});

test('ui schemas accept custom parts and removal targets', () => {
  expect(
    sessionUiEventSchema.parse({
      kind: 'upsert',
      item: {
        kind: 'message',
        id: 'msg_100000000000',
        role: 'assistant',
        parts: [{ type: 'custom', name: 'monad.directive', data: { command: '/model' } }],
        seq: 'evt_100000000000'
      }
    }).kind
  ).toBe('upsert');

  expect(
    sessionUiEventSchema.parse({
      kind: 'remove',
      target: { kind: 'custom', id: 'tsk_100000000000' }
    }).kind
  ).toBe('remove');

  expect(
    sessionUiEventSchema.parse({
      kind: 'remove',
      target: { kind: 'tool', id: 'call_1' }
    }).kind
  ).toBe('remove');
});
