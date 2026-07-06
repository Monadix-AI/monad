import type { ChatMessage, Event, SessionId, UIItem } from '@monad/protocol';
import type { NativeCliSessionSnapshot } from '@/handlers/session/ui-projection.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { SessionUiProjector } from '@/handlers/session/ui-projection.ts';

const sessionId = 'ses_test' as SessionId;

function event(type: Event['type'], payload: Record<string, unknown>, at = new Date().toISOString()): Event {
  return {
    id: newId('evt'),
    transcriptTargetId: sessionId,
    type,
    actorAgentId: null,
    payload,
    at
  };
}

test('hydrates persisted tool calls into one tool item', () => {
  const projector = new SessionUiProjector();
  const messages: ChatMessage[] = [
    {
      id: 'msg_tool_call',
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: '',
      type: 'tool_call',
      data: { toolCallId: 'call_1', toolName: 'search', input: { q: 'monad' } },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: 'msg_tool_result',
      transcriptTargetId: sessionId,
      role: 'tool',
      text: 'ok',
      type: 'tool_result',
      data: { toolCallId: 'call_1', output: 'ok' },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:01.000Z'
    }
  ];

  projector.hydrateMessages(messages);
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items).toHaveLength(1);
  expect(snapshot.items[0]).toMatchObject({ kind: 'tool', id: 'call_1', status: 'ok', output: 'ok' });
});

test('projects display tool result when present', () => {
  const projector = new SessionUiProjector();
  projector.applyEvent(
    event('tool.called', { toolCallId: 'call_1', tool: 'shell_exec', input: { command: 'git status' } })
  );
  const events = projector.applyEvent(
    event('tool.result', {
      toolCallId: 'call_1',
      tool: 'shell_exec',
      ok: true,
      result: 'red plain',
      displayResult: '\x1B[31mred\x1B[0m plain'
    })
  );

  expect(events.at(-1)).toMatchObject({
    kind: 'upsert',
    item: { kind: 'tool', id: 'call_1', output: '\x1B[31mred\x1B[0m plain', status: 'ok' }
  });
});

test('projects structured tool display payloads for replay', () => {
  const projector = new SessionUiProjector();
  const display = {
    type: 'diff',
    path: '/tmp/a.txt',
    beforeText: 'old',
    afterText: 'new',
    diff: '--- a.txt\tBefore\n+++ a.txt\tAfter\n@@ -1 +1 @@\n-old\n+new\n'
  };
  projector.applyEvent(event('tool.called', { toolCallId: 'call_1', tool: 'fs_edit', input: { path: '/tmp/a.txt' } }));
  const events = projector.applyEvent(
    event('tool.result', {
      toolCallId: 'call_1',
      tool: 'fs_edit',
      ok: true,
      result: 'Modified file: /tmp/a.txt. 1 added, 1 removed.',
      display
    })
  );

  expect(events.at(-1)).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'tool',
      id: 'call_1',
      output: 'Modified file: /tmp/a.txt. 1 added, 1 removed.',
      display,
      status: 'ok'
    }
  });
});

test('hydrates structured tool display from persisted full result envelope', () => {
  const projector = new SessionUiProjector();
  const display = {
    type: 'diff',
    path: '/tmp/a.txt',
    beforeText: 'old',
    afterText: 'new',
    diff: '--- a.txt\tBefore\n+++ a.txt\tAfter\n@@ -1 +1 @@\n-old\n+new\n'
  };
  const messages: ChatMessage[] = [
    {
      id: 'msg_tool_call',
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: '',
      type: 'tool_call',
      data: { toolCallId: 'call_1', toolName: 'fs_edit', input: { path: '/tmp/a.txt' } },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: 'msg_tool_result',
      transcriptTargetId: sessionId,
      role: 'tool',
      text: 'Modified file: /tmp/a.txt. 1 added, 1 removed.',
      type: 'tool_result',
      data: {
        toolCallId: 'call_1',
        toolName: 'fs_edit',
        output: 'Modified file: /tmp/a.txt. 1 added, 1 removed.',
        ok: true,
        result: {
          modelContent: 'Modified file: /tmp/a.txt. 1 added, 1 removed.',
          displayContent: display,
          metadata: { changed: true }
        }
      },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:01.000Z'
    }
  ];

  projector.hydrateMessages(messages);
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items[0]).toMatchObject({
    kind: 'tool',
    id: 'call_1',
    output: 'Modified file: /tmp/a.txt. 1 added, 1 removed.',
    display,
    status: 'ok'
  });
});

