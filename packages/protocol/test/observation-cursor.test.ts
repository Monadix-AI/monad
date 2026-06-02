import { describe, expect, test } from 'bun:test';

import {
  formatObservationCursor,
  observationCursorSchema,
  observationResume,
  parseObservationAfter,
  parseObservationCursor,
  parseObservationPageBefore
} from '../src/mesh-agent/observation-cursor.ts';

describe('observation cursor codec', () => {
  test('round-trips a live position through its wire form', () => {
    const cursor = formatObservationCursor({ kind: 'live', observationEpoch: 'oep_abc', seq: 42 });

    expect(cursor).toBe('live:oep_abc:42');
    expect(parseObservationCursor(cursor)).toEqual({ kind: 'live', observationEpoch: 'oep_abc', seq: 42 });
  });

  test('round-trips a provider position whose token carries the separator', () => {
    const cursor = formatObservationCursor({ kind: 'provider', token: 'turn:17' });

    expect(cursor).toBe('provider:turn%3A17');
    expect(parseObservationCursor(cursor)).toEqual({ kind: 'provider', token: 'turn:17' });
  });

  test('encodes a provider JSON token as one query-safe cursor value', () => {
    const token = '{"turnId":"019f741c-70a5-7df2-a5f4-04132750aace","includeAnchor":false}';
    const cursor = formatObservationCursor({ kind: 'provider', token });

    expect(cursor).toBe(
      'provider:%7B%22turnId%22%3A%22019f741c-70a5-7df2-a5f4-04132750aace%22%2C%22includeAnchor%22%3Afalse%7D'
    );
    expect(parseObservationCursor(cursor)).toEqual({ kind: 'provider', token });
  });

  test('keeps an epoch containing the separator unambiguous', () => {
    const cursor = formatObservationCursor({ kind: 'live', observationEpoch: 'oep:weird', seq: 7 });

    expect(cursor).toBe('live:oep%3Aweird:7');
    expect(parseObservationCursor(cursor)).toEqual({ kind: 'live', observationEpoch: 'oep:weird', seq: 7 });
  });

  test('degrades a foreign, corrupt, or merely position-shaped value to no position', () => {
    expect(parseObservationCursor(undefined)).toBeUndefined();
    expect(parseObservationCursor('')).toBeUndefined();
    expect(parseObservationCursor('42')).toBeUndefined();
    expect(parseObservationCursor('journal:')).toBeUndefined();
    // The panel's history-bootstrap request-dedup key is prefixed like a cursor but is not one.
    expect(parseObservationCursor('disconnected:latest')).toBeUndefined();
    expect(parseObservationCursor('live:oep_abc:notaseq')).toBeUndefined();
    expect(parseObservationCursor('live:oep_abc:1:2')).toBeUndefined();
    expect(parseObservationCursor('live:%:1')).toBeUndefined();
    expect(parseObservationCursor('live:oep_abc:9007199254740992')).toBeUndefined();
  });

  test('rejects an unstructured cursor at the wire boundary', () => {
    expect(observationCursorSchema.safeParse('live:oep_abc:42').success).toBe(true);
    expect(observationCursorSchema.safeParse('provider:turn_1').success).toBe(true);
    expect(observationCursorSchema.safeParse('42').success).toBe(false);
    expect(observationCursorSchema.safeParse('live:oep_abc:x').success).toBe(false);
    expect(observationCursorSchema.safeParse('live:%:1').success).toBe(false);
    expect(observationCursorSchema.safeParse('live:oep_abc:9007199254740992').success).toBe(false);
    expect(observationCursorSchema.safeParse('disconnected:latest').success).toBe(false);
  });
});

describe('use-site variants', () => {
  test('a live-subscribe resume position accepts only a live cursor', () => {
    expect(parseObservationAfter('live:oep_abc:42')).toEqual({
      kind: 'live',
      observationEpoch: 'oep_abc',
      seq: 42
    });
    expect(parseObservationAfter('provider:turn_1')).toBeUndefined();
  });

  test('an event-page before position accepts live and provider cursors', () => {
    expect(parseObservationPageBefore('live:oep_abc:42')).toEqual({
      kind: 'live',
      observationEpoch: 'oep_abc',
      seq: 42
    });
    expect(parseObservationPageBefore('provider:turn_1')).toEqual({ kind: 'provider', token: 'turn_1' });
    expect(parseObservationPageBefore(undefined)).toBeUndefined();
    expect(parseObservationPageBefore('journal:')).toBeUndefined();
  });

  test('an empty or percent-encoded provider token survives page-before parsing', () => {
    expect(parseObservationPageBefore('provider:')).toEqual({ kind: 'provider', token: '' });
    expect(parseObservationPageBefore('provider:turn%3A17')).toEqual({ kind: 'provider', token: 'turn:17' });
    expect(observationCursorSchema.safeParse('provider:').success).toBe(true);
  });
});

describe('observationResume', () => {
  test('resumes after the sequence when the cursor names the current epoch', () => {
    expect(observationResume('live:oep_abc:42', 'oep_abc')).toEqual({ kind: 'after', seq: 42 });
  });

  test('restarts the current epoch when the cursor came from a rotated epoch', () => {
    expect(observationResume('live:oep_old:42', 'oep_new')).toEqual({ kind: 'epoch-start' });
  });

  test('restarts the current epoch for a provider, absent, or corrupt cursor', () => {
    expect(observationResume('provider:turn_1', 'oep_abc')).toEqual({ kind: 'epoch-start' });
    expect(observationResume(undefined, 'oep_abc')).toEqual({ kind: 'epoch-start' });
    expect(observationResume('42', 'oep_abc')).toEqual({ kind: 'epoch-start' });
  });
});
