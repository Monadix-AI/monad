import type { Event, MessageId, MessageProducer, SessionId } from '@monad/protocol';
import type { ModelChunk, ModelMessage, ModelResult } from '#/agent/index.ts';

import { expect, test } from 'bun:test';
import { messageIdSchema, newId } from '@monad/protocol';

import {
  AgentLoop,
  createAgent,
  type ImageAttachment,
  InMemoryMessageRepo,
  type MessageRepo,
  type ModelRouter
} from '#/agent/index.ts';
import { noCredentialsError } from '#/agent/model/gateway/gateway-routing.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createMessageIngress, messageIdempotencyKey } from '#/services/messages/ingress.ts';
import { createStore } from '#/store/db/index.ts';
import { buildMockModel } from '../../fixtures/mock-model.ts';

function mockModel(deltas: string[]): ModelRouter {
  return buildMockModel().text(deltas).build();
}

function eventMessage(event: Event | undefined): { id?: MessageId; text?: string; data?: unknown } | undefined {
  return (event?.payload as { message?: { id?: MessageId; text?: string; data?: unknown } } | undefined)?.message;
}

function harness(deltas: string[]) {
  const events: Event[] = [];
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({
    model: mockModel(deltas),
    tools: [],
    messages,
    defaultModel: 'mock',
    emit: (e) => events.push(e)
  });
  return { loop, events, messages };
}

function ingressBackedRepo(
  store: ReturnType<typeof createStore>,
  ingress: ReturnType<typeof createMessageIngress>,
  producer: MessageProducer
): MessageRepo {
  return {
    publishesCanonicalEvents: true,
    list: (sessionId) => store.listMessages(sessionId),
    append: async (message) => {
      await ingress.commit({
        message: {
          id: messageIdSchema.parse(message.id),
          sessionId: message.sessionId,
          role: message.role,
          text: message.text,
          type: message.type ?? 'text',
          ...(message.data === undefined ? {} : { data: message.data }),
          ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
          stream: { status: message.role === 'user' ? 'settled' : 'complete' },
          active: true,
          createdAt: message.createdAt
        },
        idempotencyKey: messageIdempotencyKey('reasoning-test', 'append', message.id),
        producer
      });
    },
    open: async (message) => {
      await ingress.commit({
        message: {
          id: messageIdSchema.parse(message.id),
          sessionId: message.sessionId,
          role: message.role,
          text: message.text,
          type: message.type ?? 'text',
          ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
          stream: {
            status: 'pending',
            source: { transcriptTargetId: message.sessionId, messageId: messageIdSchema.parse(message.id) }
          },
          active: true,
          createdAt: message.createdAt
        },
        idempotencyKey: messageIdempotencyKey('reasoning-test', 'open', message.id),
        producer
      });
    },
    appendDelta: (input) =>
      ingress.append({
        transcriptTargetId: input.sessionId,
        messageId: messageIdSchema.parse(input.messageId),
        producer,
        channel: input.channel,
        index: input.index,
        delta: input.delta
      }),
    settle: async (message) => {
      if (!store.getMessage(message.sessionId, message.id)) return false;
      await ingress.settle({
        transcriptTargetId: message.sessionId,
        messageId: messageIdSchema.parse(message.id),
        idempotencyKey: messageIdempotencyKey('reasoning-test', 'settle', message.id),
        producer,
        text: message.text,
        data: message.data
      });
      return true;
    }
  };
}

test('runStream emits ordered canonical deltas then one completed message', async () => {
  const deltas = ['Hel', 'lo', ' world'];
  const { loop, events, messages } = harness(deltas);
  const sessionId = newId('ses') as SessionId;

  await loop.runStream(sessionId, 'hi');

  const tokens = events.filter((e) => e.type === 'session.message.delta.appended' && e.payload.channel === 'answer');
  const finals = events.filter((e) => e.type === 'session.message.completed');
  expect(tokens.map((e) => e.payload.delta)).toEqual(deltas);
  expect(tokens.map((e) => e.payload.index)).toEqual([0, 1, 2]);
  expect(tokens.map((e) => e.payload.producer)).toEqual([
    { kind: 'system', subsystem: 'agent-loop' },
    { kind: 'system', subsystem: 'agent-loop' },
    { kind: 'system', subsystem: 'agent-loop' }
  ]);
  expect(finals).toHaveLength(1);
  expect(finals[0]?.payload.producer).toEqual({ kind: 'system', subsystem: 'agent-loop' });
  expect(eventMessage(finals[0])?.text).toBe('Hello world');

  // tokens and the final message share one messageId
  const msgId = eventMessage(finals[0])?.id;
  expect(tokens.every((e) => e.payload.messageId === msgId)).toBe(true);

  // history: user turn + persisted assistant turn
  const history = messages.list(sessionId);
  expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(history[1]?.text).toBe('Hello world');
});

