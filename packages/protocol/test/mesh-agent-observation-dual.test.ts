// Task 1 (Observation Dual Stream): the four raw/convenience contracts plus the connection
// snapshot handshake. Raw frames preserve provider `data` verbatim; convenience frames carry the
// neutral AgentObservationEvent with non-empty provenance. See
// docs/plans/2026-07-18-chat-experience-realtime-planes-design.md §Plane 2B.

import type { AgentObservationEvent } from '../src/agent-observation.ts';

import { expect, test } from 'bun:test';

import {
  meshConnectionSnapshotSchema,
  meshConvenienceEventPageSchema,
  meshConvenienceFrameSchema,
  meshRawEventPageSchema,
  meshRawEventSchema
} from '../src/mesh-agent/mesh-agent-observation-dual.ts';

test('convenience history page preserves the continuation cursor', () => {
  const page = {
    frames: [{ kind: 'ready' as const, cursor: 'provider:newest' as const }],
    nextCursor: 'provider:older' as const
  };
  expect(meshConvenienceEventPageSchema.parse(page)).toEqual(page);
});

const SESSION: `mesh_${string}` = 'mesh_000000000001';

const convenienceEvent: AgentObservationEvent = {
  id: 'e1',
  kind: 'reasoning',
  streaming: false,
  text: 'thinking',
  provenance: { contractEvents: [{ raw: 'provider-record' }] }
};

test('raw frame preserves provider data verbatim, including a nested object', () => {
  const frame = {
    meshSessionId: SESSION,
    provider: 'codex' as const,
    observationEpoch: 'epoch-1',
    origin: 'live' as const,
    cursor: 'live:epoch-1:42' as const,
    providerIdentity: 'evt-9',
    stream: 'app-server' as const,
    data: { type: 'item/started', payload: { nested: [1, 2, { deep: true }] } },
    observedAt: '2026-07-18T00:00:00.000Z'
  };
  expect(meshRawEventSchema.parse(frame)).toEqual(frame);
});

test('raw frame accepts a primitive-string live text frame as data with no extra fields', () => {
  const frame = {
    meshSessionId: SESSION,
    provider: 'claude-code' as const,
    origin: 'events' as const,
    cursor: 'live:epoch-1:0' as const,
    data: 'exact stdout bytes\n'
  };
  expect(meshRawEventSchema.parse(frame)).toEqual(frame);
});

test('raw frame rejects a missing data key', () => {
  expect(() =>
    meshRawEventSchema.parse({
      meshSessionId: SESSION,
      provider: 'codex',
      origin: 'live',
      cursor: 'live:epoch-1:1' as const
    })
  ).toThrow();
});

test('raw frame rejects an unknown origin', () => {
  expect(() =>
    meshRawEventSchema.parse({
      meshSessionId: SESSION,
      provider: 'codex',
      origin: 'snapshot',
      cursor: 'live:epoch-1:1' as const,
      data: {}
    })
  ).toThrow();
});

test('raw events page carries records, nextCursor, and coverage', () => {
  const page = {
    records: [
      { data: { line: 1 }, providerIdentity: 'p1', cursor: '1' },
      { data: 'raw text', cursor: '2' }
    ],
    nextCursor: '3',
    coverage: 'exact' as const
  };
  expect(meshRawEventPageSchema.parse(page)).toEqual(page);
});

test('raw events page rejects an unknown coverage value', () => {
  expect(() => meshRawEventPageSchema.parse({ records: [], coverage: 'partial' })).toThrow();
});

test('convenience ready frame carries the epoch, resume anchor, and earlier-events boundary', () => {
  const frame = {
    kind: 'ready' as const,
    observationEpoch: 'epoch-1',
    cursor: 'live:epoch-1:17' as const,
    eventsBefore: 'provider:turn_1' as const
  };
  expect(meshConvenienceFrameSchema.parse(frame)).toEqual(frame);
});

test('a convenience patch applies every operation for one raw position atomically', () => {
  const frame = {
    kind: 'patch' as const,
    cursor: 'live:epoch-1:42' as const,
    operations: [
      { op: 'upsert' as const, event: convenienceEvent },
      { op: 'remove' as const, eventId: 'e1' }
    ]
  };
  expect(meshConvenienceFrameSchema.parse(frame)).toEqual(frame);
});

// A patch with nothing to apply would advance the consumer's position while carrying no change,
// which is indistinguishable on the wire from a lost batch.
test('a convenience patch rejects an empty operation list', () => {
  expect(() =>
    meshConvenienceFrameSchema.parse({ kind: 'patch', cursor: 'live:epoch-1:42', operations: [] })
  ).toThrow();
});

test('a convenience patch rejects a bare-sequence cursor', () => {
  expect(() =>
    meshConvenienceFrameSchema.parse({
      kind: 'patch',
      cursor: '42',
      operations: [{ op: 'upsert', event: convenienceEvent }]
    })
  ).toThrow();
});

test('convenience unavailable carries a reason', () => {
  const parsed = meshConvenienceFrameSchema.parse({ kind: 'unavailable', reason: 'history unsupported' });
  expect(parsed).toEqual({ kind: 'unavailable', reason: 'history unsupported' });
});

test('a convenience upsert rejects an event with empty provenance', () => {
  expect(() =>
    meshConvenienceFrameSchema.parse({
      kind: 'patch',
      cursor: 'live:epoch-1:1',
      operations: [{ op: 'upsert', event: { ...convenienceEvent, provenance: { contractEvents: [] } } }]
    })
  ).toThrow();
});

test('connection snapshot connected state carries epoch, boundary, and revision', () => {
  const snapshot = {
    state: 'connected' as const,
    meshSessionId: SESSION,
    provider: 'codex' as const,
    observationEpoch: 'epoch-2',
    eventsBefore: 'live:epoch-2:9' as const,
    revision: 3
  };
  expect(meshConnectionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
});

test('connection snapshot disconnected state carries a revision without an epoch', () => {
  const parsed = meshConnectionSnapshotSchema.parse({
    state: 'disconnected',
    meshSessionId: SESSION,
    revision: 5
  });
  expect(parsed).toEqual({ state: 'disconnected', meshSessionId: SESSION, revision: 5 });
});