test('removes model hallucinated tool calls from the UI stream', () => {
  const projector = new SessionUiProjector();
  projector.applyEvent(event('tool.called', { toolCallId: 'call_1', tool: 'missing_tool', input: { q: 'monad' } }));
  const [removed] = projector.applyEvent(
    event('tool.result', {
      toolCallId: 'call_1',
      tool: 'missing_tool',
      ok: false,
      result: 'unknown tool "missing_tool"'
    })
  );

  expect(removed).toEqual(expect.objectContaining({ kind: 'remove', target: { kind: 'tool', id: 'call_1' } }));
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
});

test('hydrates without model hallucinated tool calls', () => {
  const projector = new SessionUiProjector();
  const messages: ChatMessage[] = [
    {
      id: 'msg_tool_call',
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: '',
      type: 'tool_call',
      data: { toolCallId: 'call_1', toolName: 'missing_tool', input: { q: 'monad' } },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: 'msg_tool_result',
      transcriptTargetId: sessionId,
      role: 'tool',
      text: 'Error: unknown tool "missing_tool"',
      type: 'tool_result',
      data: { toolCallId: 'call_1', toolName: 'missing_tool', output: 'Error: unknown tool "missing_tool"', ok: false },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:01.000Z'
    }
  ];

  projector.hydrateMessages(messages);
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
});

test('hydrates persisted raw terminal output after refresh', () => {
  const projector = new SessionUiProjector();
  const messages: ChatMessage[] = [
    {
      id: 'msg_tool_call',
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: '',
      type: 'tool_call',
      data: { toolCallId: 'call_1', toolName: 'shell_exec', input: { command: 'git status' } },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: 'msg_tool_result',
      transcriptTargetId: sessionId,
      role: 'tool',
      text: 'red plain',
      type: 'tool_result',
      data: { toolCallId: 'call_1', toolName: 'shell_exec', output: '\x1B[31mred\x1B[0m plain', ok: true },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:01.000Z'
    }
  ];

  projector.hydrateMessages(messages);
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items[0]).toMatchObject({
    kind: 'tool',
    id: 'call_1',
    output: '\x1B[31mred\x1B[0m plain',
    status: 'ok'
  });
});

test('hydrates durable memory summary at the compaction boundary', () => {
  const projector = new SessionUiProjector();
  const messages: ChatMessage[] = [
    {
      id: 'msg_1',
      transcriptTargetId: sessionId,
      role: 'user',
      text: 'old request',
      type: 'text',
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: 'msg_2',
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: 'recent answer',
      type: 'text',
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:01.000Z'
    }
  ];

  projector.hydrateMessages(messages, { summary: 'Earlier turns covered setup.', uptoMessageId: 'msg_1' });
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items.map((item) => item.kind)).toEqual(['message', 'memory_summary', 'message']);
  expect(snapshot.items[1]).toMatchObject({
    kind: 'memory_summary',
    summary: 'Earlier turns covered setup.',
    uptoMessageId: 'msg_1'
  });
});

test('streams reasoning and text onto the same message item', () => {
  const projector = new SessionUiProjector();
  projector.applyEvent(event('agent.reasoning', { messageId: 'msg_1', delta: 'think', index: 0 }));
  projector.applyEvent(event('agent.token', { messageId: 'msg_1', delta: 'hello', index: 0 }));
  const [final] = projector.applyEvent(event('agent.message', { messageId: 'msg_1', text: 'hello' }));
  if (final?.kind !== 'upsert' || final.item.kind !== 'message') throw new Error('expected message upsert');
  expect(final.item.parts).toEqual([
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'hello' }
  ]);
  expect(final.item.status).toBe('done');
});

test('accumulates streamed text deltas across tokens (non-channel session)', () => {
  const projector = new SessionUiProjector();
  projector.applyEvent(event('agent.token', { messageId: 'msg_1', delta: 'Hello', index: 0 }));
  const [second] = projector.applyEvent(event('agent.token', { messageId: 'msg_1', delta: ' world', index: 1 }));
  if (second?.kind !== 'upsert' || second.item.kind !== 'message') throw new Error('expected message upsert');
  expect(second.item.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  expect(second.item.status).toBe('streaming');

  const [third] = projector.applyEvent(event('agent.token', { messageId: 'msg_1', delta: '!', index: 2 }));
  if (third?.kind !== 'upsert' || third.item.kind !== 'message') throw new Error('expected message upsert');
  expect(third.item.parts).toEqual([{ type: 'text', text: 'Hello world!' }]);
});

test('clears accumulated streaming text after the message settles', () => {
  const projector = new SessionUiProjector();
  projector.applyEvent(event('agent.token', { messageId: 'msg_1', delta: 'draft', index: 0 }));
  projector.applyEvent(event('agent.message', { messageId: 'msg_1', text: 'final' }));
  // A reused messageId must not resume from the prior message's accumulated buffer.
  const [restart] = projector.applyEvent(event('agent.token', { messageId: 'msg_1', delta: 'fresh', index: 0 }));
  if (restart?.kind !== 'upsert' || restart.item.kind !== 'message') throw new Error('expected message upsert');
  expect(restart.item.parts).toEqual([{ type: 'text', text: 'fresh' }]);
});

test('reasoning deltas preserve the streaming message agent name', () => {
  const projector = new SessionUiProjector();
  projector.applyEvent(event('agent.token', { messageId: 'msg_1', agentName: 'codex', delta: '', index: 0 }));
  const [reasoning] = projector.applyEvent(
    event('agent.reasoning', { messageId: 'msg_1', delta: 'Thinking', index: 0 })
  );

  expect(reasoning).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'message',
      id: 'msg_1',
      role: 'assistant',
      agentName: 'codex',
      status: 'streaming',
      parts: [
        { type: 'reasoning', text: 'Thinking' },
        { type: 'text', text: '' }
      ]
    }
  });
});

