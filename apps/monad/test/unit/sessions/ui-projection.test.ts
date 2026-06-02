import type { ChatMessage, Event, MessageProducer, SessionId, UIItem } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { createI18n } from '@monad/i18n';
import { newId, resolveUiMessagesRequestSchema } from '@monad/protocol';

import { SessionUiProjector } from '#/handlers/session/ui-projection.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

const sessionId = 'ses_test00000000' as SessionId;
const agentProducer = { kind: 'agent', agentId: 'agt_test00000000' } satisfies MessageProducer;

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

test('preserves reply metadata and registry policy through hydrated, canonical, and delta projections', () => {
  const replyToMessageId = 'msg_replytarget0' as const;
  const message: ChatMessage = {
    ...liveMessage('msg_replysource0', 'assistant', 'Draft reply', undefined, '2026-07-21T00:00:00.000Z'),
    replyToMessageId
  };
  const withoutRelation = (({ replyToMessageId: _replyToMessageId, ...rest }) => rest)(message);
  const expectedStreaming = {
    kind: 'message' as const,
    id: message.id,
    role: 'assistant' as const,
    parts: [{ type: 'text' as const, text: 'Draft reply' }],
    replyToMessageId,
    replyable: false,
    status: 'streaming' as const,
    seq: message.createdAt
  };
  const expectedDone = { ...expectedStreaming, replyable: true, status: 'done' as const };

  const hydrated = new SessionUiProjector();
  hydrated.hydrateMessages([{ ...message, stream: { status: 'complete' } }]);
  const hydratedSnapshot = hydrated.snapshot();
  if (hydratedSnapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(hydratedSnapshot.items).toEqual([expectedDone]);

  const projector = new SessionUiProjector();
  const createdEvent = created(message);
  const [createdItem] = projector.applyEvent(createdEvent);
  expect(createdItem).toEqual({ kind: 'upsert', cursor: createdEvent.id, item: expectedStreaming });

  const [deltaItem] = projector.applyEvent(delta(message.id, 'ing', 0));
  expect(deltaItem).toEqual({
    kind: 'upsert',
    cursor: expect.any(String),
    item: { ...expectedStreaming, parts: [{ type: 'text', text: 'ing' }] }
  });

  const updatedEvent = event('session.message.updated', {
    transcriptTargetId: sessionId,
    producer: agentProducer,
    message: { ...withoutRelation, text: 'Still drafting' },
    messageRevision: 2
  });
  const [updatedItem] = projector.applyEvent(updatedEvent);
  expect(updatedItem).toEqual({
    kind: 'upsert',
    cursor: updatedEvent.id,
    item: { ...expectedStreaming, parts: [{ type: 'text', text: 'Still drafting' }] }
  });

  const completedEvent = completed(withoutRelation);
  const [completedItem] = projector.applyEvent(completedEvent);
  expect(completedItem).toEqual({ kind: 'upsert', cursor: completedEvent.id, item: expectedDone });
});

test('resolves only active in-session UI messages in request order without mutating the timeline', async () => {
  const handlers = buildHandlers(mockModel(['unused']));
  const { sessionId } = await handlers.session.create({ title: 'reply targets' });
  const createdAt = '2026-07-21T00:00:00.000Z';
  const activeIds = Array.from({ length: 101 }, () => newId('msg'));
  for (const [index, id] of activeIds.entries()) {
    handlers.store.insertMessage(
      id,
      sessionId,
      `active ${index}`,
      new Date(Date.parse(createdAt) + index).toISOString(),
      'assistant'
    );
  }
  const inactiveId = newId('msg');
  handlers.store.insertMessage(inactiveId, sessionId, 'inactive', createdAt, 'assistant');
  handlers.store.removeMessage({
    transcriptTargetId: sessionId,
    messageId: inactiveId,
    idempotencyKey: newId('idem'),
    fingerprint: 'resolve-ui-messages:inactive:v1',
    updatedAt: createdAt
  });
  const { sessionId: otherSessionId } = await handlers.session.create({ title: 'other' });
  const crossTranscriptId = newId('msg');
  handlers.store.insertMessage(crossTranscriptId, otherSessionId, 'cross transcript', createdAt, 'assistant');
  const missingId = newId('msg');
  const before = await handlers.session.uiItems({ id: sessionId });
  const [firstId, secondId, ...remainingIds] = activeIds;
  if (!firstId || !secondId) throw new Error('expected active message ids');
  const requestIds = [secondId, firstId, secondId, ...remainingIds];
  const expectedIds = [secondId, firstId, ...remainingIds.slice(0, 98)];

  expect(resolveUiMessagesRequestSchema.safeParse({ messageIds: requestIds }).success).toBe(false);

  const resolveUiMessages = (
    handlers.session as unknown as {
      resolveUiMessages: (input: { id: SessionId; messageIds: ChatMessage['id'][] }) => Promise<{ items: UIItem[] }>;
    }
  ).resolveUiMessages;
  const capped = await resolveUiMessages({ id: sessionId, messageIds: requestIds });
  expect(capped.items.map((item) => item.id)).toEqual(expectedIds);

  const unavailable = await resolveUiMessages({
    id: sessionId,
    messageIds: [firstId, inactiveId, crossTranscriptId, missingId]
  });
  expect(unavailable.items.map((item) => item.id)).toEqual([firstId]);
  expect((await handlers.session.uiItems({ id: sessionId })).items).toEqual(before.items);
  handlers.store.close();
});

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

test('projects canonical clarification messages through the normal message path', () => {
  const message: ChatMessage = {
    ...liveMessage(
      'msg_questionv000',
      'assistant',
      'Which path?',
      {
        requestId: 'clarify_1',
        question: 'Which path?',
        options: ['Ship', 'Revise'],
        mode: 'single',
        allowOther: true,
        status: 'pending'
      },
      '2026-07-21T00:00:00.000Z'
    ),
    type: 'clarify'
  };
  const expected = {
    kind: 'message' as const,
    id: message.id,
    role: 'assistant' as const,
    parts: [{ type: 'artifact' as const, messageType: 'clarify', text: message.text, data: message.data }],
    replyable: false,
    status: 'streaming' as const,
    seq: message.createdAt
  };
  const hydrated = new SessionUiProjector();
  hydrated.hydrateMessages([message]);
  const snapshot = hydrated.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');

  expect(snapshot.items).toEqual([expected]);
  const createdMessageEvent = created(message);
  const liveFromKnownEvent = new SessionUiProjector();
  const [knownCreatedEvent] = liveFromKnownEvent.applyEvent(createdMessageEvent);
  expect(knownCreatedEvent).toEqual({ kind: 'upsert', cursor: createdMessageEvent.id, item: expected });
});

test('correlated project answers complete one question message in hydration and live events', () => {
  const questionMessage = {
    ...liveMessage(
      'msg_questionv001',
      'assistant',
      'Q: Which path?\nOptions: Ship | Revise',
      { agentName: 'Lily', kind: 'project-qa', question: 'Which path?', options: ['Ship', 'Revise'] },
      '2026-07-21T00:00:00.000Z'
    ),
    stream: { status: 'complete' as const }
  };
  const summaryMessage: ChatMessage = {
    id: 'msg_summaryv0010',
    sessionId,
    role: 'system',
    text: 'Project Q&A summary:\nAsked by: Lily\nQuestion: Which path?\nOptions: Ship | Revise\nUser answer: Ship\n\nUse this as shared project context.',
    type: 'text',
    data: {
      source: 'managed-mesh-agent-question',
      requestId: 'clarify_1',
      questionMessageId: questionMessage.id,
      askerName: 'Lily',
      question: 'Which path?',
      options: ['Ship', 'Revise'],
      answer: 'Ship'
    },
    stream: { status: 'complete' },
    active: true,
    createdAt: '2026-07-21T00:01:00.000Z'
  };
  const expectedItem = {
    kind: 'message' as const,
    id: questionMessage.id,
    role: 'assistant' as const,
    agentName: 'Lily',
    parts: [{ type: 'text' as const, text: questionMessage.text }],
    question: { question: 'Which path?', options: ['Ship', 'Revise'], answer: 'Ship' },
    replyable: true,
    status: 'done' as const,
    seq: questionMessage.createdAt
  };

  const hydrated = new SessionUiProjector();
  hydrated.hydrateMessages([questionMessage, summaryMessage]);
  const hydratedSnapshot = hydrated.snapshot();
  if (hydratedSnapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(hydratedSnapshot.items).toEqual([expectedItem]);

  const live = new SessionUiProjector();
  live.applyEvent(created(questionMessage));
  const [answerUpdate] = live.applyEvent(created(summaryMessage, { kind: 'system', subsystem: 'project-qa' }));
  expect(answerUpdate).toEqual({
    kind: 'upsert',
    cursor: expect.any(String),
    item: expectedItem
  });
  const liveSnapshot = live.snapshot();
  if (liveSnapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(liveSnapshot.items).toEqual([expectedItem]);
});

test('a paged project answer reconstructs its completed question without the earlier wall', () => {
  const projector = new SessionUiProjector();
  projector.hydrateMessages([
    {
      id: 'msg_summaryv0020',
      sessionId,
      role: 'system',
      text: 'Project Q&A summary:\nAsked by: Lily\nQuestion: Which path?\nOptions: Ship | Revise\nUser answer: Ship',
      type: 'text',
      data: {
        source: 'managed-mesh-agent-question',
        requestId: 'clarify_2',
        questionMessageId: 'msg_questionv002',
        askerName: 'Lily',
        question: 'Which path?',
        options: ['Ship', 'Revise'],
        answer: 'Ship'
      },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-07-21T00:02:00.000Z'
    }
  ]);

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items).toEqual([
    {
      kind: 'message',
      id: 'msg_questionv002',
      role: 'assistant',
      agentName: 'Lily',
      parts: [{ type: 'text', text: 'Q: Which path?\nOptions: Ship | Revise' }],
      question: { question: 'Which path?', options: ['Ship', 'Revise'], answer: 'Ship' },
      replyable: false,
      status: 'done',
      seq: '2026-07-21T00:02:00.000Z'
    }
  ]);
});

test('hydrates canonical clarification answers once as normal user messages', () => {
  const projector = new SessionUiProjector();
  projector.hydrateMessages([
    {
      id: 'msg_question00000',
      sessionId,
      role: 'assistant',
      text: 'Which path should I take?',
      type: 'clarify',
      data: {
        requestId: 'clarify_1',
        question: 'Which path should I take?',
        options: ['Ship', 'Revise'],
        mode: 'single',
        allowOther: true,
        status: 'answered'
      },
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-07-20T20:21:00.000Z'
    },
    {
      id: 'msg_answer000000',
      sessionId,
      role: 'user',
      text: 'Ship',
      type: 'text',
      replyToMessageId: 'msg_question00000',
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-07-20T20:26:36.001Z'
    }
  ]);

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items).toEqual([
    {
      kind: 'message',
      id: 'msg_question00000',
      role: 'assistant',
      parts: [
        {
          type: 'artifact',
          messageType: 'clarify',
          text: 'Which path should I take?',
          data: {
            requestId: 'clarify_1',
            question: 'Which path should I take?',
            options: ['Ship', 'Revise'],
            mode: 'single',
            allowOther: true,
            status: 'answered'
          }
        }
      ],
      replyable: true,
      status: 'done',
      seq: '2026-07-20T20:21:00.000Z'
    },
    {
      kind: 'message',
      id: 'msg_answer000000',
      role: 'user',
      parts: [{ type: 'text', text: 'Ship' }],
      replyToMessageId: 'msg_question00000',
      replyable: true,
      status: 'done',
      seq: '2026-07-20T20:26:36.001Z'
    }
  ]);
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
    replyable: true,
    status: 'done',
    seq: message.createdAt
  });
});