test('runStream persists safe attachment presentation separately from model input text', async () => {
  const { loop, messages } = harness(['ok']);
  const sessionId = newId('ses') as SessionId;
  const modelText = 'Review this.\n\n<attachments>\nAttachment 1: diagram.png\n</attachments>';
  const attachment = {
    id: 'att_01ABC0000000' as const,
    name: 'diagram.png',
    mime: 'image/png',
    bytes: 4321,
    createdAt: '2026-07-19T00:00:00.000Z'
  };

  await loop.runStream(sessionId, modelText, undefined, undefined, {
    data: { attachments: [attachment] },
    text: 'Review this.'
  });

  expect(messages.list(sessionId)[0]).toMatchObject({
    role: 'user',
    text: 'Review this.',
    data: {
      attachments: [attachment],
      modelInput: { kind: 'attachments', text: modelText }
    }
  });
});

test('runStream preserves an explicit user reply without linking the generated answer', async () => {
  const { loop, messages } = harness(['answer']);
  const sessionId = newId('ses') as SessionId;
  const selectedMessageId = newId('msg');

  await loop.runStream(sessionId, 'follow up', undefined, undefined, undefined, {
    replyToMessageId: selectedMessageId
  });

  const [user, answer] = messages.list(sessionId);
  if (!user || !answer) throw new Error('expected the persisted user and answer messages');
  expect({ userReplyTo: user.replyToMessageId, answerReplyTo: answer.replyToMessageId }).toEqual({
    userReplyTo: selectedMessageId,
    answerReplyTo: undefined
  });
});

test('runStream keeps the generated answer linked when project fanout is active', async () => {
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({
    model: mockModel(['answer']),
    tools: [],
    messages,
    defaultModel: 'mock',
    emit: () => {},
    linkAssistantReplies: true
  });
  const sessionId = newId('ses') as SessionId;

  await loop.runStream(sessionId, 'project message');

  const [user, answer] = messages.list(sessionId);
  if (!user || !answer) throw new Error('expected the persisted user and answer messages');
  expect(answer.replyToMessageId).toBe(messageIdSchema.parse(user.id));
});

test('runStreamFromHistory generates an assistant response without appending another user message', async () => {
  const { loop, messages } = harness(['Alternative response']);
  const sessionId = newId('ses') as SessionId;
  await messages.append({
    createdAt: new Date().toISOString(),
    id: newId('msg'),
    role: 'user',
    sessionId,
    text: 'Try this approach'
  });

  await loop.runStreamFromHistory(sessionId);

  expect(messages.list(sessionId).map(({ role, text }) => ({ role, text }))).toEqual([
    { role: 'user', text: 'Try this approach' },
    { role: 'assistant', text: 'Alternative response' }
  ]);
});

test('runStreamFromHistory leaves its generated answer unlinked', async () => {
  const { loop, messages } = harness(['Alternative response']);
  const sessionId = newId('ses') as SessionId;
  const firstUserId = newId('msg');
  const trailingUserId = newId('msg');
  await messages.append({
    createdAt: new Date().toISOString(),
    id: firstUserId,
    role: 'user',
    sessionId,
    text: 'Original question'
  });
  await messages.append({
    createdAt: new Date().toISOString(),
    id: newId('msg'),
    role: 'assistant',
    sessionId,
    text: 'Earlier answer'
  });
  await messages.append({
    createdAt: new Date().toISOString(),
    id: trailingUserId,
    role: 'user',
    sessionId,
    text: 'Try this approach instead'
  });

  await loop.runStreamFromHistory(sessionId);

  const answer = messages.list(sessionId).at(-1);
  expect({ role: answer?.role, replyToMessageId: answer?.replyToMessageId, text: answer?.text }).toEqual({
    role: 'assistant',
    replyToMessageId: undefined,
    text: 'Alternative response'
  });
});

