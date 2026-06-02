import { expect, test } from 'bun:test';

import { eventCursorSchema, eventIdSchema, sessionUiEventSchema } from '../src/index.ts';

test('event cursor is a bounded opaque base64url token distinct from an event id', () => {
  expect(eventCursorSchema.parse('cur_abc_DEF-123')).toBe('cur_abc_DEF-123');
  expect(eventCursorSchema.safeParse(`cur_${'a'.repeat(1024)}`).success).toBe(true);
  expect(eventCursorSchema.safeParse(`cur_${'a'.repeat(1025)}`).success).toBe(false);
  expect(eventCursorSchema.safeParse('cur_bad/payload').success).toBe(false);
  expect(eventCursorSchema.safeParse('evt_1234567890ab').success).toBe(false);
  expect(eventIdSchema.safeParse('cur_abc').success).toBe(false);
});

test('UI wire cursor accepts opaque and legacy tokens during migration', () => {
  const base = { kind: 'snapshot' as const, items: [] };
  expect(sessionUiEventSchema.parse({ ...base, cursor: 'cur_abc_DEF-123' }).cursor).toBe('cur_abc_DEF-123');
  expect(sessionUiEventSchema.parse({ ...base, cursor: 'evt_1234567890ab' }).cursor).toBe('evt_1234567890ab');
  expect(sessionUiEventSchema.safeParse({ ...base, cursor: 'bad_cursor' }).success).toBe(false);
});
