// Task 1 (Observation Dual Stream): the four raw/convenience contracts plus the connection
// snapshot handshake. Raw frames preserve provider `data` verbatim; convenience frames carry the
// neutral AgentObservationEvent with non-empty provenance. See
// docs/plans/2026-07-18-chat-experience-realtime-planes-design.md §Plane 2B.

import type { AgentObservationEvent } from '../src/agent-observation.ts';

import { expect, test } from 'bun:test';

import {
  externalAgentConnectionSnapshotSchema,
  externalAgentConvenienceFrameSchema,
  externalAgentRawFrameSchema,
  externalAgentRawHistoryPageSchema
} from '../src/external-agent/external-agent-observation-dual.ts';

const SESSION: `exa_${string}` = 'exa_000000000001';

const convenienceEvent: AgentObservationEvent = {
  id: 'e1',
  kind: 'reasoning',
  streaming: false,
  text: 'thinking',
  provenance: { contractEvents: [{ raw: 'provider-record' }] }
};

test('raw frame preserves provider data verbatim, including a nested object', () => {
  const frame = {
    externalAgentSessionId: SESSION,
    provider: 'codex' as const,
    observationEpoch: 'epoch-1',
    origin: 'live' as const,
    cursor: '42',
    providerIdentity: 'evt-9',
    stream: 'app-server' as const,
    data: { type: 'item/started', payload: { nested: [1, 2, { deep: true }] } },
    observedAt: '2026-07-18T00:00:00.000Z'
  };
  expect(externalAgentRawFrameSchema.parse(frame)).toEqual(frame);
});

test('raw frame accepts a primitive-string live text frame as data with no extra fields', () => {
  const frame = {
    externalAgentSessionId: SESSION,
    provider: 'claude-code' as const,
    origin: 'history' as const,
    cursor: '0',
    data: 'exact stdout bytes\n'
  };
  expect(externalAgentRawFrameSchema.parse(frame)).toEqual(frame);
});

test('raw frame rejects a missing data key', () => {
  expect(() =>
    externalAgentRawFrameSchema.parse({
      externalAgentSessionId: SESSION,
      provider: 'codex',
      origin: 'live',
      cursor: '1'
    })
  ).toThrow();
});

test('raw frame rejects an unknown origin', () => {
  expect(() =>
    externalAgentRawFrameSchema.parse({
      externalAgentSessionId: SESSION,
      provider: 'codex',
      origin: 'snapshot',
      cursor: '1',
      data: {}
    })
  ).toThrow();
});

test('raw history page carries records, nextCursor, and coverage', () => {
  const page = {
    records: [
      { data: { line: 1 }, providerIdentity: 'p1', cursor: '1' },
      { data: 'raw text', cursor: '2' }
    ],
    nextCursor: '3',
    coverage: 'exact' as const
  };
  expect(externalAgentRawHistoryPageSchema.parse(page)).toEqual(page);
});

test('raw history page rejects an unknown coverage value', () => {
  expect(() => externalAgentRawHistoryPageSchema.parse({ records: [], coverage: 'partial' })).toThrow();
});

test('convenience ready frame carries the epoch and history boundary', () => {
  const parsed = externalAgentConvenienceFrameSchema.parse({
    kind: 'ready',
    observationEpoch: 'epoch-1',
    historyBefore: '17'
  });
  expect(parsed).toEqual({ kind: 'ready', observationEpoch: 'epoch-1', historyBefore: '17' });
});

test('convenience upsert carries a cursor and a neutral event', () => {
  const frame = { kind: 'upsert' as const, cursor: '42', event: convenienceEvent };
  expect(externalAgentConvenienceFrameSchema.parse(frame)).toEqual(frame);
});

test('convenience remove retracts by cursor and event id', () => {
  const parsed = externalAgentConvenienceFrameSchema.parse({ kind: 'remove', cursor: '43', eventId: 'e1' });
  expect(parsed).toEqual({ kind: 'remove', cursor: '43', eventId: 'e1' });
});

test('convenience unavailable carries a reason', () => {
  const parsed = externalAgentConvenienceFrameSchema.parse({ kind: 'unavailable', reason: 'history unsupported' });
  expect(parsed).toEqual({ kind: 'unavailable', reason: 'history unsupported' });
});

test('convenience upsert rejects an event with empty provenance', () => {
  expect(() =>
    externalAgentConvenienceFrameSchema.parse({
      kind: 'upsert',
      cursor: '1',
      event: { ...convenienceEvent, provenance: { contractEvents: [] } }
    })
  ).toThrow();
});

test('connection snapshot connected state carries epoch, boundary, and revision', () => {
  const snapshot = {
    state: 'connected' as const,
    externalAgentSessionId: SESSION,
    provider: 'codex' as const,
    observationEpoch: 'epoch-2',
    historyBefore: '9',
    revision: 3
  };
  expect(externalAgentConnectionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
});

test('connection snapshot disconnected state carries a revision without an epoch', () => {
  const parsed = externalAgentConnectionSnapshotSchema.parse({
    state: 'disconnected',
    externalAgentSessionId: SESSION,
    revision: 5
  });
  expect(parsed).toEqual({ state: 'disconnected', externalAgentSessionId: SESSION, revision: 5 });
});