test('runBlock returns the full assistant message and emits one canonical completion', async () => {
  const { loop, events, messages } = harness(['Hello', ' world']);
  const sessionId = newId('ses') as SessionId;

  const message = await loop.runBlock(sessionId, 'hi');

  expect(message.role).toBe('assistant');
  expect(message.text).toBe('Hello world');
  expect(events.filter((e) => e.type === 'session.message.completed')).toHaveLength(1);
  expect(messages.list(sessionId).map((m) => m.role)).toEqual(['user', 'assistant']);
});

test('runBlock preserves an explicit user reply without linking the generated answer', async () => {
  const { loop, messages } = harness(['Hello']);
  const sessionId = newId('ses') as SessionId;
  const selectedMessageId = newId('msg');

  const answer = await loop.runBlock(sessionId, 'follow up', undefined, undefined, {
    replyToMessageId: selectedMessageId
  });
  const [user] = messages.list(sessionId);
  if (!user) throw new Error('expected the persisted user message');
  expect({ userReplyTo: user.replyToMessageId, answerReplyTo: answer.replyToMessageId }).toEqual({
    userReplyTo: selectedMessageId,
    answerReplyTo: undefined
  });
});

test('streamed tool-separated answer segments and internal rows omit reply relations', async () => {
  const messages = new InMemoryMessageRepo();
  const sessionId = newId('ses') as SessionId;
  let modelCall = 0;
  const model: ModelRouter = {
    async *stream() {
      if (modelCall++ === 0) {
        yield { type: 'text' as const, token: 'Before tool.' };
        yield {
          type: 'tool-call' as const,
          call: { toolCallId: 'call_reply_test', toolName: 'test.echo', input: {} }
        };
        return;
      }
      yield { type: 'text' as const, token: 'After tool.' };
    },
    async complete() {
      return { finishReason: 'stop' as const, text: 'unused' };
    }
  };
  const loop = new AgentLoop({
    model,
    tools: [
      {
        name: 'test.echo',
        description: 'echo',
        scopes: [],
        async run() {
          return { metadata: 'ok', modelContent: 'ok' };
        }
      }
    ],
    messages,
    defaultModel: 'mock',
    emit: () => {}
  });

  await loop.runStream(sessionId, 'use a tool');

  const history = messages.list(sessionId);
  const visibleAnswers = history.filter((message) => message.role === 'assistant' && !message.type);
  const internalRows = history.filter((message) => message.type === 'tool_call' || message.type === 'tool_result');
  expect({
    answerReplyTargets: visibleAnswers.map((message) => message.replyToMessageId),
    internalReplyTargets: internalRows.map((message) => message.replyToMessageId),
    text: visibleAnswers.map((message) => message.text)
  }).toEqual({
    answerReplyTargets: [undefined, undefined],
    internalReplyTargets: [undefined, undefined],
    text: ['Before tool.', 'After tool.']
  });
});

test('a later assistant segment remains unlinked after a user steer', async () => {
  const messages = new InMemoryMessageRepo();
  let modelCall = 0;
  let steerPending = true;
  const loop = new AgentLoop({
    model: {
      async *stream() {
        yield { type: 'text' as const, token: modelCall++ === 0 ? 'First answer.' : 'Steered answer.' };
      },
      async complete() {
        return { finishReason: 'stop' as const, text: 'unused' };
      }
    },
    tools: [],
    messages,
    defaultModel: 'mock',
    emit: () => {},
    steers: {
      close: () => {
        if (!steerPending) return [];
        steerPending = false;
        return [{ text: 'Use the revised direction.' }];
      },
      reopen: () => {},
      take: () => []
    }
  });
  const sessionId = newId('ses') as SessionId;

  await loop.runStream(sessionId, 'Initial direction.');

  const history = messages.list(sessionId);
  const laterAnswer = history.find((message) => message.role === 'assistant' && message.text === 'Steered answer.');
  if (!laterAnswer) throw new Error('expected the steered answer');
  expect(laterAnswer.replyToMessageId).toBeUndefined();
});

test('a reasoning-only streamed row omits a reply relation', async () => {
  const model = buildMockModel().reasoning(['thinking']).build();
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({ model, tools: [], messages, defaultModel: 'mock', emit: () => {} });
  const sessionId = newId('ses') as SessionId;

  await loop.runStream(sessionId, 'Think without answering.');

  const reasoning = messages.list(sessionId).at(-1);
  expect({
    data: reasoning?.data,
    replyToMessageId: reasoning?.replyToMessageId,
    text: reasoning?.text
  }).toEqual({
    data: { reasoning: 'thinking' },
    replyToMessageId: undefined,
    text: ''
  });
});