test('hydrates a persisted managed native CLI thinking message after refresh', () => {
  const projector = new SessionUiProjector();
  projector.hydrateMessages([
    {
      id: 'msg_thinking',
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: '',
      type: 'text',
      data: { agentName: 'pmem_codex_reviewer', source: 'managed-native-cli', reasoning: 'Thinking' },
      stream: { status: 'streaming' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    }
  ]);

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items).toEqual([
    expect.objectContaining({
      kind: 'message',
      id: 'msg_thinking',
      agentName: 'pmem_codex_reviewer',
      source: 'managed-native-cli',
      status: 'streaming',
      parts: [{ type: 'reasoning', text: 'Thinking' }]
    })
  ]);
});

test('hydrates native CLI provider errors without breaking the UI stream', () => {
  const projector = new SessionUiProjector();
  projector.hydrateMessages([
    {
      id: 'msg_provider_error',
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: 'thread not found: 019f30a7-ddaf-7062-9f89-f3fd90b5397c',
      type: 'error',
      data: {
        agentName: 'pmem_codex_reviewer',
        nativeCliSessionId: 'ncli_provider_error',
        deliveryId: 'deliv_provider_error',
        source: 'native-cli-provider'
      },
      stream: { status: 'settled' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    }
  ]);

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items).toEqual([
    expect.objectContaining({
      kind: 'message',
      id: 'msg_provider_error',
      agentName: 'pmem_codex_reviewer',
      source: 'native-cli-provider',
      nativeCliSessionId: 'ncli_provider_error',
      deliveryId: 'deliv_provider_error',
      status: 'error',
      parts: [{ type: 'text', text: 'thread not found: 019f30a7-ddaf-7062-9f89-f3fd90b5397c' }]
    })
  ]);
});

test('managed native CLI completion moves live order to completion time', () => {
  const projector = new SessionUiProjector();
  const startedAt = '2026-06-24T00:00:01.000Z';
  const completedAt = '2026-06-24T00:00:09.000Z';
  projector.applyEvent(
    event(
      'agent.token',
      { messageId: 'msg_CLI', agentName: 'codex', delta: '', index: 0, source: 'managed-native-cli' },
      startedAt
    )
  );
  projector.applyEvent(
    event(
      'agent.message',
      { messageId: 'msg_CLI', agentName: 'codex', text: 'done', source: 'managed-native-cli' },
      completedAt
    )
  );

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items).toEqual([
    expect.objectContaining({
      kind: 'message',
      id: 'msg_CLI',
      status: 'done',
      seq: completedAt
    })
  ]);
});

test('managed native CLI message projections retain delivery observation pointers', () => {
  const deliveryId = newId('deliv');
  const live = new SessionUiProjector();
  live.applyEvent(
    event('agent.token', {
      messageId: 'msg_CLI',
      agentName: 'codex',
      nativeCliSessionId: 'ncli_codex',
      deliveryId,
      delta: '',
      index: 0,
      source: 'managed-native-cli'
    })
  );
  const [settled] = live.applyEvent(
    event('agent.message', {
      messageId: 'msg_CLI',
      agentName: 'codex',
      nativeCliSessionId: 'ncli_codex',
      deliveryId,
      text: 'done',
      source: 'managed-native-cli'
    })
  );

  expect(settled?.kind === 'upsert' && settled.item.kind === 'message' ? settled.item : undefined).toMatchObject({
    nativeCliSessionId: 'ncli_codex',
    deliveryId
  });

  const hydrated = new SessionUiProjector();
  hydrated.hydrateMessages([
    {
      id: 'msg_CLI',
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: 'done',
      type: 'text',
      data: {
        agentName: 'codex',
        nativeCliSessionId: 'ncli_codex',
        deliveryId,
        source: 'managed-native-cli'
      },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    }
  ]);
  const snapshot = hydrated.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items[0]).toMatchObject({
    kind: 'message',
    nativeCliSessionId: 'ncli_codex',
    deliveryId
  });
});