// realtime-channels.md documents no ordering guarantee across the control/generation/ui-projection
// planes, and requires that durable history stay authoritative regardless of what a client saw live.
// The daemon's own merge point for that guarantee is SessionUiProjector. This test drives the two
// literal orderings the doc's race describes for the SAME underlying round — "generation-plane-first"
// (every delta arrives before the control-plane terminal event, the ordinary live-viewer case) and
// "control-plane-first" (the terminal event arrives before any delta is ever seen, e.g. a client that
// only subscribed to control and reconnects to ui-stream after settlement, or two lagging deltas that
// arrive AFTER completion) — and asserts the two projectors end up in a byte-identical final state.
function projectorFinalSnapshotItems(projector: SessionUiProjector) {
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot');
  return snapshot.items;
}

test('control-plane-first vs generation-plane-first delivery of the same round converge to an identical final projection', () => {
  const message: ChatMessage = {
    id: 'msg_200000000000',
    sessionId,
    role: 'assistant',
    text: '',
    type: 'text',
    data: { agentName: 'codex' },
    stream: { status: 'pending' },
    active: true,
    createdAt: '2026-07-18T00:00:00.000Z'
  };
  const createdEvent = event('session.message.created', {
    transcriptTargetId: sessionId,
    producer: agentProducer,
    message,
    messageRevision: 1
  });
  const delta0 = event('session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer: agentProducer,
    messageId: message.id,
    channel: 'content',
    index: 0,
    delta: 'Hel'
  });
  const delta1 = event('session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer: agentProducer,
    messageId: message.id,
    channel: 'content',
    index: 1,
    delta: 'lo world'
  });
  const completedEvent = event('session.message.completed', {
    transcriptTargetId: sessionId,
    producer: agentProducer,
    message: { ...message, text: 'Hello world', stream: { status: 'complete' } },
    messageRevision: 3
  });

  // Generation-plane-first: created → delta0 → delta1 → completed (the ordinary live-viewer order).
  const generationFirst = new SessionUiProjector();
  generationFirst.applyEvent(createdEvent);
  generationFirst.applyEvent(delta0);
  generationFirst.applyEvent(delta1);
  generationFirst.applyEvent(completedEvent);

  // Control-plane-first: created → completed → late delta0 → late delta1 (the terminal event settles
  // the message BEFORE either delta is ever seen — the literal race the doc warns has no ordering
  // guarantee, and the exact shape of the real bug found while building this test: a delta arriving
  // after settlement, at ANY index including 0, must never reopen or mutate the settled item).
  const controlFirst = new SessionUiProjector();
  controlFirst.applyEvent(createdEvent);
  controlFirst.applyEvent(completedEvent);
  const lateDelta0Effects = controlFirst.applyEvent(delta0);
  const lateDelta1Effects = controlFirst.applyEvent(delta1);

  // Both late deltas are pure no-ops once settled — nothing to forward to a live subscriber.
  expect(lateDelta0Effects).toEqual([]);
  expect(lateDelta1Effects).toEqual([]);

  // The two orderings converge to an identical final projection: same items, same content, same
  // status, no duplicate or reopened entries either way.
  expect(projectorFinalSnapshotItems(controlFirst)).toEqual(projectorFinalSnapshotItems(generationFirst));

  const finalItem = projectorFinalSnapshotItems(generationFirst).find((item) => item.kind === 'message');
  if (finalItem?.kind !== 'message') throw new Error('expected a settled message item');
  expect(finalItem).toMatchObject({ status: 'done', parts: [{ type: 'text', text: 'Hello world' }] });
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

