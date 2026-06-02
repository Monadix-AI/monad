import type { UIMessageItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { viewItemFromUi } from '../../src/features/session/chat-view-items.ts';

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
    replyable: true,
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

test('message custom attachment parts project to exact transcript metadata', () => {
  const item = viewItemFromUi({
    ...message('user', 'Shared build output'),
    parts: [
      { type: 'text', text: 'Shared build output' },
      {
        type: 'custom',
        name: 'attachment',
        data: {
          id: 'att_123456789012',
          name: 'bundle.zip',
          mime: 'application/zip',
          bytes: 2048,
          createdAt: '2026-07-28T09:00:00.000Z'
        }
      }
    ]
  });

  expect(item).toEqual({
    id: 'msg_user',
    role: 'user',
    text: 'Shared build output',
    attachments: [
      {
        id: 'att_123456789012',
        name: 'bundle.zip',
        mime: 'application/zip',
        bytes: 2048,
        createdAt: '2026-07-28T09:00:00.000Z'
      }
    ],
    reasoning: undefined,
    error: false,
    replyToMessageId: undefined,
    replyable: true,
    streaming: false,
    seq: 'msg_user',
    type: undefined,
    data: undefined
  });
});

test('persisted image attachments project to the daemon download preview', () => {
  const item = viewItemFromUi({
    ...message('user', 'Use this image'),
    parts: [
      { type: 'text', text: 'Use this image' },
      {
        type: 'custom',
        name: 'attachment',
        data: {
          id: 'att_123456789012',
          name: 'diagram.png',
          mime: 'image/png',
          bytes: 3,
          createdAt: '2026-07-28T09:00:00.000Z',
          path: '/tmp/attachments/att_123456789012'
        }
      }
    ]
  });

  expect(item).toMatchObject({
    attachments: [
      {
        id: 'att_123456789012',
        imageSrc: '/v1/attachments/att_123456789012?download=1'
      }
    ]
  });
});
