import { expect, test } from 'bun:test';

import { formatMessageTimestamp } from '../../src/features/session/message-time';

const NOW = new Date('2026-08-07T20:00:00');
const labels = { yesterday: 'Yesterday' };

test('a message from today shows only its time', () => {
  expect(formatMessageTimestamp('2026-08-07T09:05:00', 'en', labels, NOW)).toBe(
    new Date('2026-08-07T09:05:00').toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
  );
});

test('a message from yesterday is labeled with the yesterday word', () => {
  const time = new Date('2026-08-06T23:59:00').toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  expect(formatMessageTimestamp('2026-08-06T23:59:00', 'en', labels, NOW)).toBe(`Yesterday ${time}`);
});

test('an older same-year message carries month and day without the year', () => {
  const at = new Date('2026-03-02T08:30:00');
  const time = at.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  const date = at.toLocaleDateString('en', { day: 'numeric', month: 'short' });
  expect(formatMessageTimestamp('2026-03-02T08:30:00', 'en', labels, NOW)).toBe(`${date} ${time}`);
});

test('a previous-year message carries the year', () => {
  const at = new Date('2025-12-31T10:00:00');
  const time = at.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  const date = at.toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
  expect(formatMessageTimestamp('2025-12-31T10:00:00', 'en', labels, NOW)).toBe(`${date} ${time}`);
});

test('a start-of-month boundary still resolves yesterday across months', () => {
  const now = new Date('2026-08-01T01:00:00');
  const time = new Date('2026-07-31T22:00:00').toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  expect(formatMessageTimestamp('2026-07-31T22:00:00', 'en', labels, now)).toBe(`Yesterday ${time}`);
});

test('missing or unparseable timestamps yield null', () => {
  expect(formatMessageTimestamp(undefined, 'en', labels, NOW)).toBeNull();
  expect(formatMessageTimestamp('not-a-date', 'en', labels, NOW)).toBeNull();
});

test('repeated calls for the same locale and field shape reuse one Intl.DateTimeFormat instance', () => {
  const spy = { count: 0 };
  const OriginalFormat = Intl.DateTimeFormat;
  // biome-ignore lint/suspicious/noExplicitAny: patching a global constructor for a call-count spy
  (Intl as any).DateTimeFormat = (...args: unknown[]) => {
    spy.count++;
    // biome-ignore lint/suspicious/noExplicitAny: constructing the real formatter from spread args
    return new (OriginalFormat as any)(...args);
  };
  try {
    for (let i = 0; i < 5; i++) {
      formatMessageTimestamp('2026-03-02T08:30:00', 'en', labels, NOW);
    }
  } finally {
    Intl.DateTimeFormat = OriginalFormat;
  }
  // One construction per distinct (locale, field-shape) pair the calls above touch, not one per call.
  expect(spy.count).toBeLessThanOrEqual(2);
});
