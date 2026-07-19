import type { ChatMessage, Event, MessageProducer, SessionId, UIItem } from '@monad/protocol';
import type { ExternalAgentSessionSnapshot } from '#/handlers/session/ui-projection.ts';

import { expect, test } from 'bun:test';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';
import { createI18n } from '@monad/i18n';
import { newId } from '@monad/protocol';

import { SessionUiProjector } from '#/handlers/session/ui-projection.ts';
import { registerAgentAdapterImpl } from '#/services/external-agent/index.ts';

const sessionId = 'ses_test00000000' as SessionId;
const agentProducer = { kind: 'agent', agentId: 'agt_test00000000' } satisfies MessageProducer;

for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

function event(type: Event['type'], payload: Record<string, unknown>, at = new Date().toISOString()): Event {
  return {
    id: newId('evt'),
    sessionId: sessionId,
    type,
    actorAgentId: null,
    payload,
    at
  };
}

function liveMessage(
  id: ChatMessage['id'],
  role: 'user' | 'assistant',
  text: string,
  data?: unknown,
  at = new Date().toISOString()
): ChatMessage {
  return {
    id,
    sessionId,
    role,
    text,
    type: 'text',
    ...(data !== undefined ? { data } : {}),
    stream: { status: role === 'user' ? 'complete' : 'pending' },
    active: true,
    createdAt: at
  };
}

function created(message: ChatMessage, producer: MessageProducer = agentProducer, at = message.createdAt): Event {
  return event('session.message.created', { transcriptTargetId: sessionId, producer, message, messageRevision: 1 }, at);
}

function delta(
  messageId: ChatMessage['id'],
  text: string,
  index: number,
  channel = 'content',
  producer: MessageProducer = agentProducer,
  at?: string
): Event {
  return event(
    'session.message.delta.appended',
    { transcriptTargetId: sessionId, producer, messageId, channel, index, delta: text },
    at
  );
}

function completed(
  message: ChatMessage,
  producer: MessageProducer = agentProducer,
  at = new Date().toISOString()
): Event {
  return event(
    'session.message.completed',
    {
      transcriptTargetId: sessionId,
      producer,
      message: { ...message, stream: { status: 'complete' } },
      messageRevision: 2
    },
    at
  );
}

function failed(message: ChatMessage, producer: MessageProducer = agentProducer): Event {
  return event('session.message.failed', {
    transcriptTargetId: sessionId,
    producer,
    message: { ...message, stream: { status: 'settled' } },
    messageRevision: 2
  });
}

test('hydrates persisted messages by creation time instead of insertion order', () => {
  const projector = new SessionUiProjector();
  const message = (id: ChatMessage['id'], createdAt: string): ChatMessage => ({
    id,
    sessionId,
    role: 'assistant',
    text: id,
    type: 'text',
    stream: { status: 'complete' },
    active: true,
    createdAt
  });

  projector.hydrateMessages([
    message('msg_130517000000', '2026-07-18T13:05:17.000Z'),
    message('msg_130344000000', '2026-07-18T13:03:44.000Z'),
    message('msg_130443000000', '2026-07-18T13:04:43.000Z')
  ]);

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items.map((item) => item.id)).toEqual(['msg_130344000000', 'msg_130443000000', 'msg_130517000000']);
});