test('a reasoning-only row stays unlinked through Message Ingress open and settle', async () => {
  const store = createStore();
  const bus = new EventBus();
  const ingress = createMessageIngress({ store, bus, targetExists: () => true });
  const producer: MessageProducer = { kind: 'system', subsystem: 'agent-loop-test' };
  const repo = ingressBackedRepo(store, ingress, producer);
  const loop = new AgentLoop({
    model: buildMockModel().reasoning(['thinking']).build(),
    tools: [],
    messages: repo,
    defaultModel: 'mock',
    emit: () => {}
  });
  const sessionId = newId('ses') as SessionId;

  try {
    await loop.runStream(sessionId, 'Think without answering.');

    const reasoning = store.listMessages(sessionId).at(-1);
    expect({ replyToMessageId: reasoning?.replyToMessageId, stream: reasoning?.stream, text: reasoning?.text }).toEqual(
      {
        replyToMessageId: undefined,
        stream: { status: 'complete', source: undefined },
        text: ''
      }
    );
  } finally {
    store.close();
  }
});

test('Message Ingress preserves reasoning, answer, reasoning delta order on one canonical row', async () => {
  const store = createStore();
  const bus = new EventBus();
  const ingress = createMessageIngress({ store, bus, targetExists: () => true });
  const producer: MessageProducer = { kind: 'system', subsystem: 'agent-loop-test' };
  const sessionId = newId('ses') as SessionId;
  const events: Event[] = [];
  const dispose = bus.subscribe(sessionId, (event) => events.push(event));
  const loop = new AgentLoop({
    model: buildMockModel().reasoning(['before']).text(['answer']).reasoning(['after']).build(),
    tools: [],
    messages: ingressBackedRepo(store, ingress, producer),
    defaultModel: 'mock',
    emit: () => {}
  });

  try {
    await loop.runStream(sessionId, 'Show the ordered stream.');

    const deltas = events.filter((event) => event.type === 'session.message.delta.appended');
    expect(
      deltas.map((event) => ({
        channel: event.payload.channel,
        index: event.payload.index,
        delta: event.payload.delta
      }))
    ).toEqual([
      { channel: 'reasoning', index: 0, delta: 'before' },
      { channel: 'answer', index: 0, delta: 'answer' },
      { channel: 'reasoning', index: 1, delta: 'after' }
    ]);
    expect(deltas.map((event) => ({ messageId: event.payload.messageId, producer: event.payload.producer }))).toEqual([
      { messageId: deltas[0]?.payload.messageId, producer },
      { messageId: deltas[0]?.payload.messageId, producer },
      { messageId: deltas[0]?.payload.messageId, producer }
    ]);
    expect(store.listMessages(sessionId).find((message) => message.role === 'assistant')).toMatchObject({
      text: 'answer',
      data: { reasoning: 'beforeafter' },
      stream: { status: 'complete' }
    });
  } finally {
    dispose();
    store.close();
  }
});

test('an empty streamed answer leaves its final visible row unlinked', async () => {
  const { loop, messages } = harness([]);
  const sessionId = newId('ses') as SessionId;

  await loop.runStream(sessionId, 'produce no text');

  const [user, answer] = messages.list(sessionId);
  if (!user || !answer) throw new Error('expected the persisted user and empty answer messages');
  expect({
    text: answer.text,
    includeInContext: answer.includeInContext,
    replyToMessageId: answer.replyToMessageId
  }).toEqual({
    text: '',
    includeInContext: false,
    replyToMessageId: undefined
  });
});

test('a streamed error row omits a reply relation', async () => {
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({
    model: {
      async *stream(): AsyncIterable<ModelChunk> {
        yield* [];
        throw new Error('upstream failed');
      },
      async complete() {
        return { finishReason: 'stop' as const, text: 'unused' };
      }
    },
    tools: [],
    messages,
    defaultModel: 'mock',
    emit: () => {}
  });
  const sessionId = newId('ses') as SessionId;

  await expect(loop.runStream(sessionId, 'fail')).rejects.toThrow('upstream failed');

  const error = messages.list(sessionId).at(-1);
  expect({ replyToMessageId: error?.replyToMessageId, type: error?.type }).toEqual({
    replyToMessageId: undefined,
    type: 'error'
  });
});

