import { expect, test } from 'bun:test';

import { listUiItemsResponseSchema, sessionUiEventSchema } from '../src/ui.ts';

test('sessionUiEventSchema accepts snapshot and upsert payloads', () => {
  expect(
    sessionUiEventSchema.parse({
      kind: 'snapshot',
      items: [
        {
          kind: 'message',
          id: 'msg_1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'hello' }],
          status: 'done',
          seq: 'msg_1'
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
        seq: 'evt_1'
      }
    }).kind
  ).toBe('upsert');
});

test('listUiItemsResponseSchema accepts mixed ui items', () => {
  const parsed = listUiItemsResponseSchema.parse({
    items: [
      {
        kind: 'message',
        id: 'msg_1',
        role: 'user',
        parts: [{ type: 'text', text: 'ping' }],
        seq: 'msg_1'
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
        seq: 'evt_1'
      },
      {
        kind: 'memory_summary',
        id: 'memory-summary:msg_1',
        summary: 'Earlier turns discussed setup and constraints.',
        uptoMessageId: 'msg_1',
        seq: 'msg_1'
      },
      {
        kind: 'custom',
        id: 'tsk_1',
        name: 'task.created',
        data: { taskId: 'tsk_1', title: 'Plan' },
        status: 'streaming',
        seq: 'evt_2'
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
        id: 'msg_1',
        role: 'assistant',
        parts: [{ type: 'custom', name: 'monad.directive', data: { command: '/model' } }],
        seq: 'evt_1'
      }
    }).kind
  ).toBe('upsert');

  expect(
    sessionUiEventSchema.parse({
      kind: 'remove',
      target: { kind: 'custom', id: 'tsk_1' }
    }).kind
  ).toBe('remove');

  expect(
    sessionUiEventSchema.parse({
      kind: 'remove',
      target: { kind: 'tool', id: 'call_1' }
    }).kind
  ).toBe('remove');
});
