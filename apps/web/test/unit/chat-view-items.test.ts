import type { UIMessageItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { viewItemFromUi } from '../../features/session/chat-view-items.ts';

const structuredText = JSON.stringify({
  display: { kind: 'markdown', content: 'Rendered answer' },
  attachments: [{ id: 'a1', kind: 'link', name: 'Source', url: 'https://example.com' }],
  next: [{ agentId: 'acp:codex', prompt: 'follow up' }]
});

function message(role: UIMessageItem['role'], text: string): UIMessageItem {
  return {
    kind: 'message',
    id: `msg_${role}`,
    role,
    parts: [{ type: 'text', text }],
    status: 'done',
    seq: `msg_${role}`
  };
}

test('assistant channel structured responses render as display text in transcripts', () => {
  const item = viewItemFromUi(message('assistant', structuredText));

  expect(item).toMatchObject({
    role: 'assistant',
    text: 'Rendered answer'
  });
});

test('user messages are not parsed as channel structured responses', () => {
  const item = viewItemFromUi(message('user', structuredText));

  expect(item).toMatchObject({
    role: 'user',
    text: structuredText
  });
});