test('live user messages keep chronological order before later managed native CLI replies', () => {
  const projector = new SessionUiProjector();
  projector.applyEvent(event('user.message', { messageId: 'msg_USER', text: 'hi all' }, '2026-06-24T10:00:00.000Z'));
  projector.applyEvent(
    event(
      'agent.token',
      { messageId: 'msg_CLI', agentName: 'claude', delta: '', index: 0, source: 'managed-native-cli' },
      '2026-06-24T10:00:01.000Z'
    )
  );
  projector.applyEvent(
    event(
      'agent.message',
      { messageId: 'msg_CLI', agentName: 'claude', text: 'I can take this.', source: 'managed-native-cli' },
      '2026-06-24T10:00:02.000Z'
    )
  );

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items.map((item) => item.id)).toEqual(['msg_USER', 'msg_CLI']);
});

test('channel projector streams only structured display content', () => {
  const projector = new SessionUiProjector({ channelStructured: true });
  const first = projector.applyEvent(
    event('agent.token', {
      messageId: 'msg_1',
      delta: '{"display":{"kind":"markdown","content":"visible',
      index: 0
    })
  );
  const firstItem = first.at(-1);
  const firstText =
    firstItem?.kind === 'upsert' && firstItem.item.kind === 'message' && firstItem.item.parts[0]?.type === 'text'
      ? firstItem.item.parts[0].text
      : undefined;
  const second = projector.applyEvent(
    event('agent.token', {
      messageId: 'msg_1',
      delta: ' update"},"attachments":[],"next":[]}',
      index: 1
    })
  );
  const [final] = projector.applyEvent(
    event('agent.message', {
      messageId: 'msg_1',
      text: '{"display":{"kind":"markdown","content":"visible update"},"attachments":[{"kind":"note","text":"metadata"}],"next":[]}'
    })
  );

  expect(firstText).toBe('visible');
  expect(second.at(-1)).toMatchObject({
    kind: 'upsert',
    item: { kind: 'message', parts: [{ type: 'text', text: 'visible update' }], status: 'streaming' }
  });
  expect(final).toMatchObject({
    kind: 'upsert',
    item: { kind: 'message', parts: [{ type: 'text', text: 'visible update' }], status: 'done' }
  });
});

test('channel projector parses fenced partial structured content', () => {
  const projector = new SessionUiProjector({ channelStructured: true });
  const first = projector.applyEvent(
    event('agent.token', {
      messageId: 'msg_1',
      delta: '```json\n{"display":{"kind":"markdown","content":"fenced',
      index: 0
    })
  );
  const firstItem = first.at(-1);
  const firstText =
    firstItem?.kind === 'upsert' && firstItem.item.kind === 'message' && firstItem.item.parts[0]?.type === 'text'
      ? firstItem.item.parts[0].text
      : undefined;

  expect(firstText).toBe('fenced');
});

test('channel projector hides a silent reply mid-stream before the JSON closes', () => {
  const projector = new SessionUiProjector({ channelStructured: true });
  const out = projector.applyEvent(
    event('agent.token', {
      messageId: 'msg_1',
      delta: '{"visibility":"silent","display":{"kind":"markdown","content":"secret',
      index: 0
    })
  );
  const item = out.at(-1);
  const text =
    item?.kind === 'upsert' && item.item.kind === 'message' && item.item.parts[0]?.type === 'text'
      ? item.item.parts[0].text
      : undefined;
  expect(text).toBe('');
});

test('channel projector throttles re-parse across small tokens yet stays correct at boundaries', () => {
  const projector = new SessionUiProjector({ channelStructured: true });
  const textOf = (events: ReturnType<SessionUiProjector['applyEvent']>): string | undefined => {
    const item = events.at(-1);
    return item?.kind === 'upsert' && item.item.kind === 'message' && item.item.parts[0]?.type === 'text'
      ? item.item.parts[0].text
      : undefined;
  };
  // Opening + first content parses (no cache yet).
  textOf(
    projector.applyEvent(event('agent.token', { messageId: 'msg_1', delta: '{"display":{"content":"a', index: 0 }))
  );
  // Several tiny content tokens (each < 32 chars, no `}`) — these reuse the cached parse.
  for (let i = 1; i <= 5; i++) {
    textOf(projector.applyEvent(event('agent.token', { messageId: 'msg_1', delta: 'b', index: i })));
  }
  // A delta carrying `}` (structural close) forces a re-parse: the full content is now rendered.
  const closed = textOf(
    projector.applyEvent(event('agent.token', { messageId: 'msg_1', delta: 'c"},"next":[]}', index: 6 }))
  );
  expect(closed).toBe('abbbbbc');
});

