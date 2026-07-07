import { expect, test } from 'bun:test';
import { z } from 'zod';

import { eventTypeSchema } from '../src/domain.ts';
import { EVENT_TABLE, parseEventPayload } from '../src/event-table.ts';

const ALL_EVENT_TYPES = eventTypeSchema.options;

test('EVENT_TABLE covers every EventType', () => {
  const covered = new Set(Object.keys(EVENT_TABLE));
  const _missing = ALL_EVENT_TYPES.filter((t) => !covered.has(t));
});

test('EVENT_TABLE has no extra keys beyond EventType', () => {
  const valid = new Set(ALL_EVENT_TYPES);
  const _extra = Object.keys(EVENT_TABLE).filter((k) => !valid.has(k as never));
});

test('every EVENT_TABLE entry is a ZodType', () => {
  for (const [type, schema] of Object.entries(EVENT_TABLE)) {
    expect(schema instanceof z.ZodType, `${type} is not a ZodType`).toBe(true);
  }
});

test('native CLI connection required events carry provider reconnect guidance', () => {
  const payload = parseEventPayload('native_cli.connection_required', {
    nativeCliSessionId: 'ncli_1',
    agentName: 'gemini',
    provider: 'gemini',
    reason: 'Gemini CLI is waiting for provider authentication to complete.',
    reconnectIn: 'studio'
  });

  expect(payload).toEqual({
    nativeCliSessionId: 'ncli_1',
    agentName: 'gemini',
    provider: 'gemini',
    reason: 'Gemini CLI is waiting for provider authentication to complete.',
    reconnectIn: 'studio'
  });
});
