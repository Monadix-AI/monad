import type { UIMessageItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { buildViewMessages } from '../../src/features/session/session-view.ts';

function message(id: string, role: UIMessageItem['role'], text: string): UIMessageItem {
  return {
    kind: 'message',
    id,
    role,
    parts: [{ type: 'text', text }],
    status: 'done',
    seq: id
  };
}

test('optimistic user messages render immediately while detached from the live tail', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [{ id: 'local-1', role: 'user', text: 'hello now' }],
    transcriptMode: 'history',
    visibleHistory: [message('msg_older', 'assistant', 'older')],
    visibleLiveItems: []
  });

  expect(items.map((item) => item.id)).toEqual(['msg_older', 'local-1']);
});

test('server user echoes consume duplicate optimistic messages one at a time', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [
      { id: 'local-1', role: 'user', text: 'same text' },
      { id: 'local-2', role: 'user', text: 'same text' }
    ],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: [message('msg_server', 'user', 'same text')]
  });

  expect(items.map((item) => item.id)).toEqual(['msg_server', 'local-2']);
});

test('assistant activity messages stay ephemeral in the optimistic tail', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [
      { id: 'local-1', role: 'user', text: 'hello now' },
      { id: 'local-assistant-1', role: 'assistant', text: '', pending: true }
    ],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: []
  });

  expect(items).toMatchObject([
    { id: 'local-1', role: 'user', text: 'hello now' },
    { id: 'local-assistant-1', role: 'assistant', pending: true }
  ]);
});
