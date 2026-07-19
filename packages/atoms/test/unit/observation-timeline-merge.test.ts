// Observation Task 5: folding the convenience plane's atomic patches into an ordered timeline. A
// patch carries every operation for ONE raw position and is applied against a single working copy —
// `upsert` replaces by stable event id (so a streaming item's later delta updates the same row rather
// than appending a duplicate), `remove` retracts by id, `ready`/`unavailable` don't mutate the list.
// Pure protocol logic — the panel's render layer consumes it. See the observation dual-stream plan T5.

import type {
  AgentObservationEvent,
  MeshConvenienceFrame,
  MeshConvenienceOperation,
  ObservationCursor
} from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  emptyObservationTimeline,
  mergeConvenienceFrame,
  mergeConvenienceFrames
} from '../../src/workspace-experiences/chat-room/components/observation/timeline-merge.ts';

function event(id: string, text: string, streaming = false): AgentObservationEvent {
  return { id, kind: 'assistant-message', streaming, text, provenance: { contractEvents: [{ id }] } };
}

const patch = (cursor: ObservationCursor, ...operations: MeshConvenienceOperation[]): MeshConvenienceFrame => ({
  kind: 'patch',
  cursor,
  operations
});

const upsert = (event: AgentObservationEvent): MeshConvenienceOperation => ({ op: 'upsert', event });

test('upserts append in arrival order', () => {
  const timeline = mergeConvenienceFrames(emptyObservationTimeline, [
    patch('live:e1:1', upsert(event('a', 'one'))),
    patch('live:e1:2', upsert(event('b', 'two')))
  ]);
  expect(timeline.events).toEqual([event('a', 'one'), event('b', 'two')]);
});

test('an upsert for an existing id replaces in place, keeping position', () => {
  const timeline = mergeConvenienceFrames(emptyObservationTimeline, [
    patch('live:e1:1', upsert(event('a', 'partial', true))),
    patch('live:e1:2', upsert(event('b', 'two'))),
    patch('live:e1:3', upsert(event('a', 'final settled')))
  ]);
  expect(timeline.events).toEqual([event('a', 'final settled'), event('b', 'two')]);
});

test('remove retracts the event by id', () => {
  const timeline = mergeConvenienceFrames(emptyObservationTimeline, [
    patch('live:e1:1', upsert(event('a', 'one')), upsert(event('b', 'two'))),
    patch('live:e1:2', { op: 'remove', eventId: 'a' })
  ]);
  expect(timeline.events).toEqual([event('b', 'two')]);
});

// The reason the patch is atomic: one raw position can project to several operations, and they must
// land together or a mid-batch reconnect would resume past the ones it never received.
test('one patch applies every operation it carries, in order', () => {
  const timeline = mergeConvenienceFrames(emptyObservationTimeline, [
    patch('live:e1:1', upsert(event('a', 'one')), upsert(event('b', 'two'))),
    patch('live:e1:2', { op: 'remove', eventId: 'a' }, upsert(event('c', 'three')), upsert(event('b', 'two revised')))
  ]);
  expect(timeline.events).toEqual([event('b', 'two revised'), event('c', 'three')]);
  expect(timeline.cursor).toBe('live:e1:2');
});

test('a patch advances the cursor without touching event identity', () => {
  const timeline = mergeConvenienceFrame(emptyObservationTimeline, patch('live:e1:9', upsert(event('a', 'one'))));
  expect(timeline.cursor).toBe('live:e1:9');
  expect(timeline.events.map((e) => e.id)).toEqual(['a']);
});

test('ready records the epoch, resume anchor, and events boundary without mutating events', () => {
  let timeline = mergeConvenienceFrame(emptyObservationTimeline, patch('live:e1:1', upsert(event('a', 'one'))));
  timeline = mergeConvenienceFrame(timeline, {
    kind: 'ready',
    observationEpoch: 'e1',
    cursor: 'live:e1:1',
    eventsBefore: 'provider:turn_9'
  });
  expect(timeline).toEqual({
    events: [event('a', 'one')],
    epoch: 'e1',
    cursor: 'live:e1:1',
    eventsBefore: 'provider:turn_9',
    unavailableReason: null
  });
});

test('ready for a new epoch discards events and positions from the stale epoch', () => {
  const stale = mergeConvenienceFrames(emptyObservationTimeline, [
    {
      kind: 'ready',
      observationEpoch: 'e1',
      cursor: 'live:e1:0',
      eventsBefore: 'provider:old'
    },
    patch('live:e1:3', upsert(event('old', 'stale')))
  ]);

  expect(
    mergeConvenienceFrame(stale, {
      kind: 'ready',
      observationEpoch: 'e2',
      cursor: 'live:e2:0',
      eventsBefore: 'provider:new'
    })
  ).toEqual({
    events: [],
    epoch: 'e2',
    cursor: 'live:e2:0',
    eventsBefore: 'provider:new',
    unavailableReason: null
  });
});

test('unavailable records the reason and leaves the existing timeline intact', () => {
  let timeline = mergeConvenienceFrame(emptyObservationTimeline, patch('live:e1:1', upsert(event('a', 'one'))));
  timeline = mergeConvenienceFrame(timeline, { kind: 'unavailable', reason: 'events unsupported' });
  expect(timeline.events).toEqual([event('a', 'one')]);
  expect(timeline.unavailableReason).toBe('events unsupported');
});

test('a duplicate id across a events/live join folds to one row', () => {
  const eventsThenLive = mergeConvenienceFrames(emptyObservationTimeline, [
    patch('provider:h1', upsert(event('x', 'from events'))),
    patch('live:e1:4', upsert(event('x', 'from live')))
  ]);
  expect(eventsThenLive.events).toEqual([event('x', 'from live')]);
});

// Idempotence is what makes a stale-epoch replay safe: the server re-sends operations the client may
// already hold, and re-applying them must not duplicate or reorder rows.
test('replaying a patch is idempotent', () => {
  const frames = [patch('live:e1:1', upsert(event('a', 'one')), upsert(event('b', 'two')))];
  const once = mergeConvenienceFrames(emptyObservationTimeline, frames);
  const twice = mergeConvenienceFrames(once, frames);
  expect(twice).toEqual(once);
});