test('channel projector hydrates persisted structured assistant content as display text', () => {
  const projector = new SessionUiProjector({ channelStructured: true });
  const messages: ChatMessage[] = [
    {
      id: 'msg_structured',
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: JSON.stringify({
        display: { kind: 'markdown', content: 'visible host reply' },
        attachments: [],
        next: [{ agentId: 'acp:codex', prompt: 'continue' }]
      }),
      type: 'text',
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    }
  ];

  projector.hydrateMessages(messages);
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items[0]).toMatchObject({
    kind: 'message',
    parts: [{ type: 'text', text: 'visible host reply' }]
  });
});

test('channel projector hides silent structured channel replies', () => {
  const projector = new SessionUiProjector({ channelStructured: true });
  const messages: ChatMessage[] = [
    {
      id: 'msg_silent',
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: JSON.stringify({
        visibility: 'silent',
        display: { kind: 'markdown', content: '' },
        attachments: [],
        next: [{ agentId: 'acp:codex', prompt: 'continue' }]
      }),
      type: 'text',
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    }
  ];

  projector.hydrateMessages(messages);
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');

  const liveMessageId = newId('msg');
  projector.applyEvent(
    event('agent.token', {
      messageId: liveMessageId,
      delta: '{"visibility":"silent","display":{"kind":"markdown","content":""},"attachments":[],"next":[]}',
      index: 0
    })
  );
  const [final] = projector.applyEvent(
    event('agent.message', {
      messageId: liveMessageId,
      text: '{"visibility":"silent","display":{"kind":"markdown","content":""},"attachments":[],"next":[]}'
    })
  );
  expect(final).toMatchObject({ kind: 'remove', target: { kind: 'message', id: liveMessageId } });
});

test('projects command directive events with effect data', () => {
  const projector = new SessionUiProjector();
  const messageId = newId('msg');
  const [final] = projector.applyEvent(
    event('agent.message', {
      messageId,
      text: 'Context compacted.',
      data: { effect: { type: 'compacted', compacted: 3, summary: 'Earlier context.' } }
    })
  );
  if (final?.kind !== 'upsert' || final.item.kind !== 'message') throw new Error('expected message upsert');
  expect(final.item.parts).toEqual([
    {
      type: 'artifact',
      messageType: 'directive',
      text: 'Context compacted.',
      data: { effect: { type: 'compacted', compacted: 3, summary: 'Earlier context.' } }
    }
  ]);
});

test('adds and removes approval items', () => {
  const projector = new SessionUiProjector();
  const [added] = projector.applyEvent(
    event('tool.approval_requested', { requestId: 'req_1', tool: 'browser', input: {}, key: 'host-control' })
  );
  expect(added).toMatchObject({ kind: 'upsert', item: { kind: 'approval', id: 'req_1' } });
  const [removed] = projector.applyEvent(
    event('tool.approval_resolved', { requestId: 'req_1', tool: 'browser', allow: true })
  );
  expect(removed).toEqual(expect.objectContaining({ kind: 'remove', target: { kind: 'approval', id: 'req_1' } }));
});

test('projects structured clarification requests for composer questions', () => {
  const projector = new SessionUiProjector();
  const [added] = projector.applyEvent(
    event('clarify.requested', {
      requestId: 'clarify_1',
      question: 'Which direction should I take?',
      options: ['Ship it', 'Revise it'],
      mode: 'single',
      allowOther: true,
      asker: { id: 'pmem_codex_1', name: 'Lily' }
    })
  );

  expect(added).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'clarification',
      id: 'clarify_1',
      question: 'Which direction should I take?',
      options: ['Ship it', 'Revise it'],
      mode: 'single',
      allowOther: true,
      asker: { id: 'pmem_codex_1', name: 'Lily' }
    }
  });

  const [removed] = projector.applyEvent(event('clarify.resolved', { requestId: 'clarify_1', answer: 'Ship it' }));
  expect(removed).toEqual(
    expect.objectContaining({ kind: 'remove', target: { kind: 'clarification', id: 'clarify_1' } })
  );
});

test('keeps tool progress on the standard tool item', () => {
  const projector = new SessionUiProjector();
  projector.applyEvent(event('tool.called', { toolCallId: 'call_1', tool: 'shell', input: { cmd: 'bun test' } }));
  const [progress] = projector.applyEvent(
    event('tool.progress', { toolCallId: 'call_1', tool: 'shell', output: 'running' })
  );
  if (progress?.kind !== 'upsert' || progress.item.kind !== 'tool') throw new Error('expected tool upsert');
  expect(progress.item).toMatchObject({ id: 'call_1', tool: 'shell', status: 'running', output: 'running' });
});