test('runBlock passes the session reasoning effort to the model request', async () => {
  const seen: Array<string | undefined> = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      seen.push(req.params?.reasoningEffort);
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    generationParams: { reasoningEffort: 'high' },
    emit: () => {}
  } as ConstructorParameters<typeof AgentLoop>[0]);

  await loop.runBlock(newId('ses') as SessionId, 'hi');

  expect(seen).toEqual(['high']);
});

test('runStream surfaces reasoning deltas on a separate canonical channel', async () => {
  const model = buildMockModel().reasoning(['think a', 'think b']).text(['answer']).build();
  const events: Event[] = [];
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: (e) => events.push(e)
  });
  const sessionId = newId('ses') as SessionId;
  await loop.runStream(sessionId, 'hi');

  const reasoning = events.filter(
    (e) => e.type === 'session.message.delta.appended' && e.payload.channel === 'reasoning'
  );
  expect(reasoning.map((e) => e.payload.delta)).toEqual(['think a', 'think b']);
  expect(reasoning.map((e) => e.payload.index)).toEqual([0, 1]);
  // Reasoning is NOT mixed into the answer tokens or the persisted message text.
  const tokenText = events
    .filter((e) => e.type === 'session.message.delta.appended' && e.payload.channel === 'answer')
    .map((e) => e.payload.delta)
    .join('');
  expect(tokenText).toBe('answer');
  const msg = events.find((e) => e.type === 'session.message.completed');
  expect(eventMessage(msg)?.text).toBe('answer');
});

test('runStream persists the reasoning trace on the assistant message (durable, not just transient)', async () => {
  const model = buildMockModel().reasoning(['think a', 'think b']).text(['answer']).build();
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({ model, tools: [], messages, defaultModel: 'mock', emit: () => {} });
  const sessionId = newId('ses') as SessionId;
  await loop.runStream(sessionId, 'hi');

  const persisted = (await messages.list(sessionId)).find((m) => m.role === 'assistant');
  expect(persisted?.text).toBe('answer');
  expect((persisted?.data as { reasoning?: string } | undefined)?.reasoning).toBe('think athink b');
});

test('system prompt uses custom instructions + renders the environment block', async () => {
  const seen: string[] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      const sys = req.messages.find((m) => m.role === 'system');
      seen.push(typeof sys?.content === 'string' ? sys.content : '');
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    instructions: 'You are Ada, a terse coding agent.',
    environment: { date: '2026-06-15', os: 'darwin', cwd: '/work' }
  });
  await loop.runBlock(newId('ses') as SessionId, 'hi');

  const sys = seen[0] ?? '';
  expect(sys).toContain('You are Ada, a terse coding agent.'); // host instructions, not the default
  expect(sys).not.toContain('You are monad'); // default replaced
  expect(sys).toContain('<environment>');
  expect(sys).toContain('date: 2026-06-15');
  expect(sys).toContain('cwd: /work');
});

test('per-session immutable instructions stay in the native system message', async () => {
  let captured: ModelMessage[] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      captured = req.messages;
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const agent = createAgent({
    model,
    sessionRepo: { insertSession() {}, getSession: () => null }
  });
  const loop = agent.loop(() => {}, { instructions: 'Managed session instructions' });

  await loop.runBlock(newId('ses') as SessionId, 'hello');

  expect(captured[0]?.role).toBe('system');
  expect(captured[0]?.content).toContain('You are an interactive engineering agent.');
  expect(captured[0]?.content).toEndWith('\n\nManaged session instructions');
  const userContent = captured[1]?.content;
  if (!Array.isArray(userContent)) throw new Error('multipart user message required');
  expect(userContent.at(-1)).toEqual({
    type: 'text',
    text: 'hello'
  });
  expect(JSON.stringify(captured[1])).not.toContain('Managed session instructions');
});

test('system prompt injects user-editable prompt slots separately from behavior', async () => {
  const seen: string[] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      const sys = req.messages.find((m) => m.role === 'system');
      seen.push(typeof sys?.content === 'string' ? sys.content : '');
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    promptSlots: {
      agent: 'AGENT SLOT',
      user: 'USER SLOT'
    }
  });
  await loop.runBlock(newId('ses') as SessionId, 'hi');

  const sys = seen[0] ?? '';
  expect(sys).toContain('AGENT SLOT');
  expect(sys).toContain('USER SLOT');
});

