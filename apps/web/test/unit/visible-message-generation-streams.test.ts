import type { UIItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { streamingMessageIds } from '../../src/features/workplace/VisibleMessageGenerationStreams.tsx';

test('selects only distinct canonical message ids that are still streaming', () => {
  const items: UIItem[] = [
    {
      kind: 'message',
      id: 'msg_100000000001',
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial' }],
      status: 'streaming',
      seq: '1'
    },
    {
      kind: 'message',
      id: 'msg_100000000002',
      role: 'assistant',
      parts: [{ type: 'text', text: 'done' }],
      status: 'done',
      seq: '2'
    },
    {
      kind: 'message',
      id: 'not-a-message-id',
      role: 'assistant',
      parts: [{ type: 'text', text: 'provider-only projection' }],
      status: 'streaming',
      seq: '3'
    },
    {
      kind: 'message',
      id: 'msg_100000000001',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: 'same message, later projection' }],
      status: 'streaming',
      seq: '4'
    },
    { kind: 'tool', id: 'tool-1', tool: 'read', status: 'running', seq: '5' }
  ];

  expect(streamingMessageIds(items)).toEqual(['msg_100000000001']);
});