test('removes a reasoning-only assistant placeholder when a tool call starts and after canonical completion', () => {
  const projector = new SessionUiProjector();
  const beforeTool = liveMessage('msg_100000000000', 'assistant', '');
  projector.applyEvent(created(beforeTool));
  projector.applyEvent(delta(beforeTool.id, 'I will use a tool.', 0, 'reasoning'));

  const toolCalled = projector.applyEvent(
    event('tool.called', { toolCallId: 'call_1', tool: 'file_write', input: { path: 'test.md' } })
  );
  expect(toolCalled).toEqual([
    {
      kind: 'remove',
      cursor: expect.any(String),
      target: { kind: 'message', id: beforeTool.id }
    },
    {
      kind: 'upsert',
      cursor: expect.any(String),
      item: {
        kind: 'tool',
        id: 'call_1',
        tool: 'file_write',
        input: { path: 'test.md' },
        status: 'running',
        seq: expect.any(String)
      }
    }
  ]);
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
  expect(snapshot.items).toEqual([
    {
      kind: 'tool',
      id: 'call_1',
      tool: 'file_write',
      input: { path: 'test.md' },
      output: 'wrote test.md',
      status: 'ok',
      seq: expect.any(String)
    },
    {
      kind: 'message',
      id: afterTool.id,
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'The file was written.' },
        { type: 'text', text: 'Done.' }
      ],
      replyable: true,
      status: 'done',
      seq: afterTool.createdAt
    }
  ]);
});