test('does not project raw native CLI PTY output into chat tool text', () => {
  const projector = new SessionUiProjector();
  const nativeCliSessionId = 'ncli_1';
  projector.applyEvent(
    event('native_cli.started', {
      nativeCliSessionId,
      agentName: 'claude-code',
      provider: 'claude-code',
      launchMode: 'pty',
      workingPath: '/Users/zeke/Projects/monad',
      pid: 123
    })
  );

  const out = projector.applyEvent(
    event('native_cli.output', {
      nativeCliSessionId,
      stream: 'pty',
      chunk: '\u001b[?25l\u001b[38;2;255;193;7mNew MCP server found\u001b[39m'
    })
  );

  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'tool',
      id: nativeCliSessionId,
      output: '\u001b[?25l\u001b[38;2;255;193;7mNew MCP server found\u001b[39m'
    }
  });
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items[0]).toMatchObject({
    kind: 'tool',
    id: nativeCliSessionId,
    output: '\u001b[?25l\u001b[38;2;255;193;7mNew MCP server found\u001b[39m',
    status: 'running'
  });
});

test('projects native CLI provider-owned approvals as distinct approval items', () => {
  const projector = new SessionUiProjector();
  const [approval] = projector.applyEvent(
    event('native_cli.approval_requested', {
      nativeCliSessionId: 'ncli_gemini',
      provider: 'gemini',
      requestId: 'gemini:folder-trust',
      text: 'trust this Gemini project folder',
      data: {
        requestId: 'gemini:folder-trust',
        kind: 'folder_trust',
        action: 'trust this Gemini project folder'
      }
    })
  );

  expect(approval).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'approval',
      id: 'gemini:folder-trust',
      tool: 'gemini approval',
      input: {
        nativeCliSessionId: 'ncli_gemini',
        provider: 'gemini',
        text: 'trust this Gemini project folder',
        approvalOwnership: 'provider-owned'
      },
      key: 'provider-owned:gemini'
    }
  });
});

test('projects native CLI reconnect requirements as visible custom items', () => {
  const projector = new SessionUiProjector();
  const [connection] = projector.applyEvent(
    event('native_cli.connection_required', {
      nativeCliSessionId: 'ncli_gemini',
      agentName: 'gemini',
      provider: 'gemini',
      code: 'provider_connection_required',
      reason: 'Gemini CLI is waiting for provider authentication to complete.',
      reconnectIn: 'studio'
    })
  );

  expect(connection).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'custom',
      id: 'native-cli-connection-required:ncli_gemini',
      name: 'native_cli.connection_required',
      status: 'error',
      data: {
        nativeCliSessionId: 'ncli_gemini',
        agentName: 'gemini',
        provider: 'gemini',
        code: 'provider_connection_required',
        reason: 'Gemini CLI is waiting for provider authentication to complete.',
        reconnectIn: 'studio'
      }
    }
  });
});

test('projects unsupported ui events as custom extension items', () => {
  const projector = new SessionUiProjector();
  const [task] = projector.applyEvent(
    event('task.created', { taskId: 'tsk_1', title: 'Plan migration', assigneeAgentId: null })
  );
  if (task?.kind !== 'upsert' || task.item.kind !== 'custom') throw new Error('expected custom upsert');
  expect(task.item).toMatchObject({
    kind: 'custom',
    id: 'tsk_1',
    name: 'task.created',
    status: 'streaming',
    data: { taskId: 'tsk_1', title: 'Plan migration', assigneeAgentId: null }
  });
});

test('reset session update clears projected items', () => {
  const projector = new SessionUiProjector();
  projector.applyEvent(event('user.message', { messageId: 'msg_1', text: 'hello' }));
  const [snapshot] = projector.applyEvent(event('session.updated', { reset: true }));
  expect(snapshot).toEqual(
    expect.objectContaining({
      kind: 'snapshot',
      items: []
    })
  );
});

