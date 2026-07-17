import { expect, test } from 'bun:test';

import { agentObservationEventSchema, agentObservationKindSchema, agentObservationUsageSchema } from '../src/index.ts';

test('kind enum is exactly the neutral turn lifecycle plus one-time session notices, with no ui/error kinds', () => {
  expect(new Set(agentObservationKindSchema.options)).toEqual(
    new Set([
      'turn-start',
      'user-message',
      'reasoning',
      'tool-call',
      'tool-result',
      'assistant-message',
      'turn-end',
      'system'
    ])
  );
});

test('a streaming assistant fragment carries text and no tool/reason', () => {
  const parsed = agentObservationEventSchema.parse({
    id: 'e1',
    kind: 'assistant-message',
    streaming: true,
    text: 'hel',
    raw: { type: 'content_block_delta' }
  });
  expect(parsed.streaming).toBe(true);
  expect(parsed.text).toBe('hel');
  expect(parsed.tool).toBeUndefined();
  expect(parsed.reason).toBeUndefined();
});

test('a tool-call decodes to a structured tool payload, not pre-formatted text', () => {
  const parsed = agentObservationEventSchema.parse({
    id: 'e2',
    kind: 'tool-call',
    streaming: false,
    tool: { name: 'bash', input: { cmd: 'ls' } }
  });
  expect(parsed.tool).toEqual({ name: 'bash', input: { cmd: 'ls' } });
});

test('turn-end validates its reason against the closed set', () => {
  expect(
    agentObservationEventSchema.parse({ id: 'e3', kind: 'turn-end', streaming: false, reason: 'completed' }).reason
  ).toBe('completed');
  expect(() =>
    agentObservationEventSchema.parse({ id: 'e4', kind: 'turn-end', streaming: false, reason: 'crashed' })
  ).toThrow();
});

test('streaming is required — an event without it is rejected', () => {
  expect(() => agentObservationEventSchema.parse({ id: 'e5', kind: 'reasoning', text: 'think' })).toThrow();
});

test('an unknown kind is rejected (version-skew is dropped, not coerced)', () => {
  expect(() => agentObservationEventSchema.parse({ id: 'e6', kind: 'web-search', streaming: false })).toThrow();
});

test('usage is a separate frame: token counts plus provider limits, no event kind', () => {
  const usage = agentObservationUsageSchema.parse({
    inputTokens: 10,
    outputTokens: 5,
    limits: [{ id: 'weekly', label: 'Weekly', percent: 0.42, resetAt: '2026-07-14T00:00:00Z' }]
  });
  expect(usage.outputTokens).toBe(5);
  expect(usage.limits?.[0]?.percent).toBe(0.42);
  expect(() => agentObservationUsageSchema.parse({ inputTokens: -1 })).toThrow();
});