test('hydrates persisted tool calls into one tool item', () => {
  const projector = new SessionUiProjector();
  const messages: ChatMessage[] = [
    {
      id: 'msg_toolcall0000',
      sessionId: sessionId,
      role: 'assistant',
      text: '',
      type: 'tool_call',
      data: { toolCallId: 'call_1', toolName: 'search', input: { q: 'monad' } },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: 'msg_toolresult00',
      sessionId: sessionId,
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

test('projects structured tool error codes', () => {
  const projector = new SessionUiProjector();
  projector.applyEvent(
    event('tool.called', { toolCallId: 'call_1', tool: 'process_control', input: { action: 'logs', id: 'proc_nope' } })
  );
  const events = projector.applyEvent(
    event('tool.result', {
      toolCallId: 'call_1',
      tool: 'process_control',
      ok: false,
      result: 'unknown process id "proc_nope"',
      errorCode: 'PROCESS_NOT_FOUND'
    })
  );

  expect(events.at(-1)).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'tool',
      id: 'call_1',
      status: 'error',
      output: 'unknown process id "proc_nope"',
      errorCode: 'PROCESS_NOT_FOUND'
    }
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
  projector.applyEvent(
    event('tool.called', { toolCallId: 'call_1', tool: 'file_patch', input: { path: '/tmp/a.txt' } })
  );
  const events = projector.applyEvent(
    event('tool.result', {
      toolCallId: 'call_1',
      tool: 'file_patch',
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
      id: 'msg_toolcall0000',
      sessionId: sessionId,
      role: 'assistant',
      text: '',
      type: 'tool_call',
      data: { toolCallId: 'call_1', toolName: 'file_patch', input: { path: '/tmp/a.txt' } },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: 'msg_toolresult00',
      sessionId: sessionId,
      role: 'tool',
      text: 'Modified file: /tmp/a.txt. 1 added, 1 removed.',
      type: 'tool_result',
      data: {
        toolCallId: 'call_1',
        toolName: 'file_patch',
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
      id: 'msg_toolcall0000',
      sessionId: sessionId,
      role: 'assistant',
      text: '',
      type: 'tool_call',
      data: { toolCallId: 'call_1', toolName: 'missing_tool', input: { q: 'monad' } },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: 'msg_toolresult00',
      sessionId: sessionId,
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
      id: 'msg_toolcall0000',
      sessionId: sessionId,
      role: 'assistant',
      text: '',
      type: 'tool_call',
      data: { toolCallId: 'call_1', toolName: 'shell_exec', input: { command: 'git status' } },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: 'msg_toolresult00',
      sessionId: sessionId,
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
      id: 'msg_100000000000',
      sessionId: sessionId,
      role: 'user',
      text: 'old request',
      type: 'text',
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:00.000Z'
    },
    {
      id: 'msg_200000000000',
      sessionId: sessionId,
      role: 'assistant',
      text: 'recent answer',
      type: 'text',
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-06-24T00:00:01.000Z'
    }
  ];

  projector.hydrateMessages(messages, { summary: 'Earlier turns covered setup.', uptoMessageId: 'msg_100000000000' });
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items.map((item) => item.kind)).toEqual(['message', 'memory_summary', 'message']);
  expect(snapshot.items[1]).toMatchObject({
    kind: 'memory_summary',
    summary: 'Earlier turns covered setup.',
    uptoMessageId: 'msg_100000000000'
  });
});

test('streams reasoning and text onto the same message item', () => {
  const projector = new SessionUiProjector();
  const message = liveMessage('msg_100000000000', 'assistant', '');
  projector.applyEvent(created(message));
  projector.applyEvent(delta(message.id, 'think', 0, 'reasoning'));
  projector.applyEvent(delta(message.id, 'hello', 0));
  const [final] = projector.applyEvent(completed({ ...message, text: 'hello', data: { reasoning: 'think' } }));
  if (final?.kind !== 'upsert' || final.item.kind !== 'message') throw new Error('expected message upsert');
  expect(final.item.parts).toEqual([
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'hello' }
  ]);
  expect(final.item.status).toBe('done');
});

test('projects canonical message lifecycle', () => {
  const projector = new SessionUiProjector();
  const message: ChatMessage = {
    id: 'msg_100000000000',
    sessionId,
    role: 'assistant',
    text: '',
    type: 'text',
    data: { agentName: 'codex' },
    stream: { status: 'pending' },
    active: true,
    createdAt: '2026-07-18T00:00:00.000Z'
  };
  projector.applyEvent(
    event('session.message.created', {
      transcriptTargetId: sessionId,
      producer: agentProducer,
      message,
      messageRevision: 1
    })
  );
  projector.applyEvent(
    event('session.message.delta.appended', {
      transcriptTargetId: sessionId,
      producer: agentProducer,
      messageId: message.id,
      channel: 'content',
      index: 0,
      delta: 'hello'
    })
  );
  const [settled] = projector.applyEvent(
    event('session.message.completed', {
      transcriptTargetId: sessionId,
      producer: agentProducer,
      message: { ...message, text: 'hello', stream: { status: 'complete' } },
      messageRevision: 3
    })
  );

  if (settled?.kind !== 'upsert' || settled.item.kind !== 'message') throw new Error('expected message upsert');
  expect(settled.item).toEqual({
    kind: 'message',
    id: message.id,
    role: 'assistant',
    agentName: 'codex',
    parts: [{ type: 'text', text: 'hello' }],
    status: 'done',
    seq: message.createdAt
  });
});

test('canonical provider config failures render as provider-config-error artifacts', () => {
  const projector = new SessionUiProjector();
  const message: ChatMessage = {
    ...liveMessage('msg_100000000000', 'assistant', 'no credentials configured for provider "anthropic"', {
      providerId: 'anthropic'
    }),
    type: 'provider_config_error'
  };
  const [errEvent] = projector.applyEvent(failed(message));
  if (errEvent?.kind !== 'upsert' || errEvent.item.kind !== 'message') throw new Error('expected message upsert');
  expect(errEvent.item.status).toBe('error');
  expect(errEvent.item.parts).toEqual([
    {
      type: 'artifact',
      messageType: 'provider_config_error',
      text: 'no credentials configured for provider "anthropic"',
      data: { providerId: 'anthropic' }
    }
  ]);
});

test('canonical non-config failures render as plain text', () => {
  const projector = new SessionUiProjector();
  const message = {
    ...liveMessage('msg_100000000000', 'assistant', 'Rate limit.', { code: 'rate_limit_exceeded' }),
    type: 'error' as const
  };
  const [errEvent] = projector.applyEvent(failed(message));
  if (errEvent?.kind !== 'upsert' || errEvent.item.kind !== 'message') throw new Error('expected message upsert');
  expect(errEvent.item.parts).toEqual([{ type: 'text', text: 'Rate limit.' }]);
});

test('settles a pre-tool reasoning segment when a tool call starts', () => {
  const projector = new SessionUiProjector();
  const beforeTool = liveMessage('msg_100000000000', 'assistant', '');
  projector.applyEvent(created(beforeTool));
  projector.applyEvent(delta(beforeTool.id, 'I will use a tool.', 0, 'reasoning'));

  projector.applyEvent(event('tool.called', { toolCallId: 'call_1', tool: 'file_write', input: { path: 'test.md' } }));
  projector.applyEvent(
    event('tool.result', { toolCallId: 'call_1', tool: 'file_write', ok: true, result: 'wrote test.md' })
  );
  const afterTool = liveMessage('msg_200000000000', 'assistant', '');
  projector.applyEvent(completed({ ...beforeTool, data: { reasoning: 'I will use a tool.' } }));
  projector.applyEvent(created(afterTool));
  projector.applyEvent(delta(afterTool.id, 'The file was written.', 0, 'reasoning'));
  projector.applyEvent(completed({ ...afterTool, text: 'Done.', data: { reasoning: 'The file was written.' } }));

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items.filter((item) => item.kind === 'message' && item.status === 'streaming')).toEqual([]);
  expect(snapshot.items).toContainEqual(
    expect.objectContaining({ kind: 'message', id: 'msg_100000000000', status: 'done' })
  );
});

test('accumulates streamed text deltas across tokens (non-channel session)', () => {
  const projector = new SessionUiProjector();
  const message = liveMessage('msg_100000000000', 'assistant', '');
  projector.applyEvent(created(message));
  projector.applyEvent(delta(message.id, 'Hello', 0));
  const [second] = projector.applyEvent(delta(message.id, ' world', 1));
  if (second?.kind !== 'upsert' || second.item.kind !== 'message') throw new Error('expected message upsert');
  expect(second.item.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  expect(second.item.status).toBe('streaming');

  const [third] = projector.applyEvent(delta(message.id, '!', 2));
  if (third?.kind !== 'upsert' || third.item.kind !== 'message') throw new Error('expected message upsert');
  expect(third.item.parts).toEqual([{ type: 'text', text: 'Hello world!' }]);
});

test('clears accumulated streaming text after the message settles', () => {
  const projector = new SessionUiProjector();
  const message = liveMessage('msg_100000000000', 'assistant', '');
  projector.applyEvent(created(message));
  projector.applyEvent(delta(message.id, 'draft', 0));
  projector.applyEvent(completed({ ...message, text: 'final' }));
  // A reused messageId must not resume from the prior message's accumulated buffer.
  const [restart] = projector.applyEvent(delta(message.id, 'fresh', 0));
  if (restart?.kind !== 'upsert' || restart.item.kind !== 'message') throw new Error('expected message upsert');
  expect(restart.item.parts).toEqual([{ type: 'text', text: 'fresh' }]);
});

test('reasoning deltas preserve the streaming message agent name', () => {
  const projector = new SessionUiProjector();
  const message = liveMessage('msg_100000000000', 'assistant', '', { agentName: 'codex' });
  projector.applyEvent(created(message));
  const [reasoning] = projector.applyEvent(delta(message.id, 'Thinking', 0, 'reasoning'));

  expect(reasoning).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'message',
      id: 'msg_100000000000',
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

test('live managed agent messages preserve the author display name snapshot', () => {
  const projector = new SessionUiProjector();
  const message = liveMessage('msg_snapshot0000', 'assistant', '', {
    agentName: 'pmem_claude_fable',
    agentDisplayName: 'Fable',
    source: 'managed-external-agent'
  });
  projector.applyEvent(created(message));
  const [completedEvent] = projector.applyEvent(completed({ ...message, text: 'Done' }));

  expect(completedEvent).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'message',
      id: 'msg_snapshot0000',
      agentName: 'pmem_claude_fable',
      agentDisplayName: 'Fable',
      status: 'done'
    }
  });
});

test('hydrates a persisted managed external agent thinking message after refresh', () => {
  const projector = new SessionUiProjector();
  projector.hydrateMessages([
    {
      id: 'msg_thinking0000',
      sessionId: sessionId,
      role: 'assistant',
      text: '',
      type: 'text',
      data: {
        agentName: 'pmem_codex_reviewer',
        agentDisplayName: 'Reviewer',
        source: 'managed-external-agent',
        reasoning: 'Thinking'
      },
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
      id: 'msg_thinking0000',
      agentName: 'pmem_codex_reviewer',
      agentDisplayName: 'Reviewer',
      source: 'managed-external-agent',
      status: 'streaming',
      parts: [{ type: 'reasoning', text: 'Thinking' }]
    })
  ]);
});

test('hydrates external agent provider errors without breaking the UI stream', () => {
  const projector = new SessionUiProjector();
  projector.hydrateMessages([
    {
      id: 'msg_providernQrz',
      sessionId: sessionId,
      role: 'assistant',
      text: 'thread not found: 019f30a7-ddaf-7062-9f89-f3fd90b5397c',
      type: 'error',
      data: {
        agentName: 'pmem_codex_reviewer',
        externalAgentSessionId: 'exa_provider5wxW',
        deliveryId: 'deliv_providerotf8',
        source: 'external-agent-provider'
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
      id: 'msg_providernQrz',
      agentName: 'pmem_codex_reviewer',
      source: 'external-agent-provider',
      externalAgentSessionId: 'exa_provider5wxW',
      deliveryId: 'deliv_providerotf8',
      status: 'error',
      parts: [{ type: 'text', text: 'thread not found: 019f30a7-ddaf-7062-9f89-f3fd90b5397c' }]
    })
  ]);
});

test('managed external agent completion moves live order to completion time', () => {
  const projector = new SessionUiProjector();
  const startedAt = '2026-06-24T00:00:01.000Z';
  const completedAt = '2026-06-24T00:00:09.000Z';
  const message = liveMessage(
    'msg_CLI000000000',
    'assistant',
    '',
    { agentName: 'codex', source: 'managed-external-agent' },
    startedAt
  );
  projector.applyEvent(created(message));
  projector.applyEvent(completed({ ...message, text: 'done' }, agentProducer, completedAt));

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items).toEqual([
    expect.objectContaining({
      kind: 'message',
      id: 'msg_CLI000000000',
      status: 'done',
      seq: completedAt
    })
  ]);
});