test('snapshot emits oldestCursor (oldest raw message id) and hasMore when bounded', () => {
  const projector = new SessionUiProjector();
  const m0 = newId('msg');
  const m1 = newId('msg');
  const messages: ChatMessage[] = [
    {
      id: m0,
      transcriptTargetId: sessionId,
      role: 'user',
      text: 'first',
      type: 'text',
      data: null,
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: m1,
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: 'second',
      type: 'text',
      data: null,
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:01.000Z'
    }
  ];
  projector.hydrateMessages(messages);

  const bounded = projector.snapshot({ hasMore: true });
  if (bounded.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(bounded.oldestCursor).toBe(m0);
  expect(bounded.hasMore).toBe(true);

  // Without hasMore the flag is omitted, but oldestCursor still reflects the window.
  const full = projector.snapshot();
  if (full.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(full.oldestCursor).toBe(m0);
});

test('snapshot omits oldestCursor when there are no messages', () => {
  const projector = new SessionUiProjector();
  projector.hydrateMessages([]);
  const snap = projector.snapshot({ hasMore: false });
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
});

function cliSession(overrides: Partial<NativeCliSessionSnapshot> = {}): NativeCliSessionSnapshot {
  return {
    id: 'ncli_1',
    provider: 'codex',
    agentName: 'codex',
    workingPath: '/w',
    launchMode: 'app-server',
    state: 'running',
    exitCode: null,
    outputSnapshot: 'line one\nline two',
    startedAt: '2026-06-24T00:00:00.500Z',
    ...overrides
  };
}

test('hydrateNativeCliSessions rebuilds a running tool card from the output snapshot', () => {
  const projector = new SessionUiProjector();
  projector.hydrateNativeCliSessions([cliSession()]);
  const snap = projector.snapshot();
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snap.items).toHaveLength(1);
  expect(snap.items[0]).toMatchObject({
    kind: 'tool',
    id: 'ncli_1',
    tool: 'native-cli:codex',
    status: 'running',
    output: 'line one\nline two',
    input: { agent: 'codex', provider: 'codex', launchMode: 'app-server' }
  });
});

test('hydrateNativeCliSessions maps terminal state and appends the exit line', () => {
  const failed = new SessionUiProjector();
  failed.hydrateNativeCliSessions([cliSession({ id: 'ncli_f', state: 'failed', exitCode: 1 })]);
  const fSnap = failed.snapshot();
  if (fSnap.kind !== 'snapshot' || fSnap.items[0]?.kind !== 'tool') throw new Error('expected tool');
  expect(fSnap.items[0].status).toBe('error');
  expect(fSnap.items[0].output).toContain('\nfailed (1)');

  const exited = new SessionUiProjector();
  exited.hydrateNativeCliSessions([cliSession({ id: 'ncli_e', state: 'exited', exitCode: 0 })]);
  const eSnap = exited.snapshot();
  if (eSnap.kind !== 'snapshot' || eSnap.items[0]?.kind !== 'tool') throw new Error('expected tool');
  expect(eSnap.items[0].status).toBe('ok');
  expect(eSnap.items[0].output).toContain('\nexited (0)');
});

test('hydrateNativeCliSessions interleaves cards with messages by startedAt', () => {
  const projector = new SessionUiProjector();
  const mkMsg = (id: `msg_${string}`, at: string): ChatMessage => ({
    id,
    transcriptTargetId: sessionId,
    role: 'user',
    text: id,
    type: 'text',
    stream: { status: 'complete' },
    active: true,
    createdAt: at
  });
  // Messages at 00:00 and 00:01; a CLI run started at 00:00:00.500 must land between them.
  projector.hydrateMessages([mkMsg('msg_a', '2026-06-24T00:00:00.000Z'), mkMsg('msg_b', '2026-06-24T00:00:01.000Z')]);
  projector.hydrateNativeCliSessions([cliSession()]);
  const snap = projector.snapshot();
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snap.items.map((i) => i.id)).toEqual(['msg_a', 'ncli_1', 'msg_b']);
});

test('hydrateNativeCliSessions updates an existing card in place without duplicating', () => {
  const projector = new SessionUiProjector();
  projector.hydrateNativeCliSessions([cliSession({ outputSnapshot: 'first' })]);
  projector.hydrateNativeCliSessions([cliSession({ outputSnapshot: 'second', state: 'stopped' })]);
  const snap = projector.snapshot();
  if (snap.kind !== 'snapshot' || snap.items[0]?.kind !== 'tool') throw new Error('expected tool');
  expect(snap.items).toHaveLength(1);
  expect(snap.items[0].output).toContain('second');
  expect(snap.items[0].output).not.toContain('first');
  expect(snap.items[0].status).toBe('ok');
});

test('live streaming evicts oldest settled items past the cap but keeps active and pending ones', () => {
  const projector = new SessionUiProjector();
  projector.hydrateMessages([]);
  projector.snapshot(); // commit the initial view → enable live eviction
  // A pending approval and a still-streaming assistant message, both inserted early.
  projector.applyEvent(event('tool.approval_requested', { requestId: 'req_1', tool: 'shell_exec', input: {} }));
  projector.applyEvent(event('agent.token', { messageId: 'msg_LIVE', delta: 'streaming', index: 0 }));
  // Flood with settled user messages well past MAX_LIVE_UI_ITEMS (1000).
  for (let i = 0; i < 1100; i++) {
    projector.applyEvent(event('user.message', { messageId: `msg_${i}`, text: `m${i}` }));
  }
  const snap = projector.snapshot();
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snap.items.length).toBeLessThanOrEqual(1000);
  // Never-evictable items survive despite being the oldest.
  expect(snap.items.some((i) => i.kind === 'approval' && i.id === 'req_1')).toBe(true);
  expect(snap.items.some((i) => i.kind === 'message' && i.id === 'msg_LIVE' && i.status === 'streaming')).toBe(true);
  // Oldest settled messages were dropped; the newest remain.
  expect(snap.items.some((i) => i.id === 'msg_0')).toBe(false);
  expect(snap.items.some((i) => i.id === 'msg_1099')).toBe(true);
});

