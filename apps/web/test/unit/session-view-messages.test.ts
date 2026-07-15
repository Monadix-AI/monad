import type { UIMessageItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { compactTranscriptTurns } from '../../src/features/session/chat-view-items.ts';
import { buildViewMessages } from '../../src/features/session/session-view.ts';

function message(id: string, role: UIMessageItem['role'], text: string, seq = id): UIMessageItem {
  return {
    kind: 'message',
    id,
    role,
    parts: [{ type: 'text', text }],
    status: 'done',
    seq
  };
}

function streamingMessage(id: string, role: UIMessageItem['role'], text: string, seq = id): UIMessageItem {
  return {
    ...message(id, role, text, seq),
    status: 'streaming'
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

test('compact transcript turns keep only the final assistant output as summary', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: [
      message('u1', 'user', 'run it', '2026-07-15T00:00:00.000Z'),
      message('a1', 'assistant', 'draft', '2026-07-15T00:00:30.000Z'),
      message('a2', 'assistant', 'final answer', '2026-07-15T00:01:12.000Z')
    ]
  });

  expect(compactTranscriptTurns(items)).toMatchObject([
    {
      kind: 'compact_transcript_turn',
      status: 'done',
      durationLabel: '1m12s',
      summary: 'final answer',
      details: [{ id: 'u1' }, { id: 'a1' }, { id: 'a2' }]
    }
  ]);
});

test('compact transcript turns do not summarize streaming token previews', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: [
      message('u1', 'user', 'run it', '2026-07-15T00:00:00.000Z'),
      streamingMessage('a1', 'assistant', 'partial token preview', '2026-07-15T00:00:05.000Z')
    ]
  });

  expect(compactTranscriptTurns(items)).toMatchObject([
    {
      kind: 'compact_transcript_turn',
      status: 'running',
      durationLabel: '5s',
      details: [{ id: 'u1' }, { id: 'a1' }]
    }
  ]);
  expect(compactTranscriptTurns(items)[0]).not.toHaveProperty('summary');
});