test('system prompt fills explicit slot markers instead of only appending addenda', async () => {
  const seen: string[] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      const sys = req.messages.find((m) => m.role === 'system');
      seen.push(typeof sys?.content === 'string' ? sys.content : '');
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    instructions: ['Before slot.', '{{ENVIRONMENT}}', 'After slot.'].join('\n\n'),
    environment: { cwd: '/slot-test' }
  });
  await loop.runBlock(newId('ses') as SessionId, 'hi');

  const sys = seen[0] ?? '';
  expect(sys).toContain('Before slot.\n\n<environment>');
  expect(sys).toContain('cwd: /slot-test');
  expect(sys).toContain('</environment>\n\nAfter slot.');
  expect(sys).not.toContain('{{ENVIRONMENT}}');
});

test('instructions getter is resolved per-turn (hot-reloadable)', async () => {
  const seen: string[] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      const sys = req.messages.find((m) => m.role === 'system');
      seen.push(typeof sys?.content === 'string' ? sys.content : '');
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  let persona = 'You are Ada.';
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    instructions: () => persona || undefined
  });
  const ses = newId('ses') as SessionId;
  await loop.runBlock(ses, 'one');
  persona = 'You are Grace.'; // edit between turns — picked up without rebuilding the loop
  await loop.runBlock(ses, 'two');
  persona = ''; // empty → fall back to the default persona
  await loop.runBlock(ses, 'three');

  expect(seen[0]).toContain('You are Ada.');
  expect(seen[1]).toContain('You are Grace.');
  expect(seen[2]).toContain('You are an interactive engineering agent.'); // empty getter → DEFAULT_SYSTEM_PROMPT
});

test('runStream emits a canonical failed message and re-throws when model fails', async () => {
  const modelError = new Error('secret upstream response');
  const events: Event[] = [];
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({
    model: {
      // Generator so runStream's `for await` can iterate it; the throw surfaces on first pull.
      async *stream() {
        yield undefined;
        throw modelError;
      },
      async complete() {
        throw modelError;
      }
    } as unknown as ModelRouter,
    tools: [],
    messages,
    defaultModel: 'mock',
    emit: (e) => events.push(e)
  });
  const sessionId = newId('ses') as SessionId;

  await expect(loop.runStream(sessionId, 'hi')).rejects.toBe(modelError);

  const errEvents = events.filter((e) => e.type === 'session.message.failed');
  expect(errEvents).toHaveLength(1);
  // Redacted canonical projection — the raw upstream secret must never reach the client.
  expect(eventMessage(errEvents[0])?.text).toBe('[AGENT_ERROR] generation failed');

  const errorMsg = messages.list(sessionId).find((m) => m.type === 'error');
  if (!errorMsg) throw new Error('expected persisted error message');
  expect(errorMsg).toEqual({
    id: errorMsg.id,
    sessionId,
    role: 'assistant',
    text: '[AGENT_ERROR] generation failed',
    createdAt: errorMsg.createdAt,
    type: 'error'
  });
  expect(JSON.stringify({ errEvents, errorMsg })).not.toContain('secret upstream response'); // presence-ok: raw provider errors must remain internal
});

test('runStream emits a provider_config_error message + providerId when the gateway has no credentials', async () => {
  const modelError = new AggregateError([noCredentialsError('anthropic')], 'gateway: all model attempts failed');
  const events: Event[] = [];
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({
    model: {
      async *stream() {
        yield undefined;
        throw modelError;
      },
      async complete() {
        throw modelError;
      }
    } as unknown as ModelRouter,
    tools: [],
    messages,
    defaultModel: 'mock',
    emit: (e) => events.push(e)
  });
  const sessionId = newId('ses') as SessionId;

  await expect(loop.runStream(sessionId, 'hi')).rejects.toThrow();

  const errEvents = events.filter((e) => e.type === 'session.message.failed');
  expect(errEvents).toHaveLength(1);
  expect(eventMessage(errEvents[0])).toMatchObject({
    type: 'provider_config_error',
    text: '[provider_config] no credentials configured for provider "anthropic"',
    data: { providerId: 'anthropic' }
  });

  const errorMsg = messages.list(sessionId).find((m) => m.type === 'provider_config_error');
  expect(errorMsg?.role).toBe('assistant');
  expect(errorMsg?.data).toEqual({ providerId: 'anthropic' });
});

