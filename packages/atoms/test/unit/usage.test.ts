import { expect, test } from 'bun:test';

import { toUsage } from '../../src/providers/ai-sdk-adapter/index.ts';

test('toUsage maps a full ai-sdk usage + provider metadata', () => {
  const u = toUsage(
    { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 40, reasoningTokens: 10 },
    { anthropic: { cacheCreationInputTokens: 25 } }
  );
  expect(u).toEqual({
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cacheReadTokens: 40,
    cacheWriteTokens: 25,
    reasoningTokens: 10
  });
});

test('extracts the provider real cost from OpenRouter usage accounting', () => {
  const u = toUsage(
    { inputTokens: 100, outputTokens: 50 },
    { openrouter: { usage: { cost: 0.0123, totalTokens: 150 } } }
  );
  expect(u?.costUsd).toBe(0.0123);
});

test('costUsd is undefined when the provider reports no cost', () => {
  expect(toUsage({ inputTokens: 100, outputTokens: 50 })?.costUsd).toBeUndefined();
  expect(
    toUsage({ inputTokens: 1, outputTokens: 1 }, { openrouter: { usage: { cost: null } } })?.costUsd
  ).toBeUndefined();
});

test('field present in type but absent at runtime → undefined, not 0', () => {
  const u = toUsage({ inputTokens: 100, outputTokens: 50 });
  expect(u?.inputTokens).toBe(100);
  expect(u?.cacheReadTokens).toBeUndefined();
  expect(u?.reasoningTokens).toBeUndefined();
  expect(u?.cacheWriteTokens).toBeUndefined();
});

test('a reported zero is preserved (distinct from absent)', () => {
  const u = toUsage({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 });
  expect(u?.cacheReadTokens).toBe(0);
});

test('totalTokens derived from input+output only when both present', () => {
  expect(toUsage({ inputTokens: 100, outputTokens: 50 })?.totalTokens).toBe(150);
  expect(toUsage({ inputTokens: 100 })?.totalTokens).toBeUndefined();
  expect(toUsage({ totalTokens: 999, inputTokens: 100, outputTokens: 50 })?.totalTokens).toBe(999);
});

test('non-finite values are treated as absent', () => {
  const u = toUsage({ inputTokens: Number.NaN, outputTokens: 50 } as { inputTokens?: number; outputTokens?: number });
  expect(u?.inputTokens).toBeUndefined();
  expect(u?.outputTokens).toBe(50);
});

test('completely empty usage → undefined (no-usage semantics)', () => {
  expect(toUsage({})).toBeUndefined();
  expect(toUsage(undefined)).toBeUndefined();
});

test('cacheWrite reads the bedrock mirror when anthropic key absent', () => {
  const u = toUsage({ inputTokens: 10, outputTokens: 5 }, { bedrock: { usage: { cacheWriteInputTokens: 7 } } });
  expect(u?.cacheWriteTokens).toBe(7);
});