test('hydrates tool calls without their reasoning-only assistant placeholders', () => {
  const projector = new SessionUiProjector();
  const beforeTool: ChatMessage = {
    ...liveMessage('msg_100000000000', 'assistant', '', { reasoning: 'I will use a tool.' }),
    stream: { status: 'complete' }
  };
  const toolCall: ChatMessage = {
    ...liveMessage('msg_200000000000', 'assistant', JSON.stringify({ tool: 'file_write' })),
    type: 'tool_call',
    data: { toolCallId: 'call_1', toolName: 'file_write', input: { path: 'test.md' } },
    stream: { status: 'settled' }
  };
  const toolResult: ChatMessage = {
    ...liveMessage('msg_300000000000', 'assistant', 'wrote test.md'),
    role: 'tool',
    type: 'tool_result',
    data: { toolCallId: 'call_1', toolName: 'file_write', output: 'wrote test.md', ok: true },
    stream: { status: 'settled' }
  };

  projector.hydrateMessages([beforeTool, toolCall, toolResult]);

  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snapshot.items).toEqual([
    {
      kind: 'tool',
      id: 'call_1',
      tool: 'file_write',
      input: { path: 'test.md' },
      output: 'wrote test.md',
      status: 'ok',
      seq: toolCall.createdAt
    }
  ]);
});

