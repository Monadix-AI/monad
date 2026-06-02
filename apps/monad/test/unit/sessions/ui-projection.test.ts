import type { ChatMessage, Event, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { SessionUiProjector } from '@/handlers/session/ui-projection.ts';

const sessionId = 'ses_test' as SessionId;

function event(type: Event['type'], payload: Record<string, unknown>): Event {
  return { id: newId('evt'), sessionId, type, actorAgentId: null, payload, at: new Date().toISOString() };
}

test('hydrates persisted tool calls into one tool item', () => {
  const projector = new SessionUiProjector();
  const messages: ChatMessage[] = [
    {
      id: 'msg_tool_call',
      sessionId,
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
      sessionId,
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
      sessionId,
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
      sessionId,
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
  expect(snapshot.items).toEqual([]);
});

test('hydrates without model hallucinated tool calls', () => {
  const projector = new SessionUiProjector();
  const messages: ChatMessage[] = [
    {
      id: 'msg_tool_call',
      sessionId,
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
      sessionId,
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
  expect(snapshot.items).toEqual([]);
});

test('hydrates persisted raw terminal output after refresh', () => {
  const projector = new SessionUiProjector();
  const messages: ChatMessage[] = [
    {
      id: 'msg_tool_call',
      sessionId,
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
      sessionId,
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
      sessionId,
      role: 'user',
      text: 'old request',
      type: 'text',
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: 'msg_2',
      sessionId,
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

test('channel projector hydrates persisted structured assistant content as display text', () => {
  const projector = new SessionUiProjector({ channelStructured: true });
  const messages: ChatMessage[] = [
    {
      id: 'msg_structured',
      sessionId,
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

test('channel projector hides silent structured moderator replies', () => {
  const projector = new SessionUiProjector({ channelStructured: true });
  const messages: ChatMessage[] = [
    {
      id: 'msg_silent',
      sessionId,
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
  expect(snapshot.items).toEqual([]);

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

  expect(out).toEqual([]);
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items[0]).toMatchObject({
    kind: 'tool',
    id: nativeCliSessionId,
    output: 'started claude-code in /Users/zeke/Projects/monad',
    status: 'running'
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
      sessionId,
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
      sessionId,
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
  expect(full.hasMore).toBeUndefined();
});

test('snapshot omits oldestCursor when there are no messages', () => {
  const projector = new SessionUiProjector();
  projector.hydrateMessages([]);
  const snap = projector.snapshot({ hasMore: false });
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snap.oldestCursor).toBeUndefined();
  expect(snap.hasMore).toBeUndefined();
});
