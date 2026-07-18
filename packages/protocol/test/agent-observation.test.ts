import { expect, test } from 'bun:test';

import { agentObservationEventSchema, agentObservationKindSchema, agentObservationUsageSchema } from '../src/index.ts';

const provenance = {
  contractEvents: [
    {
      id: 'external-source',
      role: 'agent' as const,
      text: 'provider source',
      source: 'codex-app-server' as const,
      provenance: { rawEvents: [{ method: 'item/completed' }] }
    }
  ]
};

test('kind enum is exactly the neutral turn lifecycle, unknown passthrough, and one-time session notices', () => {
  expect(new Set(agentObservationKindSchema.options)).toEqual(
    new Set([
      'turn-start',
      'user-message',
      'reasoning',
      'tool-call',
      'tool-result',
      'assistant-message',
      'turn-end',
      'system',
      'unknown'
    ])
  );
});

test('a streaming assistant fragment carries text and no tool/reason', () => {
  const parsed = agentObservationEventSchema.parse({
    id: 'e1',
    kind: 'assistant-message',
    streaming: true,
    text: 'hel',
    provenance
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
    tool: { name: 'bash', callId: 'toolu_1', input: { cmd: 'ls' } },
    provenance
  });
  expect(parsed.tool).toEqual({ name: 'bash', callId: 'toolu_1', input: { cmd: 'ls' } });
});

test('turn-end validates its reason against the closed set', () => {
  expect(
    agentObservationEventSchema.parse({ id: 'e3', kind: 'turn-end', streaming: false, reason: 'completed', provenance })
      .reason
  ).toBe('completed');
  expect(() =>
    agentObservationEventSchema.parse({ id: 'e4', kind: 'turn-end', streaming: false, reason: 'crashed', provenance })
  ).toThrow();
});

test('streaming is required — an event without it is rejected', () => {
  expect(() => agentObservationEventSchema.parse({ id: 'e5', kind: 'reasoning', text: 'think' })).toThrow();
});

test('an unknown kind is rejected (version-skew is dropped, not coerced)', () => {
  expect(() => agentObservationEventSchema.parse({ id: 'e6', kind: 'web-search', streaming: false })).toThrow();
});

test('neutral observation events require one or more contract sources', () => {
  const contractEvents = [
    {
      id: 'external-1',
      role: 'agent' as const,
      text: 'done',
      source: 'codex-app-server' as const,
      provenance: { rawEvents: [{ method: 'item/completed', params: { item: { id: 'item-1' } } }] }
    }
  ];
  expect(
    agentObservationEventSchema.parse({
      id: 'neutral-1',
      kind: 'assistant-message',
      streaming: false,
      text: 'done',
      provenance: { contractEvents }
    })
  ).toEqual({
    id: 'neutral-1',
    kind: 'assistant-message',
    streaming: false,
    text: 'done',
    provenance: { contractEvents }
  });
  expect(() =>
    agentObservationEventSchema.parse({ id: 'neutral-without-source', kind: 'assistant-message', streaming: false })
  ).toThrow();
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
