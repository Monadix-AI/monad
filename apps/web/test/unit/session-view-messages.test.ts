import type { UIItem, UIMessageItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  branchSnapshotItems,
  isBranchSourceItem,
  isTransientAttentionUiItem,
  summaryTranscriptTurns
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

function loginRequired(id: string, agentName = 'pmem_claude-code_f2654d392ff2'): UIItem {
  return {
    kind: 'custom',
    id: `mesh-agent-login-required:${id}`,
    name: 'mesh.login_required',
    status: 'error',
    seq: `mesh-agent-login-required:${id}`,
    data: {
      agentName,
      authAgentName: 'claude-code',
      provider: 'claude-code',
      reason: 'Reconnect claude-code in Studio before using it in this project.'
    }
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

test('login-required cards stay visible while detached from the live tail', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [],
    transcriptMode: 'history',
    visibleHistory: [message('msg_older', 'assistant', 'older')],
    visibleLiveItems: [message('msg_live_tail', 'assistant', 'newer'), loginRequired('pmem_claude-code_f2654d392ff2')]
  });

  expect(items).toEqual([
    {
      id: 'msg_older',
      role: 'assistant',
      text: 'older',
      error: false,
      streaming: false,
      seq: 'msg_older',
      type: undefined,
      data: undefined,
      reasoning: undefined
    },
    {
      kind: 'mesh_agent_login',
      id: 'mesh-agent-login-required:pmem_claude-code_f2654d392ff2',
      agentName: 'pmem_claude-code_f2654d392ff2',
      authAgentName: 'claude-code',
      provider: 'claude-code',
      reason: 'Reconnect claude-code in Studio before using it in this project.',
      seq: 'mesh-agent-login-required:pmem_claude-code_f2654d392ff2'
    }
  ]);
});

test('login-required cards are transient attention items', () => {
  expect(isTransientAttentionUiItem(loginRequired('pmem_claude-code_da4d33333c9d'))).toBe(true);
  expect(isTransientAttentionUiItem(message('msg_user', 'user', 'hello'))).toBe(false);
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

test('historical matching text does not consume a new optimistic steer', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [{ id: 'local-steer-1', role: 'user', serverEchoOrdinal: 2, text: 'same text' }],
    transcriptMode: 'live',
    visibleHistory: [message('msg_historical', 'user', 'same text')],
    visibleLiveItems: []
  });

  expect(items.map((item) => item.id)).toEqual(['msg_historical', 'local-steer-1']);
});

test('a new matching server echo consumes its corresponding optimistic steer', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [
      { id: 'local-steer-1', role: 'user', serverEchoOrdinal: 2, text: 'same text' },
      { id: 'local-steer-2', role: 'user', serverEchoOrdinal: 3, text: 'same text' }
    ],
    transcriptMode: 'live',
    visibleHistory: [message('msg_historical', 'user', 'same text')],
    visibleLiveItems: [message('msg_echo', 'user', 'same text')]
  });

  expect(items.map((item) => item.id)).toEqual(['msg_historical', 'msg_echo', 'local-steer-2']);
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

test('optimistic steer messages stay after the active assistant and all running tools', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [
      { id: 'local-steer-1', role: 'user', text: 'adjust the answer' },
      { id: 'local-steer-2', role: 'user', text: 'keep it concise' }
    ],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: [
      streamingMessage('assistant-active', 'assistant', 'working'),
      {
        kind: 'tool',
        id: 'tool-active',
        tool: 'search',
        input: { query: 'current state' },
        status: 'running',
        seq: 'tool-active'
      }
    ]
  });

  expect(items.map((item) => item.id)).toEqual(['assistant-active', 'tool-active', 'local-steer-1', 'local-steer-2']);
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

test('branch source artifacts become a title-only transcript boundary', () => {
  const source: UIMessageItem = {
    id: 'msg_source',
    kind: 'message',
    parts: [
      {
        data: {
          sessionTitle: 'Original session'
        },
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
      sessionTitle: 'Original session'
    }
  ]);
  const item = items[0];
  if (!item || !isBranchSourceItem(item)) throw new Error('expected branch source item');
  expect(item.sessionTitle).toBe('Original session');
});

test('branch snapshot history is collapsed before the latest boundary by default', () => {
  const items = [
    { id: 'old-user', role: 'user' as const, text: 'old question' },
    { id: 'old-assistant', role: 'assistant' as const, text: 'old answer' },
    { id: 'source', kind: 'branch_source' as const, sessionTitle: 'Original session' },
    { id: 'new-user', role: 'user' as const, text: 'new question' }
  ];

  expect(branchSnapshotItems(items, false).map((item) => item.id)).toEqual(['source', 'new-user']);
  expect(branchSnapshotItems(items, true)).toEqual(items);
});

test('summary transcript keeps the branch boundary visible after a copied user message', () => {
  const items = [
    { id: 'old-user', role: 'user' as const, text: 'old question' },
    { id: 'source', kind: 'branch_source' as const, sessionTitle: 'Original session' }
  ];

  expect(summaryTranscriptTurns(items).map((item) => item.id)).toEqual(['old-user', 'source']);
});

test('summary transcript turns keep user and final assistant messages expanded', () => {
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

  expect(summaryTranscriptTurns(items)).toEqual([
    expect.objectContaining({ id: 'u1', role: 'user' }),
    {
      kind: 'summary_transcript_turn',
      id: 'summary-turn:a1',
      status: 'done',
      durationLabel: '1m12s',
      details: [expect.objectContaining({ id: 'a1', role: 'assistant' })]
    },
    expect.objectContaining({ id: 'a2', role: 'assistant', text: 'final answer' })
  ]);
});

test('summary transcript directives do not replace the final assistant message', () => {
  const items = buildViewMessages({
    commandPending: null,
    optimistic: [],
    transcriptMode: 'live',
    visibleHistory: [],
    visibleLiveItems: [
      message('u1', 'user', 'hello', '2026-07-15T00:00:00.000Z'),
      message('a1', 'assistant', 'final answer', '2026-07-15T00:00:05.000Z'),
      directive('d1', 'assistant', 'Observation view set to Summary.')
    ]
  });

  expect(summaryTranscriptTurns(items)).toEqual([
    expect.objectContaining({ id: 'u1', role: 'user' }),
    expect.objectContaining({ id: 'a1', role: 'assistant', text: 'final answer' }),
    expect.objectContaining({ id: 'd1', role: 'assistant', type: 'directive' })
  ]);
});

test('summary transcript turns keep streaming assistant messages expanded', () => {
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

  expect(summaryTranscriptTurns(items)).toEqual([
    expect.objectContaining({ id: 'u1', role: 'user' }),
    expect.objectContaining({ id: 'a1', role: 'assistant', streaming: true })
  ]);
});
