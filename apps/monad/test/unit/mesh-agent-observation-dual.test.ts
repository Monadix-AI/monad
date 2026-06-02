// Observation Task 3: the host-side transforms that turn ephemeral live-raw-store rows into the raw
// plane's MeshRawEvent and the convenience plane's incremental frames. Pure functions so the
// resolver/routes and their tests share one mapping. See the observation dual-stream plan Task 3.

import type { AgentObservationEvent } from '@monad/protocol';
import type { LiveRawRow } from '#/services/mesh-agent/live-raw-store.ts';

import { expect, test } from 'bun:test';

import { diffObservationEvents } from '#/services/mesh-agent/host/convenience-projection.ts';
import { conveniencePatchFrame, liveRowsToRawFrames, readyFrame } from '#/services/mesh-agent/host/observation-dual.ts';

const CTX = {
  meshSessionId: 'mesh_000000000001' as const,
  provider: 'codex',
  observationEpoch: 'epoch-1'
};

const rows: LiveRawRow[] = [
  { seq: 1, stream: 'stdout', payload: '{"type":"item","uuid":"a"}', observedAt: '2026-07-18T00:00:01.000Z' },
  { seq: 2, stream: 'stdout', payload: 'plain bytes\n', observedAt: '2026-07-18T00:00:02.000Z' }
];

test('liveRowsToRawFrames maps each row to a verbatim raw frame keyed by an epoch-qualified position', () => {
  expect(liveRowsToRawFrames(CTX, rows)).toEqual([
    {
      meshSessionId: 'mesh_000000000001',
      provider: 'codex',
      observationEpoch: 'epoch-1',
      origin: 'live',
      cursor: 'live:epoch-1:1',
      stream: 'stdout',
      data: '{"type":"item","uuid":"a"}',
      observedAt: '2026-07-18T00:00:01.000Z'
    },
    {
      meshSessionId: 'mesh_000000000001',
      provider: 'codex',
      observationEpoch: 'epoch-1',
      origin: 'live',
      cursor: 'live:epoch-1:2',
      stream: 'stdout',
      data: 'plain bytes\n',
      observedAt: '2026-07-18T00:00:02.000Z'
    }
  ]);
});

const event: AgentObservationEvent = {
  id: 'ev-1',
  kind: 'assistant-message',
  streaming: false,
  text: 'hi',
  provenance: { contractEvents: [{ uuid: 'a' }] }
};

test('a patch carries every operation for one raw position under a single cursor', () => {
  expect(
    conveniencePatchFrame('live:epoch-1:7', [
      { op: 'upsert', event },
      { op: 'remove', eventId: 'ev-0' }
    ])
  ).toEqual({
    kind: 'patch',
    cursor: 'live:epoch-1:7',
    operations: [
      { op: 'upsert', event },
      { op: 'remove', eventId: 'ev-0' }
    ]
  });
});

// A position that changed nothing must not produce a frame: an empty patch would advance the
// consumer's cursor while carrying no change, which reads on the wire like a lost batch.
test('a position that projects to no change emits no patch', () => {
  expect(conveniencePatchFrame('live:epoch-1:7', [])).toBeUndefined();
});

test('readyFrame carries the epoch, earlier-events boundary, and resume anchor when present', () => {
  expect(readyFrame('epoch-1', 'provider:turn_1', 'live:epoch-1:7')).toEqual({
    kind: 'ready',
    observationEpoch: 'epoch-1',
    cursor: 'live:epoch-1:7',
    eventsBefore: 'provider:turn_1'
  });
  expect(readyFrame()).toEqual({ kind: 'ready' });
});

test('diffObservationEvents emits only what the projection actually changed', () => {
  const changed = { ...event, text: 'hi there' };
  const added: AgentObservationEvent = { ...event, id: 'ev-2', text: 'second' };

  expect(diffObservationEvents([event], [changed, added])).toEqual([
    { op: 'upsert', event: changed },
    { op: 'upsert', event: added }
  ]);
  expect(diffObservationEvents([event, added], [event])).toEqual([{ op: 'remove', eventId: 'ev-2' }]);
  expect(diffObservationEvents([event], [event])).toEqual([]);
});

// Removals precede upserts so a consumer keyed by event.id never briefly holds two rows for one
// entity while applying a patch.
test('diffObservationEvents orders removals before upserts', () => {
  const replacement: AgentObservationEvent = { ...event, id: 'ev-2' };

  expect(diffObservationEvents([event], [replacement])).toEqual([
    { op: 'remove', eventId: 'ev-1' },
    { op: 'upsert', event: replacement }
  ]);
});
