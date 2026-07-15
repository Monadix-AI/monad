import type { Cost, Event, SessionId } from '@monad/protocol';
import type { ModelRouter, ModelUsage } from '#/agent/index.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { AgentLoop, globalEstimator, InMemoryMessageRepo } from '#/agent/index.ts';

// A model that reports usage on its stream (like a real provider returning token counts).
function usageModel(usage: ModelUsage): ModelRouter {
  return {
    async *stream() {
      yield { type: 'text' as const, token: 'ok' };
      yield { type: 'usage' as const, usage };
    },
    async complete() {
      return { text: 'ok', finishReason: 'stop' as const, usage };
    }
  };
}

test('finishTurn records real usage via recordTurnUsage and attaches the returned cost', async () => {
  const usage: ModelUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 };
  const recorded: Array<{ sessionId: string; usage: ModelUsage; modelId: string }> = [];
  const fakeCost: Cost = { usd: 0.0042, source: 'catalog_price', approximate: true };
  const events: Event[] = [];

  const loop = new AgentLoop({
    model: usageModel(usage),
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'anthropic:claude-x',
    emit: (e) => events.push(e),
    recordTurnUsage: (sessionId, u, modelId) => {
      recorded.push({ sessionId, usage: u, modelId });
      return fakeCost;
    }
  });

  await loop.runStream(newId('ses') as SessionId, 'hi');

  // recordTurnUsage saw the real usage + the model id.
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.usage).toEqual(usage);
  expect(recorded[0]?.modelId).toBe('anthropic:claude-x');

  // The cost rides on the agent.message event.
  const msg = events.find((e) => e.type === 'agent.message');
  expect((msg?.payload as { cost?: Cost }).cost).toEqual(fakeCost);
});

test('forwards costUsd + resolved provider/modelId on usage to recordTurnUsage', async () => {
  const usage: ModelUsage = {
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.0099, // provider-reported real cost
    provider: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4-6'
  };
  let seen: ModelUsage | undefined;
  const loop = new AgentLoop({
    model: usageModel(usage),
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'primary',
    emit: () => {},
    recordTurnUsage: (_s, u) => {
      seen = u;
      return undefined;
    }
  });
  await loop.runStream(newId('ses') as SessionId, 'hi');
  // The loop must not strip these in-process fields — they drive real-cost + correct attribution.
  expect(seen?.costUsd).toBe(0.0099);
  expect(seen?.provider).toBe('openrouter');
  expect(seen?.modelId).toBe('anthropic/claude-sonnet-4-6');
});

test('emitContextUsage: provider input tokens → exact (non-approximate)', async () => {
  const events: Event[] = [];
  const loop = new AgentLoop({
    model: usageModel({ inputTokens: 100, outputTokens: 50 }),
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    contextLimit: 100_000,
    emit: (e) => events.push(e)
  });
  await loop.runStream(newId('ses') as SessionId, 'hi');
  const ctx = events.find((e) => e.type === 'context.usage');
  expect((ctx?.payload as { approximate?: boolean }).approximate).toBe(false);
});

test('emitContextUsage: no provider usage and no countTokens → approximate char estimate', async () => {
  const noUsage: ModelRouter = {
    async *stream() {
      yield { type: 'text' as const, token: 'ok' };
    },
    async complete() {
      return { text: 'ok', finishReason: 'stop' as const };
    }
  };
  const events: Event[] = [];
  const loop = new AgentLoop({
    model: noUsage,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    contextLimit: 100_000,
    emit: (e) => events.push(e)
  });
  await loop.runStream(newId('ses') as SessionId, 'hi');
  const ctx = events.find((e) => e.type === 'context.usage');
  expect((ctx?.payload as { approximate?: boolean }).approximate).toBe(true);
});

test('emitContextUsage: native countTokens fills in an exact total without provider usage', async () => {
  const withCount: ModelRouter = {
    async *stream() {
      yield { type: 'text' as const, token: 'ok' }; // no usage chunk
    },
    async complete() {
      return { text: 'ok', finishReason: 'stop' as const };
    },
    async countTokens() {
      return 4242;
    }
  };
  const events: Event[] = [];
  const loop = new AgentLoop({
    model: withCount,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    contextLimit: 100_000,
    emit: (e) => events.push(e)
  });
  await loop.runStream(newId('ses') as SessionId, 'hi');
  const ctx = events.find((e) => e.type === 'context.usage');
  const payload = ctx?.payload as { approximate?: boolean; segments?: Array<{ category: string; tokens: number }> };
  expect(payload.approximate).toBe(false); // count_tokens is exact
  // The whole-request total (4242) lands minus the static buckets in the messages segment.
  const messages = payload.segments?.find((s) => s.category === 'messages');
  expect(messages && messages.tokens > 0).toBe(true);
});

test('no recordTurnUsage configured → no crash, no cost attached', async () => {
  const events: Event[] = [];
  const loop = new AgentLoop({
    model: usageModel({ inputTokens: 10, outputTokens: 5 }),
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: (e) => events.push(e)
  });
  await loop.runStream(newId('ses') as SessionId, 'hi');
  const msg = events.find((e) => e.type === 'agent.message');
  expect((msg?.payload as { cost?: Cost }).cost).toBeUndefined();
});

test('the global estimator self-calibrates from a turn with real input tokens', async () => {
  // Send a long prompt; the provider reports a specific input-token count → ratio should shift.
  const before = globalEstimator.ratio;
  const loop = new AgentLoop({
    model: usageModel({ inputTokens: 1, outputTokens: 1 }), // tiny tokens vs the prompt chars → high ratio
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {}
  });
  await loop.runStream(newId('ses') as SessionId, 'x'.repeat(400));
  // observe(sentChars≈>400, inputTokens=1) → sample ratio huge → clamped, but calibrated.
  expect(globalEstimator.approximate).toBe(false);
  // ratio moved toward the (clamped) observed sample; just assert it changed/stayed finite & sane.
  expect(globalEstimator.ratio).toBeGreaterThanOrEqual(2);
  expect(globalEstimator.ratio).toBeLessThanOrEqual(8);
  void before;
});
