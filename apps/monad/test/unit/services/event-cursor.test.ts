import type { EventCursor, EventId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  decodeEventCursor,
  EventCursorError,
  encodeEventCursor,
  resolveReplayCursor
} from '#/services/event-cursor.ts';

const scope = { plane: 'session.events' as const, transcriptTargetId: 'ses_1234567890ab' };
const anchorEventId = 'evt_1234567890ab' as EventId;

test('versioned event cursor round trips plane, scope, and event anchor', () => {
  const cursor = encodeEventCursor(scope, anchorEventId);
  expect(cursor).toMatch(/^cur_[A-Za-z0-9_-]+$/);
  expect(cursor).not.toContain(anchorEventId); // presence-ok: cursor contents are opaque to consumers
  expect(decodeEventCursor(cursor, scope)).toEqual({ ...scope, anchorEventId });
});

test('event cursor rejects malformed, overlong, unknown-version, and missing-field payloads', () => {
  const encodeRaw = (value: unknown) =>
    `cur_${Buffer.from(JSON.stringify(value)).toString('base64url')}` as EventCursor;
  const invalid = [
    'cur_not-json' as EventCursor,
    `cur_${'a'.repeat(1025)}` as EventCursor,
    encodeRaw({ v: 2, p: 'session.events', s: scope.transcriptTargetId, a: anchorEventId }),
    encodeRaw({ v: 1, p: 'session.events', s: scope.transcriptTargetId })
  ];
  for (const cursor of invalid) {
    expect(() => decodeEventCursor(cursor, scope)).toThrow(
      expect.objectContaining({ code: 'CURSOR_INVALID', kind: 'invalid', retryable: false })
    );
  }
});

test('event cursor rejects a different replay plane or transcript target scope', () => {
  const cursor = encodeEventCursor(scope, anchorEventId);
  for (const expected of [
    { plane: 'session.ui' as const, transcriptTargetId: scope.transcriptTargetId },
    { plane: scope.plane, transcriptTargetId: 'ses_other000000' }
  ]) {
    expect(() => decodeEventCursor(cursor, expected)).toThrow(
      expect.objectContaining({ code: 'CURSOR_WRONG_SCOPE', kind: 'conflict', retryable: false })
    );
  }
});

test('cursor errors expose only the three explicit non-retryable outcomes', () => {
  expect(new EventCursorError('expired')).toEqual(
    expect.objectContaining({ code: 'CURSOR_EXPIRED', kind: 'gone', retryable: false })
  );
});

test('resolver accepts same-scope opaque and legacy anchors but expires a missing anchor', () => {
  const liveAnchor = 'evt_live00000000' as EventId;
  const durableAnchor = anchorEventId;
  const deps = {
    cache: {
      anchorStatus: (_scope: string, eventId: EventId) =>
        eventId === liveAnchor ? ('live' as const) : ('missing' as const)
    },
    store: {
      eventAnchorStatus: (_scope: string, eventId: EventId) =>
        eventId === durableAnchor ? ('durable' as const) : ('missing' as const)
    }
  };

  expect(resolveReplayCursor(liveAnchor, scope, deps)).toEqual({ tier: 'live', anchorEventId: liveAnchor });
  expect(resolveReplayCursor(encodeEventCursor(scope, durableAnchor), scope, deps)).toEqual({
    tier: 'durable',
    anchorEventId: durableAnchor
  });
  expect(() => resolveReplayCursor('evt_missing00000', scope, deps)).toThrow(
    expect.objectContaining({ code: 'CURSOR_EXPIRED', kind: 'gone' })
  );
});