test('keeps assistant text that precedes a tool call in live and hydrated projections', () => {
  const beforeAt = '2026-07-28T12:00:00.000Z';
  const toolAt = '2026-07-28T12:00:01.000Z';
  const beforeTool: ChatMessage = {
    ...liveMessage(
      'msg_100000000000',
      'assistant',
      'I will save the file.',
      { reasoning: 'Use file_write.' },
      beforeAt
    ),
    stream: { status: 'complete' }
  };
  const toolCall: ChatMessage = {
    ...liveMessage('msg_200000000000', 'assistant', JSON.stringify({ tool: 'file_write' }), undefined, toolAt),
    type: 'tool_call',
    data: { toolCallId: 'call_1', toolName: 'file_write', input: { path: 'test.md' } },
    stream: { status: 'settled' }
  };

  const live = new SessionUiProjector();
  live.applyEvent(created({ ...beforeTool, text: '', stream: { status: 'pending' } }));
  live.applyEvent(delta(beforeTool.id, 'I will save the file.', 0));
  live.applyEvent(
    event('tool.called', { toolCallId: 'call_1', tool: 'file_write', input: { path: 'test.md' } }, toolAt)
  );
  const liveSnapshot = live.snapshot();
  if (liveSnapshot.kind !== 'snapshot') throw new Error('expected snapshot');

  const hydrated = new SessionUiProjector();
  hydrated.hydrateMessages([beforeTool, toolCall]);
  const hydratedSnapshot = hydrated.snapshot();
  if (hydratedSnapshot.kind !== 'snapshot') throw new Error('expected snapshot');

  const expectedMessage = {
    kind: 'message',
    id: beforeTool.id,
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'Use file_write.' },
      { type: 'text', text: 'I will save the file.' }
    ],
    replyable: true,
    status: 'done',
    seq: beforeTool.createdAt
  } satisfies UIItem;
  const expectedTool = {
    kind: 'tool',
    id: 'call_1',
    tool: 'file_write',
    input: { path: 'test.md' },
    status: 'running',
    seq: toolAt
  } satisfies UIItem;
  expect(liveSnapshot.items).toEqual([
    {
      ...expectedMessage,
      replyable: false
    },
    expectedTool
  ]);
  expect(hydratedSnapshot.items).toEqual([expectedMessage, expectedTool]);
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
  // A reused messageId starting a brand-new streaming round must be signaled by an explicit canonical
  // created/updated event (which resets status to pending/streaming) — never inferred from a delta's
  // own index. A delta cannot restart a settled message on its own; see the late-delta tests below.
  const restartMessage: ChatMessage = { ...message, text: '', stream: { status: 'pending' } };
  projector.applyEvent(
    event('session.message.updated', {
      transcriptTargetId: sessionId,
      producer: agentProducer,
      message: restartMessage,
      messageRevision: 2
    })
  );
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
    source: 'managed-mesh-agent'
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

