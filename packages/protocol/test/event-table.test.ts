import { expect, test } from 'bun:test';
import { z } from 'zod';

import { eventTypeSchema } from '../src/domain.ts';
import { EVENT_TABLE } from '../src/event-table.ts';

const ALL_EVENT_TYPES = eventTypeSchema.options;

test('EVENT_TABLE covers every EventType', () => {
  const covered = new Set(Object.keys(EVENT_TABLE));
  const missing = ALL_EVENT_TYPES.filter((t) => !covered.has(t));
  expect(missing).toEqual([]);
});

test('EVENT_TABLE has no extra keys beyond EventType', () => {
  const valid = new Set(ALL_EVENT_TYPES);
  const extra = Object.keys(EVENT_TABLE).filter((k) => !valid.has(k as never));
  expect(extra).toEqual([]);
});

test('every EVENT_TABLE entry is a ZodType', () => {
  for (const [type, schema] of Object.entries(EVENT_TABLE)) {
    expect(schema instanceof z.ZodType, `${type} is not a ZodType`).toBe(true);
  }
});
