// Observation Task 5: folding the convenience plane's incremental frames into an ordered timeline.
// `upsert` replaces by stable event id (so a streaming item's later delta updates the same row rather
// than appending a duplicate), `remove` retracts by id, `ready`/`unavailable` don't mutate the list.
// Pure protocol logic — the panel's render layer consumes it. See the observation dual-stream plan T5.

import type { AgentObservationEvent, ExternalAgentConvenienceFrame } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  emptyObservationTimeline,
  mergeConvenienceFrame,
  mergeConvenienceFrames
} from '../../src/workspace-experiences/chat-room/components/observation/timeline-merge.ts';

function event(id: string, text: string, streaming = false): AgentObservationEvent {
  return { id, kind: 'assistant-message', streaming, text, provenance: { contractEvents: [{ id }] } };
}

const upsert = (event: AgentObservationEvent, cursor = event.id): ExternalAgentConvenienceFrame => ({
  kind: 'upsert',
  cursor,
  event
});

test('upserts append in arrival order', () => {
  const timeline = mergeConvenienceFrames(emptyObservationTimeline, [
    upsert(event('a', 'one')),
    upsert(event('b', 'two'))
  ]);
  expect(timeline.events).toEqual([event('a', 'one'), event('b', 'two')]);
});

test('an upsert for an existing id replaces in place, keeping position', () => {
  const timeline = mergeConvenienceFrames(emptyObservationTimeline, [
    upsert(event('a', 'partial', true)),
    upsert(event('b', 'two')),
    upsert(event('a', 'final settled'))
  ]);
  expect(timeline.events).toEqual([event('a', 'final settled'), event('b', 'two')]);
});

test('remove retracts the event by id', () => {
  const timeline = mergeConvenienceFrames(emptyObservationTimeline, [
    upsert(event('a', 'one')),
    upsert(event('b', 'two')),
    { kind: 'remove', cursor: 'c1', eventId: 'a' }
  ]);
  expect(timeline.events).toEqual([event('b', 'two')]);
});

test('ready records the epoch and history boundary without mutating events', () => {
  let timeline = mergeConvenienceFrame(emptyObservationTimeline, upsert(event('a', 'one')));
  timeline = mergeConvenienceFrame(timeline, { kind: 'ready', observationEpoch: 'e1', historyBefore: '9' });
  expect(timeline).toEqual({ events: [event('a', 'one')], epoch: 'e1', historyBefore: '9', unavailableReason: null });
});

test('unavailable records the reason and leaves the existing timeline intact', () => {
  let timeline = mergeConvenienceFrame(emptyObservationTimeline, upsert(event('a', 'one')));
  timeline = mergeConvenienceFrame(timeline, { kind: 'unavailable', reason: 'history unsupported' });
  expect(timeline.events).toEqual([event('a', 'one')]);
  expect(timeline.unavailableReason).toBe('history unsupported');
});

test('a duplicate id across a history/live join folds to one row', () => {
  const historyThenLive = mergeConvenienceFrames(emptyObservationTimeline, [
    upsert(event('x', 'from history'), 'h1'),
    upsert(event('x', 'from live'), 'l1')
  ]);
  expect(historyThenLive.events).toEqual([event('x', 'from live')]);
});
