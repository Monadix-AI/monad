import { expect, test } from 'bun:test';

import { meshAgentIdleResumedPayloadSchema, meshAgentIdleSuspendedPayloadSchema } from '../src/event-table.ts';
import { meshAgentSystemEventSchema } from '../src/mesh-agent/index.ts';
import {
  listUiItemsResponseSchema,
  sessionUiEventSchema,
  uiMessageItemSchema,
  uiSnapshotEventSchema
} from '../src/ui.ts';

test('message UI items preserve validated project-question presentation', () => {
  const item = {
    kind: 'message' as const,
    id: 'msg_question00000',
    role: 'assistant' as const,
    parts: [{ type: 'text' as const, text: 'Q: Which path?\nOptions: Ship | Revise' }],
    question: { question: 'Which path?', options: ['Ship', 'Revise'] },
    replyable: false,
    status: 'streaming' as const,
    seq: '2026-07-21T00:00:00.000Z'
  };

  expect(uiMessageItemSchema.parse(item)).toEqual(item);
  expect(() =>
    uiMessageItemSchema.parse({ ...item, question: { question: 'Which path?', options: ['Ship', 2] } })
  ).toThrow();
});

test('sessionUiEventSchema accepts snapshot and upsert payloads', () => {
  expect({
    snapshot: sessionUiEventSchema.parse({
      kind: 'snapshot',
      messageOutline: [{ id: 'msg_user00000000', text: 'Earlier question' }],
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
    }),
    upsert: sessionUiEventSchema.parse({
      kind: 'upsert',
      item: {
        kind: 'tool',
        id: 'tool_1',
        tool: 'search',
        status: 'running',
        seq: 'evt_100000000000'
      }
    })
  }).toEqual({
    snapshot: {
      kind: 'snapshot',
      messageOutline: [{ id: 'msg_user00000000', text: 'Earlier question' }],
      items: [
        {
          kind: 'message',
          id: 'msg_100000000000',
          role: 'assistant',
          parts: [{ type: 'text', text: 'hello' }],
          replyable: false,
          status: 'done',
          seq: 'msg_100000000000'
        }
      ]
    },
    upsert: {
      kind: 'upsert',
      item: {
        kind: 'tool',
        id: 'tool_1',
        tool: 'search',
        status: 'running',
        seq: 'evt_100000000000'
      }
    }
  });
});

test('mesh-agent system events preserve exact typed lifecycle variants', () => {
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
  const resumeFailed = {
    agentId: 'codex',
    agentName: 'Codex',
    type: 'resume_failed' as const,
    payload: { provider: 'codex', providerSessionRef: 'thread-old' }
  };
  const failed = {
    agentId: 'codex',
    agentName: 'Codex',
    type: 'failed' as const,
    payload: { meshSessionId: 'mesh_idle00000000', exitCode: 1 }
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
  const generic = sessionUiEventSchema.parse({
    kind: 'upsert',
    item: { kind: 'system', id: 'generic', text: 'System notice', seq: 'evt_0' }
  });

  expect(meshAgentSystemEventSchema.parse(suspended)).toEqual(suspended);
  expect(meshAgentSystemEventSchema.parse(resumed)).toEqual(resumed);
  expect(meshAgentSystemEventSchema.parse(resumeFailed)).toEqual(resumeFailed);
  expect(meshAgentSystemEventSchema.parse(failed)).toEqual(failed);
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
  expect(generic).toEqual({
    kind: 'upsert',
    item: { kind: 'system', id: 'generic', text: 'System notice', seq: 'evt_0' }
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
