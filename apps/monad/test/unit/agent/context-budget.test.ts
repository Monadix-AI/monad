import type { Event, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import {
  AgentLoop,
  buildContextUsage,
  ContextBuilder,
  DEFAULT_AUTOCOMPACT_BUFFER,
  estimateTokens,
  InMemoryMessageRepo
} from '@/agent/index.ts';
import { buildMockModel } from '../../fixtures/mock-model.ts';

test('estimateTokens is positive, monotonic, and zero for empty', () => {
  expect(estimateTokens('')).toBe(0);
  const a = estimateTokens('hello world');
  const b = estimateTokens('hello world, this is a longer sentence with more tokens');
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
});

test('buildContextUsage sums segments and computes free against the limit + buffer', () => {
  const usage = buildContextUsage(
    [
      { category: 'systemPrompt', label: 'System prompt', tokens: 100 },
      { category: 'messages', label: 'Messages', tokens: 400 }
    ],
    { contextLimit: 10_000, autocompactBuffer: 1000 }
  );
  expect(usage.used).toBe(500);
  expect(usage.free).toBe(10_000 - 500 - 1000);
  expect(usage.approximate).toBe(true);
  expect(usage.segments).toHaveLength(2);
});

test('free never goes negative when the window is over budget', () => {
  const usage = buildContextUsage([{ category: 'messages', label: 'Messages', tokens: 9_999 }], {
    contextLimit: 1000,
    autocompactBuffer: 500
  });
  expect(usage.free).toBe(0);
});

test('ContextBuilder drops zero-token segments and defaults the autocompact buffer', () => {
  const usage = new ContextBuilder()
    .add('systemPrompt', 'System prompt', 'you are a helpful agent')
    .add('messages', 'Messages', '') // 0 tokens → dropped
    .build({ contextLimit: 100_000 });
  expect(usage.segments).toHaveLength(1);
  expect(usage.autocompactBuffer).toBe(DEFAULT_AUTOCOMPACT_BUFFER);
});

test('the loop emits a context.usage breakdown when contextLimit is set', async () => {
  const model = buildMockModel().text(['hi']).build();
  const events: Event[] = [];
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: (e) => events.push(e),
    contextLimit: 200_000
  });
  await loop.runBlock(newId('ses') as SessionId, 'hello');

  const usage = events.find((e) => e.type === 'context.usage');
  expect(usage).toBeDefined();
  expect(usage?.payload.contextLimit).toBe(200_000);
  expect((usage?.payload.segments as unknown[]).length).toBeGreaterThan(0);
});

test('context.usage prefers provider usage for the total (estimate fallback otherwise)', async () => {
  const withUsage = buildMockModel().text(['hi']).usage({ inputTokens: 1234 }).build();
  const events: Event[] = [];
  const loop = new AgentLoop({
    model: withUsage,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: (e) => events.push(e),
    contextLimit: 200_000
  });
  await loop.runBlock(newId('ses') as SessionId, 'hello');

  const usage = events.find((e) => e.type === 'context.usage');
  expect(usage?.payload.used).toBe(1234); // provider total, not a local estimate
  expect(usage?.payload.approximate).toBe(false);
});

test('no context.usage event without a configured contextLimit', async () => {
  const model = buildMockModel().text(['hi']).build();
  const events: Event[] = [];
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: (e) => events.push(e)
  });
  await loop.runBlock(newId('ses') as SessionId, 'hello');
  expect(events.some((e) => e.type === 'context.usage')).toBe(false);
});