test('drops the legacy persisted managed MeshAgent "Thinking" reasoning row on refresh', () => {
  // The daemon no longer projects MeshAgent presentation, and the experience derives the
  // streaming/"thinking" indicator from stream status. A persisted managed-mesh-agent row still carries a
  // legacy hard-coded `reasoning: 'Thinking'`; hydration must neutralize it to a plain text part so the
  // daemon never re-leaks that presentation copy from history.
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
        source: 'managed-mesh-agent',
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
    {
      kind: 'message',
      id: 'msg_thinking0000',
      role: 'assistant',
      agentName: 'pmem_codex_reviewer',
      agentDisplayName: 'Reviewer',
      source: 'managed-mesh-agent',
      parts: [{ type: 'text', text: '' }],
      replyable: false,
      status: 'streaming',
      seq: '2026-06-24T00:00:00.000Z'
    }
  ]);
});

test('neutralizes managed-mesh-agent reasoning yet keeps generic assistant reasoning parts', () => {
  const meshMessage: ChatMessage = {
    ...liveMessage(
      'msg_meshreason00',
      'assistant',
      'looks good',
      { source: 'managed-mesh-agent', agentName: 'codex', reasoning: 'Thinking' },
      '2026-07-21T00:00:00.000Z'
    ),
    stream: { status: 'complete' }
  };
  const genericMessage: ChatMessage = {
    ...liveMessage('msg_genreason000', 'assistant', 'hello', { reasoning: 'let me think' }, '2026-07-21T00:01:00.000Z'),
    stream: { status: 'complete' }
  };

  const projector = new SessionUiProjector();
  projector.hydrateMessages([meshMessage, genericMessage]);
  const snapshot = projector.snapshot();
  if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot');

  // Mesh reply: a single neutral text part, NO reasoning part. Control reply: reasoning still surfaces —
  // the neutralization is source-scoped, not a blanket removal.
  expect(snapshot.items).toEqual([
    {
      kind: 'message',
      id: 'msg_meshreason00',
      role: 'assistant',
      agentName: 'codex',
      source: 'managed-mesh-agent',
      parts: [{ type: 'text', text: 'looks good' }],
      replyable: true,
      status: 'done',
      seq: '2026-07-21T00:00:00.000Z'
    },
    {
      kind: 'message',
      id: 'msg_genreason000',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'let me think' },
        { type: 'text', text: 'hello' }
      ],
      replyable: true,
      status: 'done',
      seq: '2026-07-21T00:01:00.000Z'
    }
  ]);
});

test('hydrates MeshAgent provider errors without breaking the UI stream', () => {
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
        meshSessionId: 'mesh_provider5wxW',
        deliveryId: 'deliv_providerotf8',
        source: 'mesh-agent-provider'
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
      source: 'mesh-agent-provider',
      meshSessionId: 'mesh_provider5wxW',
      deliveryId: 'deliv_providerotf8',
      status: 'error',
      parts: [{ type: 'text', text: 'thread not found: 019f30a7-ddaf-7062-9f89-f3fd90b5397c' }]
    })
  ]);
});