// What the user actually sees is the projected item sequence, so these assert order + content across
// the realistic multi-agent flows: concurrent streaming, an agent joining, and a reply hitting the wall.
function messageView(item: UIItem): { role?: string; agent?: string; text?: string; status?: string } | string {
  if (item.kind !== 'message') return `${item.kind}:${item.id}`;
  const text = item.parts.find((p) => p.type === 'text');
  return {
    role: item.role,
    agent: item.agentName,
    text: text?.type === 'text' ? text.text : undefined,
    status: item.status
  };
}

test('two agents streaming concurrently keep per-bubble order and content (no cross-contamination)', () => {
  const p = new SessionUiProjector();
  p.applyEvent(event('user.message', { messageId: 'msg_U', text: 'review please' }));
  // codex and claude stream at the same time, tokens interleaved; claude settles before codex.
  p.applyEvent(event('agent.token', { messageId: 'msg_A', agentName: 'codex', delta: 'Look', index: 0 }));
  p.applyEvent(event('agent.token', { messageId: 'msg_B', agentName: 'claude', delta: 'I dis', index: 0 }));
  p.applyEvent(event('agent.token', { messageId: 'msg_A', agentName: 'codex', delta: 'ing', index: 1 }));
  p.applyEvent(event('agent.token', { messageId: 'msg_B', agentName: 'claude', delta: 'agree', index: 1 }));
  p.applyEvent(event('agent.message', { messageId: 'msg_B', agentName: 'claude', text: 'I disagree' }));
  p.applyEvent(event('agent.message', { messageId: 'msg_A', agentName: 'codex', text: 'Looking good' }));
  const snap = p.snapshot();
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
  // Order is by first appearance (U, then A, then B) regardless of which settles first; text is the
  // settled content per agent — never mixed.
  expect(snap.items.map(messageView)).toEqual([
    { role: 'user', agent: undefined, text: 'review please', status: 'done' },
    { role: 'assistant', agent: 'codex', text: 'Looking good', status: 'done' },
    { role: 'assistant', agent: 'claude', text: 'I disagree', status: 'done' }
  ]);
});

test('agent join, its output card, and its wall reply project in chronological order', () => {
  const p = new SessionUiProjector();
  p.applyEvent(event('user.message', { messageId: 'msg_U', text: 'please review' }));
  p.applyEvent(
    event('native_cli.started', {
      nativeCliSessionId: 'ncli_1',
      agentName: 'codex',
      provider: 'codex',
      launchMode: 'pty',
      workingPath: '/w',
      pid: 123
    })
  );
  p.applyEvent(event('native_cli.output', { nativeCliSessionId: 'ncli_1', stream: 'stdout', chunk: 'analyzing repo' }));
  // The reply reaching the wall: a Thinking placeholder that settles into the posted text.
  p.applyEvent(
    event('agent.token', { messageId: 'msg_R', agentName: 'codex', delta: '', index: 0, source: 'managed-native-cli' })
  );
  p.applyEvent(
    event('agent.reasoning', { messageId: 'msg_R', delta: 'Thinking', index: 0, source: 'managed-native-cli' })
  );
  p.applyEvent(
    event('agent.message', {
      messageId: 'msg_R',
      agentName: 'codex',
      text: 'looks good to me',
      source: 'managed-native-cli'
    })
  );
  const snap = p.snapshot();
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snap.items.map((i) => `${i.kind}:${i.id}`)).toEqual(['message:msg_U', 'tool:ncli_1', 'message:msg_R']);
  const card = snap.items.find((i) => i.kind === 'tool');
  if (card?.kind !== 'tool') throw new Error('expected tool card');
  expect(card.tool).toBe('native-cli:codex');
  const reply = snap.items.find((i) => i.id === 'msg_R');
  if (reply?.kind !== 'message') throw new Error('expected reply message');
  expect(reply.status).toBe('done');
  expect(
    reply.parts.find((x) => x.type === 'text')?.type === 'text' && reply.parts.find((x) => x.type === 'text')
  ).toMatchObject({ text: 'looks good to me' });
});
