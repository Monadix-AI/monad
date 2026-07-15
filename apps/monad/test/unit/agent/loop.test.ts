import type { Event, SessionId } from '@monad/protocol';
import type { ModelMessage, ModelResult } from '#/agent/index.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { AgentLoop, type ImageAttachment, InMemoryMessageRepo, type ModelRouter } from '#/agent/index.ts';
import { buildMockModel } from '../../fixtures/mock-model.ts';

function mockModel(deltas: string[]): ModelRouter {
  return buildMockModel().text(deltas).build();
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

test('runStream emits one agent.token per delta then a final agent.message', async () => {
  const deltas = ['Hel', 'lo', ' world'];
  const { loop, events, messages } = harness(deltas);
  const sessionId = newId('ses') as SessionId;

  await loop.runStream(sessionId, 'hi');

  const tokens = events.filter((e) => e.type === 'agent.token');
  const finals = events.filter((e) => e.type === 'agent.message');
  expect(tokens.map((e) => e.payload.delta)).toEqual(deltas);
  expect(tokens.map((e) => e.payload.index)).toEqual([0, 1, 2]);
  expect(finals).toHaveLength(1);
  expect(finals[0]?.payload.text).toBe('Hello world');

  // tokens and the final message share one messageId
  const msgId = finals[0]?.payload.messageId;
  expect(tokens.every((e) => e.payload.messageId === msgId)).toBe(true);

  // history: user turn + persisted assistant turn
  const history = messages.list(sessionId);
  expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(history[1]?.text).toBe('Hello world');
});

test('runBlock returns the full assistant message and emits a single agent.message', async () => {
  const { loop, events, messages } = harness(['Hello', ' world']);
  const sessionId = newId('ses') as SessionId;

  const message = await loop.runBlock(sessionId, 'hi');

  expect(message.role).toBe('assistant');
  expect(message.text).toBe('Hello world');
  expect(events.filter((e) => e.type === 'agent.message')).toHaveLength(1);
  expect(messages.list(sessionId).map((m) => m.role)).toEqual(['user', 'assistant']);
});

test('runStream surfaces reasoning deltas on agent.reasoning, separate from agent.token', async () => {
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

  const reasoning = events.filter((e) => e.type === 'agent.reasoning');
  expect(reasoning.map((e) => e.payload.delta)).toEqual(['think a', 'think b']);
  expect(reasoning.map((e) => e.payload.index)).toEqual([0, 1]);
  // Reasoning is NOT mixed into the answer tokens or the persisted message text.
  const tokenText = events
    .filter((e) => e.type === 'agent.token')
    .map((e) => e.payload.delta)
    .join('');
  expect(tokenText).toBe('answer');
  const msg = events.find((e) => e.type === 'agent.message');
  expect(msg?.payload.text).toBe('answer');
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
      soul: 'SOUL SLOT',
      agent: 'AGENT SLOT',
      user: 'USER SLOT'
    }
  });
  await loop.runBlock(newId('ses') as SessionId, 'hi');

  const sys = seen[0] ?? '';
  expect(sys).toContain('SOUL SLOT');
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

test('runStream emits agent.error and re-throws when model fails', async () => {
  const modelError = new Error('upstream 503');
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

  await expect(loop.runStream(sessionId, 'hi')).rejects.toThrow('upstream 503');

  const errEvents = events.filter((e) => e.type === 'agent.error');
  expect(errEvents).toHaveLength(1);
  expect(errEvents[0]?.payload.message).toBe('upstream 503');

  // The failure is persisted as an error-tagged assistant message so it shows in
  // history even when the live event stream can't deliver.
  const errorMsg = messages.list(sessionId).find((m) => m.type === 'error');
  expect(errorMsg?.role).toBe('assistant');
  expect(errorMsg?.text).toBe('upstream 503');
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

  await expect(loop.runBlock(sessionId, 'hi')).rejects.toThrow();

  const errEvents = events.filter((e) => e.type === 'agent.error');
  expect(errEvents).toHaveLength(1);
  expect(errEvents[0]?.payload.message).toBe('429 rate limited');
  expect(errEvents[0]?.payload.code).toBe('429');
});