test('managed external agent message projections retain delivery observation pointers', () => {
  const deliveryId = newId('deliv');
  const live = new SessionUiProjector();
  const message = liveMessage('msg_CLI000000000', 'assistant', '', {
    agentName: 'codex',
    externalAgentSessionId: 'exa_codex0000000',
    deliveryId,
    source: 'managed-external-agent'
  });
  live.applyEvent(created(message));
  const [settled] = live.applyEvent(completed({ ...message, text: 'done' }));

  expect(settled?.kind === 'upsert' && settled.item.kind === 'message' ? settled.item : undefined).toMatchObject({
    externalAgentSessionId: 'exa_codex0000000',
    deliveryId
  });

  const hydrated = new SessionUiProjector();
  hydrated.hydrateMessages([
    {
      id: 'msg_CLI000000000',
      sessionId: sessionId,
      role: 'assistant',
      text: 'done',
      type: 'text',
      data: {
        agentName: 'codex',
        externalAgentSessionId: 'exa_codex0000000',
        deliveryId,
        source: 'managed-external-agent'
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
    externalAgentSessionId: 'exa_codex0000000',
    deliveryId
  });
});

test('live user messages keep chronological order before later managed external agent replies', () => {
  const projector = new SessionUiProjector();
  const user = liveMessage('msg_USER00000000', 'user', 'hi all', undefined, '2026-06-24T10:00:00.000Z');
  const reply = liveMessage(
    'msg_CLI000000000',
    'assistant',
    '',
    { agentName: 'claude', source: 'managed-external-agent' },
    '2026-06-24T10:00:01.000Z'
  );
  projector.applyEvent(created(user, { kind: 'user' }));
  projector.applyEvent(created(reply));
  projector.applyEvent(completed({ ...reply, text: 'I can take this.' }, agentProducer, '2026-06-24T10:00:02.000Z'));

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items.map((item) => item.id)).toEqual(['msg_USER00000000', 'msg_CLI000000000']);
});

test('channel projector streams only structured display content', () => {
  const projector = new SessionUiProjector({ channelStructured: true });
  const message = liveMessage('msg_100000000000', 'assistant', '');
  projector.applyEvent(created(message));
  const first = projector.applyEvent(delta(message.id, '{"display":{"kind":"markdown","content":"visible', 0));
  const firstItem = first.at(-1);
  const firstText =
    firstItem?.kind === 'upsert' && firstItem.item.kind === 'message' && firstItem.item.parts[0]?.type === 'text'
      ? firstItem.item.parts[0].text
      : undefined;
  const second = projector.applyEvent(delta(message.id, ' update"},"attachments":[],"next":[]}', 1));
  const [final] = projector.applyEvent(
    completed({
      ...message,
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
  const message = liveMessage('msg_100000000000', 'assistant', '');
  projector.applyEvent(created(message));
  const first = projector.applyEvent(delta(message.id, '```json\n{"display":{"kind":"markdown","content":"fenced', 0));
  const firstItem = first.at(-1);
  const firstText =
    firstItem?.kind === 'upsert' && firstItem.item.kind === 'message' && firstItem.item.parts[0]?.type === 'text'
      ? firstItem.item.parts[0].text
      : undefined;

  expect(firstText).toBe('fenced');
});

test('channel projector hides a silent reply mid-stream before the JSON closes', () => {
  const projector = new SessionUiProjector({ channelStructured: true });
  const message = liveMessage('msg_100000000000', 'assistant', '');
  projector.applyEvent(created(message));
  const out = projector.applyEvent(
    delta(message.id, '{"visibility":"silent","display":{"kind":"markdown","content":"secret', 0)
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
  const message = liveMessage('msg_100000000000', 'assistant', '');
  projector.applyEvent(created(message));
  const textOf = (events: ReturnType<SessionUiProjector['applyEvent']>): string | undefined => {
    const item = events.at(-1);
    return item?.kind === 'upsert' && item.item.kind === 'message' && item.item.parts[0]?.type === 'text'
      ? item.item.parts[0].text
      : undefined;
  };
  // Opening + first content parses (no cache yet).
  textOf(projector.applyEvent(delta(message.id, '{"display":{"content":"a', 0)));
  // Several tiny content tokens (each < 32 chars, no `}`) — these reuse the cached parse.
  for (let i = 1; i <= 5; i++) {
    textOf(projector.applyEvent(delta(message.id, 'b', i)));
  }
  // A delta carrying `}` (structural close) forces a re-parse: the full content is now rendered.
  const closed = textOf(projector.applyEvent(delta(message.id, 'c"},"next":[]}', 6)));
  expect(closed).toBe('abbbbbc');
});

test('channel projector hydrates persisted structured assistant content as display text', () => {
  const projector = new SessionUiProjector({ channelStructured: true });
  const messages: ChatMessage[] = [
    {
      id: 'msg_structured00',
      sessionId: sessionId,
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
      id: 'msg_silent000000',
      sessionId: sessionId,
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
  const live = liveMessage(liveMessageId, 'assistant', '');
  projector.applyEvent(created(live));
  projector.applyEvent(
    delta(live.id, '{"visibility":"silent","display":{"kind":"markdown","content":""},"attachments":[],"next":[]}', 0)
  );
  const [final] = projector.applyEvent(
    completed({
      ...live,
      text: '{"visibility":"silent","display":{"kind":"markdown","content":""},"attachments":[],"next":[]}'
    })
  );
  expect(final).toMatchObject({ kind: 'remove', target: { kind: 'message', id: liveMessageId } });
});

test('projects command directive events with effect data', () => {
  const projector = new SessionUiProjector();
  const messageId = newId('msg');
  const message: ChatMessage = {
    ...liveMessage(messageId, 'assistant', 'Context compacted.', {
      effect: { type: 'compacted', compacted: 3, summary: 'Earlier context.' }
    }),
    type: 'directive'
  };
  const [final] = projector.applyEvent(completed(message, { kind: 'system', subsystem: 'command' }));
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

test('projects resource approvals with user-facing display metadata', () => {
  const projector = new SessionUiProjector();
  const [pathApproval] = projector.applyEvent(
    event('tool.approval_requested', {
      requestId: 'req_path',
      tool: 'path_access',
      key: '/Users/test/project',
      input: {
        path: '/Users/test/project/file.txt',
        dir: '/Users/test/project',
        displayHint: { kind: 'resource-approval', resource: 'path', subject: '/Users/test/project' }
      }
    })
  );
  expect(pathApproval).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'approval',
      display: { kind: 'resource-approval', resource: 'path', subject: '/Users/test/project' }
    }
  });
  if (pathApproval?.kind !== 'upsert' || pathApproval.item.kind !== 'approval') throw new Error('expected approval');
  expect(pathApproval.item.display).toEqual({
    kind: 'resource-approval',
    resource: 'path',
    subject: '/Users/test/project'
  });

  const [networkApproval] = projector.applyEvent(
    event('tool.approval_requested', {
      requestId: 'req_net',
      tool: 'network_access',
      key: 'example.com',
      input: {
        url: 'https://example.com/docs',
        host: 'example.com',
        protocol: 'https',
        displayHint: { kind: 'resource-approval', resource: 'network', subject: 'example.com' }
      }
    })
  );
  expect(networkApproval).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'approval',
      display: { kind: 'resource-approval', resource: 'network', subject: 'example.com' }
    }
  });
  if (networkApproval?.kind !== 'upsert' || networkApproval.item.kind !== 'approval') {
    throw new Error('expected approval');
  }
  expect(networkApproval.item.display).toEqual({
    kind: 'resource-approval',
    resource: 'network',
    subject: 'example.com'
  });
});

test('ignores spoofed resource approval display metadata from non-resource tools', () => {
  const projector = new SessionUiProjector();
  const [added] = projector.applyEvent(
    event('tool.approval_requested', {
      requestId: 'req_mcp',
      tool: 'mcp_server_tool',
      key: 'dangerous-action',
      input: {
        action: 'delete',
        displayHint: { kind: 'resource-approval', resource: 'path', subject: '/tmp/benign' }
      }
    })
  );

  if (added?.kind !== 'upsert' || added.item.kind !== 'approval') throw new Error('expected approval');
  expect(added.item.tool).toBe('mcp_server_tool');
  expect(added.item.display).toBeUndefined();
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

  expect(projector.applyEvent(event('clarify.resolved', { requestId: 'clarify_1', answer: 'Ship it' }))).toEqual([
    expect.objectContaining({ kind: 'remove', target: { kind: 'clarification', id: 'clarify_1' } }),
    expect.objectContaining({
      kind: 'upsert',
      item: {
        kind: 'message',
        id: 'clarify-answer:clarify_1',
        role: 'user',
        parts: [{ type: 'text', text: 'Ship it' }],
        status: 'done',
        seq: expect.any(String)
      }
    })
  ]);
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

test('settles a running external agent tool item on turn_settled', () => {
  const projector = new SessionUiProjector();
  const externalAgentSessionId = 'exa_200000000000';
  projector.applyEvent(
    event('external_agent.started', {
      externalAgentSessionId,
      agentName: 'claude-code',
      provider: 'claude-code',
      launchMode: 'pty',
      workingPath: '/Users/test/Projects/monad',
      pid: 123
    })
  );

  const settled = projector.applyEvent(event('external_agent.turn_settled', { externalAgentSessionId }));

  expect(settled).toHaveLength(1);
  expect(settled[0]).toMatchObject({
    kind: 'upsert',
    item: { kind: 'tool', id: externalAgentSessionId, status: 'ok' }
  });
});

test('turn_settled with error marks the tool item errored', () => {
  const projector = new SessionUiProjector();
  const externalAgentSessionId = 'exa_300000000000';
  projector.applyEvent(
    event('external_agent.started', {
      externalAgentSessionId,
      agentName: 'claude-code',
      provider: 'claude-code',
      launchMode: 'pty',
      workingPath: '/Users/test/Projects/monad',
      pid: 123
    })
  );

  const settled = projector.applyEvent(event('external_agent.turn_settled', { externalAgentSessionId, error: true }));

  expect(settled).toHaveLength(1);
  expect(settled[0]).toMatchObject({
    kind: 'upsert',
    item: { kind: 'tool', id: externalAgentSessionId, status: 'error' }
  });
});

test('turn_settled is a no-op when there is no live running tool item', () => {
  const projector = new SessionUiProjector();
  const settled = projector.applyEvent(
    event('external_agent.turn_settled', { externalAgentSessionId: 'exa_missing00000' })
  );
  expect(settled).toEqual([]);
});

test('projects login_required as an ephemeral custom card and removes it on login_resolved', () => {
  const projector = new SessionUiProjector();
  const payload = {
    externalAgentSessionId: 'exa_400000000000',
    agentName: 'claude-code',
    provider: 'claude-code',
    reason: 'Not logged in · Please run /login'
  };

  const [card] = projector.applyEvent(event('external_agent.login_required', payload));
  expect(card).toMatchObject({
    kind: 'upsert',
    item: {
      kind: 'custom',
      id: 'external-agent-login-required:claude-code',
      name: 'external_agent.login_required',
      status: 'error',
      data: payload
    }
  });

  const [removed] = projector.applyEvent(
    event('external_agent.login_resolved', { agentName: 'claude-code', provider: 'claude-code' })
  );
  expect(removed).toEqual(
    expect.objectContaining({
      kind: 'remove',
      target: { kind: 'custom', id: 'external-agent-login-required:claude-code' }
    })
  );
});

test('projects persisted authentication failures as the removable login card', () => {
  const projector = new SessionUiProjector();
  const payload = {
    externalAgentSessionId: 'exa_400000000001',
    agentName: 'claude-code',
    provider: 'claude-code',
    code: 'authentication_failed',
    reason: 'Not logged in · Please run /login',
    reconnectIn: 'studio'
  };

  const connectionEvent = event('external_agent.connection_required', payload);
  expect(projector.applyEvent(connectionEvent)).toEqual([
    {
      kind: 'upsert',
      cursor: connectionEvent.id,
      item: {
        kind: 'custom',
        id: 'external-agent-login-required:claude-code',
        name: 'external_agent.login_required',
        status: 'error',
        data: {
          externalAgentSessionId: payload.externalAgentSessionId,
          agentName: payload.agentName,
          provider: payload.provider,
          reason: payload.reason
        },
        seq: connectionEvent.id
      }
    }
  ]);

  const resolvedEvent = event('external_agent.login_resolved', {
    agentName: 'claude-code',
    provider: 'claude-code'
  });
  expect(projector.applyEvent(resolvedEvent)).toEqual([
    {
      kind: 'remove',
      cursor: resolvedEvent.id,
      target: { kind: 'custom', id: 'external-agent-login-required:claude-code' }
    }
  ]);
});

test('projects external agent provider-owned approvals as distinct approval items', () => {
  const projector = new SessionUiProjector();
  const [approval] = projector.applyEvent(
    event('external_agent.approval_requested', {
      externalAgentSessionId: 'exa_gemini000000',
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
        externalAgentSessionId: 'exa_gemini000000',
        provider: 'gemini',
        text: 'trust this Gemini project folder',
        approvalOwnership: 'provider-owned'
      },
      key: 'provider-owned:gemini'
    }
  });
});

test('projects external agent reconnect requirements as visible custom items', () => {
  const projector = new SessionUiProjector();
  const [connection] = projector.applyEvent(
    event('external_agent.connection_required', {
      externalAgentSessionId: 'exa_gemini000000',
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
      id: 'external-agent-connection-required:exa_gemini000000',
      name: 'external_agent.connection_required',
      status: 'error',
      data: {
        externalAgentSessionId: 'exa_gemini000000',
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
    event('task.created', { taskId: 'tsk_100000000000', title: 'Plan migration', assigneeAgentId: null })
  );
  if (task?.kind !== 'upsert' || task.item.kind !== 'custom') throw new Error('expected custom upsert');
  expect(task.item).toMatchObject({
    kind: 'custom',
    id: 'tsk_100000000000',
    name: 'task.created',
    status: 'streaming',
    data: { taskId: 'tsk_100000000000', title: 'Plan migration', assigneeAgentId: null }
  });
});

test('reset session update clears projected items', () => {
  const projector = new SessionUiProjector();
  projector.applyEvent(created(liveMessage('msg_100000000000', 'user', 'hello'), { kind: 'user' }));
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
      sessionId: sessionId,
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
      sessionId: sessionId,
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

function cliSession(overrides: Partial<ExternalAgentSessionSnapshot> = {}): ExternalAgentSessionSnapshot {
  return {
    id: 'exa_100000000000',
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

test('hydrateExternalAgentSessions rebuilds a running tool card from the output snapshot', () => {
  const projector = new SessionUiProjector();
  projector.hydrateExternalAgentSessions([
    cliSession({
      outputSnapshot: [
        '{"method":"turn/started","params":{}}',
        '{"method":"item/agentMessage/delta","params":{"delta":"Working"}}'
      ].join('\n')
    })
  ]);
  const snap = projector.snapshot();
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snap.items).toHaveLength(1);
  expect(snap.items[0]).toMatchObject({
    kind: 'tool',
    id: 'exa_100000000000',
    tool: 'external-agent:codex',
    status: 'running',
    output: [
      '{"method":"turn/started","params":{}}',
      '{"method":"item/agentMessage/delta","params":{"delta":"Working"}}'
    ].join('\n'),
    input: { agent: 'codex', provider: 'codex', launchMode: 'app-server' }
  });
});

test('hydrateExternalAgentSessions settles a running process after provider end turn', () => {
  const projector = new SessionUiProjector();
  projector.hydrateExternalAgentSessions([
    cliSession({
      provider: 'claude-code',
      outputSnapshot: [
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Working"}}}',
        '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'
      ].join('\n')
    })
  ]);
  const snap = projector.snapshot();
  if (snap.kind !== 'snapshot' || snap.items[0]?.kind !== 'tool') throw new Error('expected tool');
  expect(snap.items[0].status).toBe('ok');
});

test('hydrateExternalAgentSessions maps terminal state and appends the exit line', () => {
  const failed = new SessionUiProjector();
  failed.hydrateExternalAgentSessions([cliSession({ id: 'exa_f00000000000', state: 'failed', exitCode: 1 })]);
  const fSnap = failed.snapshot();
  if (fSnap.kind !== 'snapshot' || fSnap.items[0]?.kind !== 'tool') throw new Error('expected tool');
  expect(fSnap.items[0].status).toBe('error');

  const exited = new SessionUiProjector();
  exited.hydrateExternalAgentSessions([cliSession({ id: 'exa_e00000000000', state: 'exited', exitCode: 0 })]);
  const eSnap = exited.snapshot();
  if (eSnap.kind !== 'snapshot' || eSnap.items[0]?.kind !== 'tool') throw new Error('expected tool');
  expect(eSnap.items[0].status).toBe('ok');
});

test('hydrateExternalAgentSessions interleaves cards with messages by startedAt', () => {
  const projector = new SessionUiProjector();
  const mkMsg = (id: `msg_${string}`, at: string): ChatMessage => ({
    id,
    sessionId: sessionId,
    role: 'user',
    text: id,
    type: 'text',
    stream: { status: 'complete' },
    active: true,
    createdAt: at
  });
  // Messages at 00:00 and 00:01; a CLI run started at 00:00:00.500 must land between them.
  projector.hydrateMessages([
    mkMsg('msg_a00000000000', '2026-06-24T00:00:00.000Z'),
    mkMsg('msg_b00000000000', '2026-06-24T00:00:01.000Z')
  ]);
  projector.hydrateExternalAgentSessions([cliSession()]);
  const snap = projector.snapshot();
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snap.items.map((i) => i.id)).toEqual(['msg_a00000000000', 'exa_100000000000', 'msg_b00000000000']);
});

test('hydrateExternalAgentSessions updates an existing card in place without duplicating', () => {
  const projector = new SessionUiProjector();
  projector.hydrateExternalAgentSessions([cliSession({ outputSnapshot: 'first' })]);
  projector.hydrateExternalAgentSessions([cliSession({ outputSnapshot: 'second', state: 'stopped' })]);
  const snap = projector.snapshot();
  if (snap.kind !== 'snapshot' || snap.items[0]?.kind !== 'tool') throw new Error('expected tool');
  expect(snap.items).toHaveLength(1);
  expect(snap.items[0].status).toBe('ok');
});

test('live streaming evicts oldest settled items past the cap but keeps active and pending ones', () => {
  const projector = new SessionUiProjector();
  projector.hydrateMessages([]);
  projector.snapshot(); // commit the initial view → enable live eviction
  // A pending approval and a still-streaming assistant message, both inserted early.
  projector.applyEvent(event('tool.approval_requested', { requestId: 'req_1', tool: 'shell_exec', input: {} }));
  const streaming = liveMessage('msg_LIVE00000000', 'assistant', '');
  projector.applyEvent(created(streaming));
  projector.applyEvent(delta(streaming.id, 'streaming', 0));
  // Flood with settled user messages well past MAX_LIVE_UI_ITEMS (1000).
  for (let i = 0; i < 1100; i++) {
    projector.applyEvent(created(liveMessage(`msg_${String(i).padStart(12, '0')}`, 'user', `m${i}`), { kind: 'user' }));
  }
  const snap = projector.snapshot();
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snap.items.length).toBeLessThanOrEqual(1000);
  // Never-evictable items survive despite being the oldest.
  expect(snap.items.some((i) => i.kind === 'approval' && i.id === 'req_1')).toBe(true);
  expect(snap.items.some((i) => i.kind === 'message' && i.id === 'msg_LIVE00000000' && i.status === 'streaming')).toBe(
    true
  );
  // Oldest settled messages were dropped; the newest remain.
  expect(snap.items.some((i) => i.id === 'msg_000000000000')).toBe(false);
  expect(snap.items.some((i) => i.id === 'msg_000000001099')).toBe(true);
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
  const user = liveMessage('msg_U00000000000', 'user', 'review please');
  const codex = liveMessage('msg_A00000000000', 'assistant', '', { agentName: 'codex' });
  const claude = liveMessage('msg_B00000000000', 'assistant', '', { agentName: 'claude' });
  p.applyEvent(created(user, { kind: 'user' }));
  p.applyEvent(created(codex));
  p.applyEvent(created(claude));
  // codex and claude stream at the same time, tokens interleaved; claude settles before codex.
  p.applyEvent(delta(codex.id, 'Look', 0));
  p.applyEvent(delta(claude.id, 'I dis', 0));
  p.applyEvent(delta(codex.id, 'ing', 1));
  p.applyEvent(delta(claude.id, 'agree', 1));
  p.applyEvent(completed({ ...claude, text: 'I disagree' }));
  p.applyEvent(completed({ ...codex, text: 'Looking good' }));
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
  p.applyEvent(created(liveMessage('msg_U00000000000', 'user', 'please review'), { kind: 'user' }));
  p.applyEvent(
    event('external_agent.started', {
      externalAgentSessionId: 'exa_100000000000',
      agentName: 'codex',
      provider: 'codex',
      launchMode: 'pty',
      workingPath: '/w',
      pid: 123
    })
  );
  // The reply reaching the wall: a Thinking placeholder that settles into the posted text.
  const reply = liveMessage('msg_R00000000000', 'assistant', '', {
    agentName: 'codex',
    source: 'managed-external-agent'
  });
  p.applyEvent(created(reply));
  p.applyEvent(delta(reply.id, 'Thinking', 0, 'reasoning'));
  p.applyEvent(
    completed({
      ...reply,
      text: 'looks good to me',
      data: { agentName: 'codex', source: 'managed-external-agent', reasoning: 'Thinking' }
    })
  );
  const snap = p.snapshot();
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snap.items.map((i) => `${i.kind}:${i.id}`)).toEqual([
    'message:msg_U00000000000',
    'tool:exa_100000000000',
    'message:msg_R00000000000'
  ]);
  const card = snap.items.find((i) => i.kind === 'tool');
  if (card?.kind !== 'tool') throw new Error('expected tool card');
  expect(card.tool).toBe('external-agent:codex');
  const replyItem = snap.items.find((i) => i.id === 'msg_R00000000000');
  if (replyItem?.kind !== 'message') throw new Error('expected reply message');
  expect(replyItem.status).toBe('done');
  expect(
    replyItem.parts.find((x) => x.type === 'text')?.type === 'text' && replyItem.parts.find((x) => x.type === 'text')
  ).toMatchObject({ text: 'looks good to me' });
});

test('projects context.evicted as a localized info-level system notice', () => {
  const projector = new SessionUiProjector();
  const [upsert] = projector.applyEvent(event('context.evicted', { reclaimedTokens: 6200, resultCount: 7 }));
  if (upsert?.kind !== 'upsert' || upsert.item.kind !== 'system') throw new Error('expected system item');
  expect(upsert.item.level).toBe('info');
  expect(upsert.item.text).toBe(`Cleared ~${(6200).toLocaleString()} tokens (7 tool results) from context.`);

  const [single] = new SessionUiProjector().applyEvent(
    event('context.evicted', { reclaimedTokens: 800, resultCount: 1 })
  );
  if (single?.kind !== 'upsert' || single.item.kind !== 'system') throw new Error('expected system item');
  expect(single.item.text).toBe(`Cleared ~${(800).toLocaleString()} tokens (1 tool result) from context.`);

  const zh = new SessionUiProjector({ t: createI18n({ locale: 'zh', packs: [] }).t });
  const [zhUpsert] = zh.applyEvent(event('context.evicted', { reclaimedTokens: 6200, resultCount: 7 }));
  if (zhUpsert?.kind !== 'upsert' || zhUpsert.item.kind !== 'system') throw new Error('expected system item');
  expect(zhUpsert.item.text).toBe(`已从上下文清理约 ${(6200).toLocaleString()} 个 token（7 个工具结果）。`);
});

test('projects context.handoff_suggested as a localized warn-level system notice', () => {
  const projector = new SessionUiProjector();
  const source = event('context.handoff_suggested', { usedFraction: 0.85, atFraction: 0.7 });
  const [upsert] = projector.applyEvent(source);
  if (upsert?.kind !== 'upsert' || upsert.item.kind !== 'system') throw new Error('expected system item');
  expect(upsert.item.id).toBe(`context-handoff:${source.id}`);
  expect(upsert.item.level).toBe('warn');
  expect(upsert.item.text).toBe('Context is 85% full — consider starting a fresh session.');

  const zh = new SessionUiProjector({ t: createI18n({ locale: 'zh', packs: [] }).t });
  const [zhUpsert] = zh.applyEvent(event('context.handoff_suggested', { usedFraction: 0.85, atFraction: 0.7 }));
  if (zhUpsert?.kind !== 'upsert' || zhUpsert.item.kind !== 'system') throw new Error('expected system item');
  expect(zhUpsert.item.text).toBe('上下文已使用 85%，建议开启新会话。');
});

test('projects memory.suggestion as a custom item carrying scope + facts', () => {
  const projector = new SessionUiProjector();
  const [upsert] = projector.applyEvent(
    event('memory.suggestion', { scope: { kind: 'agent', id: 'agt_100000000000' }, facts: ['User prefers dark mode'] })
  );
  if (upsert?.kind !== 'upsert' || upsert.item.kind !== 'custom') throw new Error('expected custom item');
  expect(upsert.item.name).toBe('memory.suggestion');
  expect(upsert.item.data).toEqual({
    scope: { kind: 'agent', id: 'agt_100000000000' },
    facts: ['User prefers dark mode']
  });
});

test('external_agent.resume_failed system notice renders from the i18n catalog', () => {
  const payload = {
    agentName: 'reviewer',
    provider: 'codex',
    providerSessionRef: 'thread-42',
    code: 'resume_unavailable',
    message: 'no such thread',
    fallback: 'cold-start'
  };

  const en = new SessionUiProjector();
  const enEvent = event('external_agent.resume_failed', payload);
  const enOut = en.applyEvent(enEvent);
  expect(enOut).toEqual([
    {
      kind: 'upsert',
      cursor: enEvent.id as `evt_${string}`,
      item: {
        kind: 'system',
        id: 'external-agent-resume-failed:reviewer:thread-42',
        text: 'Codex resume failed for provider session thread-42; cold started a new runtime.',
        level: 'warn',
        seq: enEvent.id
      }
    }
  ]);

  const zh = new SessionUiProjector({ t: createI18n({ locale: 'zh', packs: [] }).t });
  const zhEvent = event('external_agent.resume_failed', payload);
  const zhOut = zh.applyEvent(zhEvent);
  expect(zhOut[0]?.kind === 'upsert' && zhOut[0].item.kind === 'system' ? zhOut[0].item.text : undefined).toBe(
    'Codex 恢复 provider 会话 thread-42 失败，已冷启动新的运行时。'
  );
});

test('external agent idle lifecycle notices preserve typed events and render action-only localized copy', () => {
  const suspendedPayload = {
    agentId: 'pmem_reviewer_1',
    agentName: 'Reviewer',
    type: 'idle_suspended' as const,
    payload: { externalAgentSessionId: 'exa_idle00000000', idleTimeoutMs: 300 }
  };
  const resumedPayload = {
    agentId: 'pmem_reviewer_1',
    agentName: 'Reviewer',
    type: 'idle_resumed' as const,
    payload: { externalAgentSessionId: 'exa_idle00000000' }
  };

  const en = new SessionUiProjector();
  const suspendedEvent = event('external_agent.idle_suspended', suspendedPayload);
  const resumedEvent = event('external_agent.idle_resumed', resumedPayload);
  expect(en.applyEvent(suspendedEvent)).toEqual([
    {
      kind: 'upsert',
      cursor: suspendedEvent.id,
      item: {
        kind: 'system',
        id: `external-agent-idle-suspended:pmem_reviewer_1:${suspendedEvent.id}`,
        text: 'fell asleep.',
        event: suspendedPayload,
        level: 'info',
        seq: suspendedEvent.at
      }
    }
  ]);
  expect(en.applyEvent(resumedEvent)).toEqual([
    {
      kind: 'upsert',
      cursor: resumedEvent.id,
      item: {
        kind: 'system',
        id: `external-agent-idle-resumed:pmem_reviewer_1:${resumedEvent.id}`,
        text: 'woke up.',
        event: resumedPayload,
        level: 'info',
        seq: resumedEvent.at
      }
    }
  ]);

  const zh = new SessionUiProjector({ t: createI18n({ locale: 'zh', packs: [] }).t });
  const zhSuspendedEvent = event('external_agent.idle_suspended', suspendedPayload);
  const zhResumedEvent = event('external_agent.idle_resumed', resumedPayload);
  expect(zh.applyEvent(zhSuspendedEvent)).toEqual([
    {
      kind: 'upsert',
      cursor: zhSuspendedEvent.id,
      item: {
        kind: 'system',
        id: `external-agent-idle-suspended:pmem_reviewer_1:${zhSuspendedEvent.id}`,
        text: '睡着了。',
        event: suspendedPayload,
        level: 'info',
        seq: zhSuspendedEvent.at
      }
    }
  ]);
  expect(zh.applyEvent(zhResumedEvent)).toEqual([
    {
      kind: 'upsert',
      cursor: zhResumedEvent.id,
      item: {
        kind: 'system',
        id: `external-agent-idle-resumed:pmem_reviewer_1:${zhResumedEvent.id}`,
        text: '醒来了。',
        event: resumedPayload,
        level: 'info',
        seq: zhResumedEvent.at
      }
    }
  ]);
});

test('external agent idle lifecycle notices sort by event time instead of random event id', () => {
  const projector = new SessionUiProjector();
  const suspendedAt = '2026-07-18T14:00:00.000Z';
  const resumedAt = '2026-07-18T14:01:00.000Z';
  const suspended = {
    ...event(
      'external_agent.idle_suspended',
      {
        agentId: 'pmem_reviewer_1',
        agentName: 'Reviewer',
        type: 'idle_suspended',
        payload: { externalAgentSessionId: 'exa_idle00000000', idleTimeoutMs: 300 }
      },
      suspendedAt
    ),
    id: 'evt_zzzzzzzzzzzz'
  } as Event;
  const resumed = {
    ...event(
      'external_agent.idle_resumed',
      {
        agentId: 'pmem_reviewer_1',
        agentName: 'Reviewer',
        type: 'idle_resumed',
        payload: { externalAgentSessionId: 'exa_idle00000000' }
      },
      resumedAt
    ),
    id: 'evt_000000000000'
  } as Event;

  projector.applyEvent(suspended);
  projector.applyEvent(resumed);

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(
    snapshot.items.map((item) => ({
      eventType: item.kind === 'system' ? item.event?.type : undefined,
      id: item.id,
      seq: item.seq
    }))
  ).toEqual([
    {
      eventType: 'idle_suspended',
      id: 'external-agent-idle-suspended:pmem_reviewer_1:evt_zzzzzzzzzzzz',
      seq: suspendedAt
    },
    {
      eventType: 'idle_resumed',
      id: 'external-agent-idle-resumed:pmem_reviewer_1:evt_000000000000',
      seq: resumedAt
    }
  ]);
});
