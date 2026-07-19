import { expect, test } from 'bun:test';

import { encodeEventCursor, eventCursorFromPosition } from '#/services/mesh-agent/host/event-cursor.ts';

test('MeshAgent event cursors preserve only provider-owned paging tokens', () => {
  expect(eventCursorFromPosition({ kind: 'provider', token: 'opaque-token' })).toEqual({
    kind: 'provider',
    token: 'opaque-token'
  });
  expect(eventCursorFromPosition({ kind: 'live', observationEpoch: 'oep_123', seq: 4 })).toEqual({ kind: 'none' });
  expect(eventCursorFromPosition(undefined)).toEqual({ kind: 'none' });
});

test('MeshAgent provider cursors use the canonical observation cursor grammar', () => {
  expect(encodeEventCursor('opaque/token')).toBe('provider:opaque%2Ftoken');
});