test('managed MeshAgent completion moves live order to completion time', () => {
  const projector = new SessionUiProjector();
  const startedAt = '2026-06-24T00:00:01.000Z';
  const completedAt = '2026-06-24T00:00:09.000Z';
  const message = liveMessage(
    'msg_CLI000000000',
    'assistant',
    '',
    { agentName: 'codex', source: 'managed-mesh-agent' },
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

test('managed MeshAgent message projections retain delivery observation pointers', () => {
  const deliveryId = newId('deliv');
  const live = new SessionUiProjector();
  const message = liveMessage('msg_CLI000000000', 'assistant', '', {
    agentName: 'codex',
    meshSessionId: 'mesh_codex0000000',
    deliveryId,
    source: 'managed-mesh-agent'
  });
  live.applyEvent(created(message));
  const [settled] = live.applyEvent(completed({ ...message, text: 'done' }));

  expect(settled?.kind === 'upsert' && settled.item.kind === 'message' ? settled.item : undefined).toMatchObject({
    meshSessionId: 'mesh_codex0000000',
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
        meshSessionId: 'mesh_codex0000000',
        deliveryId,
        source: 'managed-mesh-agent'
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
    meshSessionId: 'mesh_codex0000000',
    deliveryId
  });
});

test('live user messages keep chronological order before later managed MeshAgent replies', () => {
  const projector = new SessionUiProjector();
  const user = liveMessage('msg_USER00000000', 'user', 'hi all', undefined, '2026-06-24T10:00:00.000Z');
  const reply = liveMessage(
    'msg_CLI000000000',
    'assistant',
    '',
    { agentName: 'claude', source: 'managed-mesh-agent' },
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
      questions: [
        {
          id: 'scope',
          question: 'Which scope?',
          options: ['All'],
          mode: 'single',
          allowOther: true
        },
        {
          id: 'targets',
          question: 'Which targets?',
          options: ['Codex', 'Claude'],
          mode: 'multiple',
          allowOther: false
        }
      ],
      questionMessageId: 'msg_QUESTION0000',
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
      questions: [
        {
          id: 'scope',
          question: 'Which scope?',
          options: ['All'],
          mode: 'single',
          allowOther: true
        },
        {
          id: 'targets',
          question: 'Which targets?',
          options: ['Codex', 'Claude'],
          mode: 'multiple',
          allowOther: false
        }
      ],
      options: ['Ship it', 'Revise it'],
      mode: 'single',
      allowOther: true,
      asker: { id: 'pmem_codex_1', name: 'Lily' }
    }
  });

  expect(
    projector.applyEvent(
      event('clarify.resolved', {
        requestId: 'clarify_1',
        answer: 'Ship it',
        questionMessageId: 'msg_QUESTION0000',
        answerMessageId: 'msg_answer000000'
      })
    )
  ).toEqual([expect.objectContaining({ kind: 'remove', target: { kind: 'clarification', id: 'clarify_1' } })]);
});

test('projects URL elicitation completion metadata into the live clarification item', () => {
  const projector = new SessionUiProjector();
  const [added] = projector.applyEvent(
    event('clarify.requested', {
      requestId: 'clarify_url',
      question: 'Authorize access',
      questionMessageId: 'msg_QUESTION0000',
      urlElicitation: {
        url: 'https://example.com/authorize',
        origin: 'https://example.com'
      }
    })
  );

  if (added?.kind !== 'upsert' || added.item.kind !== 'clarification') {
    throw new Error('expected URL clarification upsert');
  }
  expect(added.item).toEqual({
    kind: 'clarification',
    id: 'clarify_url',
    question: 'Authorize access',
    urlElicitation: {
      url: 'https://example.com/authorize',
      origin: 'https://example.com'
    },
    seq: added.item.seq
  });
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

test('a managed MeshAgent wall reply projects its settled text through the message path', () => {
  const p = new SessionUiProjector();
  p.applyEvent(created(liveMessage('msg_U00000000000', 'user', 'please review'), { kind: 'user' }));
  const reply = liveMessage('msg_R00000000000', 'assistant', '', {
    agentName: 'codex',
    source: 'managed-mesh-agent'
  });
  p.applyEvent(created(reply));
  p.applyEvent(delta(reply.id, 'Thinking', 0, 'reasoning'));
  p.applyEvent(
    completed({
      ...reply,
      text: 'looks good to me',
      data: { agentName: 'codex', source: 'managed-mesh-agent' }
    })
  );
  const snap = p.snapshot();
  if (snap.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(snap.items.map((i) => `${i.kind}:${i.id}`)).toEqual(['message:msg_U00000000000', 'message:msg_R00000000000']);
  const replyItem = snap.items.find((i) => i.id === 'msg_R00000000000');
  if (replyItem?.kind !== 'message') throw new Error('expected reply message');
  expect(replyItem.status).toBe('done');
  expect(replyItem.agentName).toBe('codex');
  expect(replyItem.parts.find((x) => x.type === 'text')).toMatchObject({ text: 'looks good to me' });
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