test('image attachments are folded into the last user message as multimodal content', async () => {
  let captured: ModelMessage[] | undefined;
  const capturingModel: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      captured = req.messages;
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({
    model: capturingModel,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {}
  });
  const attachment: ImageAttachment = { image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' };
  await loop.runBlock(newId('ses') as SessionId, 'describe this', [attachment]);

  const prompt = captured ?? [];
  const lastUser = [...prompt].reverse().find((m) => m.role === 'user');
  expect(Array.isArray(lastUser?.content)).toBe(true);
  const parts = lastUser?.content as Array<{ type: string }>;
  expect(parts.some((p) => p.type === 'text')).toBe(true);
  expect(parts.some((p) => p.type === 'image')).toBe(true);
});

test('ambientContext is prepended to the last user message content (not the system prompt)', async () => {
  let captured: ModelMessage[] | undefined;
  const captureModel: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      captured = req.messages;
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({
    model: captureModel,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    ambientContext: 'OPEN_FILE: foo.ts\ncontent: hello'
  });
  await loop.runBlock(newId('ses') as SessionId, 'what files?');

  const prompt = captured ?? [];
  const lastUser = [...prompt].reverse().find((m) => m.role === 'user');
  expect(Array.isArray(lastUser?.content)).toBe(true);
  const parts = lastUser?.content as Array<{ type: string; text?: string }>;
  expect(parts.some((p) => p.type === 'text' && (p.text ?? '').includes('OPEN_FILE: foo.ts'))).toBe(true);
  // Ambient is NOT in the system prompt — it would bust the prompt-cache breakpoint.
  const system = prompt.find((m) => m.role === 'system');
  expect(typeof system?.content === 'string' ? system.content : '').not.toContain('OPEN_FILE');
});

test('cacheSystemPrompt emits the system as a leading message with an Anthropic cache breakpoint', async () => {
  let captured: ModelMessage[] | undefined;
  const loop = new AgentLoop({
    model: {
      async *stream() {},
      async complete(req): Promise<ModelResult> {
        captured = req.messages;
        return { text: 'ok', finishReason: 'stop' };
      }
    } as ModelRouter,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    cacheSystemPrompt: true
  });
  await loop.runBlock(newId('ses') as SessionId, 'hi');

  const prompt = captured ?? [];
  // With cacheSystemPrompt the loop marks the leading system message with `cache: true`; the
  // provider adapter (splitSystem) is what turns that into the Anthropic cache breakpoint
  // (`providerOptions.anthropic.cacheControl`), covered by packages/atoms/test/providers.test.ts.
  const first = prompt[0] as { role: string; cache?: boolean };
  expect(first.role).toBe('system');
  expect(first.cache).toBe(true);
});

test('runBlock emits agent.error and re-throws when model fails', async () => {
  const subError = Object.assign(new Error('429 rate limited'), { statusCode: 429 });
  const modelError = new AggregateError([subError], 'gateway: all attempts failed');
  const events: Event[] = [];
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({
    model: {
      // Generator so runStream's `for await` can iterate it; the throw surfaces on first pull.
      async *stream() {
        yield undefined;
        throw modelError;
      },
      async complete() {
        throw modelError;
      }
    } as unknown as ModelRouter,
    tools: [],
    messages,
    defaultModel: 'mock',
    emit: (e) => events.push(e)
  });
  const sessionId = newId('ses') as SessionId;

  await expect(loop.runBlock(sessionId, 'hi')).rejects.toBe(modelError);

  const errEvents = events.filter((e) => e.type === 'session.message.failed');
  expect(errEvents).toHaveLength(1);
  expect(eventMessage(errEvents[0])?.text).toBe('[RATE_LIMITED] rate limit exceeded');
  const errorMsg = messages.list(sessionId).find((message) => message.type === 'error');
  if (!errorMsg) throw new Error('expected persisted error message');
  expect(errorMsg).toEqual({
    id: errorMsg.id,
    sessionId,
    role: 'assistant',
    text: '[RATE_LIMITED] rate limit exceeded',
    createdAt: errorMsg.createdAt,
    type: 'error'
  });
});
