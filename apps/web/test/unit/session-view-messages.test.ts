import type { UIMessageItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  branchSourceHref,
  branchSourceSessionName,
  compactTranscriptTurns,
  isBranchSourceItem
} from '../../src/features/session/chat-view-items.ts';
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

function directive(id: string, role: UIMessageItem['role'], text: string): UIMessageItem {
  return {
    kind: 'message',
    id,
    role,
    parts: [{ type: 'artifact', messageType: 'directive', text }],
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

test('answered command directives render only their system reply', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: [
      directive('msg_command', 'user', '/model openrouter:gpt-5'),
      directive('msg_reply', 'assistant', 'Model set to openrouter:gpt-5.')
    ]
  });

  expect(items).toMatchObject([{ id: 'msg_reply', role: 'assistant', type: 'directive' }]);
});

test('answered command directives consume their optimistic command echo', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [{ id: 'local-command', role: 'user', text: '/model openrouter:gpt-5' }],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: [
      directive('msg_command', 'user', '/model openrouter:gpt-5'),
      directive('msg_reply', 'assistant', 'Model set to openrouter:gpt-5.')
    ]
  });

  expect(items).toMatchObject([{ id: 'msg_reply', role: 'assistant', type: 'directive' }]);
});

test('live text command echoes collapse when their assistant directive reply arrives', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: [
      message('msg_command', 'user', '/effort medium'),
      directive('msg_reply', 'assistant', 'Reasoning effort set to medium.')
    ]
  });

  expect(items).toMatchObject([{ id: 'msg_reply', role: 'assistant', type: 'directive' }]);
});

test('unanswered command directives remain visible until their reply arrives', () => {
  const items = buildViewMessages({
    commandPending: 'model',
    optimistic: [],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: [directive('msg_command', 'user', '/model openrouter:gpt-5')]
  });

  expect(items).toMatchObject([{ id: 'msg_command', role: 'user', type: 'directive' }]);
});

test('ordinary slash-prefixed messages are not collapsed with assistant messages', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: [message('msg_user', 'user', '/not-a-command'), message('msg_reply', 'assistant', 'response')]
  });

  expect(items.map((item) => item.id)).toEqual(['msg_user', 'msg_reply']);
});

test('branch source artifacts become a navigable transcript item', () => {
  const source: UIMessageItem = {
    id: 'msg_source',
    kind: 'message',
    parts: [
      {
        data: { messageId: 'msg_123456789012', sessionId: 'ses_123456789012' },
        messageType: 'branch_source',
        type: 'artifact'
      }
    ],
    role: 'assistant',
    seq: 'msg_source',
    status: 'done'
  };
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: [source]
  });

  expect(items).toEqual([
    {
      id: 'msg_source',
      kind: 'branch_source',
      messageId: 'msg_123456789012',
      sessionId: 'ses_123456789012'
    }
  ]);
  const item = items[0];
  if (!item || !isBranchSourceItem(item)) throw new Error('expected branch source item');
  expect(branchSourceHref(item)).toBe('/sessions/ses_123456789012?msg=msg_123456789012');
  expect(branchSourceSessionName(item, [{ id: 'ses_123456789012', title: 'Original session' }])).toBe(
    'Original session'
  );
  expect(branchSourceSessionName(item, [])).toBe('ses_123456789012');
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
