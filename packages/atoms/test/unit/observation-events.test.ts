import type { AgentObservationCard } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  beginObservationEventLoad,
  completeObservationEventLoad,
  failObservationEventLoad
} from '../../src/workspace-experiences/chat-room/utils/observation-event-page-state.ts';
import {
  findOlderEventPage,
  observationEventLoadScope,
  observationEventPresentation,
  prependObservationEvents
} from '../../src/workspace-experiences/chat-room/utils/observation-events.ts';

function event(id: string, dedupeKey = id): AgentObservationCard {
  return {
    id,
    dedupeKey,
    kind: 'message',
    streaming: false,
    payload: { text: id },
    provenance: { contractEvents: [{ id }] }
  };
}

test('prependObservationEvents removes live and earlier-event overlap by stable dedupe key', () => {
  expect(
    prependObservationEvents(
      [event('events-oldest'), event('events-render-id', 'shared-provider-event')],
      [event('live-render-id', 'shared-provider-event'), event('live')]
    ).map((item) => item.id)
  ).toEqual(['events-oldest', 'events-render-id', 'live']);
});

test('findOlderEventPage follows overlap-only cursors until a new event exists', async () => {
  const cursors: Array<string | undefined> = [];
  const result = await findOlderEventPage({
    before: 'provider:',
    currentItems: [event('live', 'shared')],
    load: async (before) => {
      cursors.push(before);
      if (before === 'provider:') return { items: [event('overlap', 'shared')], nextCursor: 'provider:older-1' };
      return { items: [event('older')], nextCursor: 'provider:older-2' };
    }
  });

  expect(cursors).toEqual(['provider:', 'provider:older-1']);
  expect(result).toEqual({ items: [event('older')], nextCursor: 'provider:older-2' });
});

test('observation events load scope requires the daemon-provided events cursor', () => {
  expect([
    observationEventLoadScope({ meshSessionId: 'mesh_running' }),
    observationEventLoadScope({ meshSessionId: 'mesh_running', eventsBefore: 'provider:' }),
    observationEventLoadScope({
      meshSessionId: 'mesh_running',
      eventsBefore: 'provider:',
      observationEpoch: 'epoch-2'
    }),
    observationEventLoadScope({
      deliveryId: 'deliv_current',
      meshSessionId: 'mesh_running',
      eventsBefore: 'provider:'
    })
  ]).toEqual([undefined, 'mesh_running:provider:', 'mesh_running:epoch-2:provider:', undefined]);
});

test('observation events failure retains the attempted cursor for retry and is not exhaustion', () => {
  const loading = beginObservationEventLoad(undefined, 'provider:100');
  const failed = failObservationEventLoad(loading);
  if (!failed.nextCursor) throw new Error('Expected the failed events cursor to remain retryable');
  const retried = beginObservationEventLoad(failed, failed.nextCursor);
  const completed = completeObservationEventLoad(retried, {
    items: [event('older')],
    nextCursor: 'provider:120'
  });

  expect([loading, failed, retried, completed]).toEqual([
    { error: false, exhausted: false, items: [], loading: true, nextCursor: 'provider:100' },
    { error: true, exhausted: false, items: [], loading: false, nextCursor: 'provider:100' },
    { error: false, exhausted: false, items: [], loading: true, nextCursor: 'provider:100' },
    {
      error: false,
      exhausted: false,
      items: [event('older')],
      loading: false,
      nextCursor: 'provider:120'
    }
  ]);
});

test('observation events is exhausted only after a successful page without a next cursor', () => {
  expect(completeObservationEventLoad(beginObservationEventLoad(undefined, 'provider:100'), { items: [] })).toEqual({
    error: false,
    exhausted: true,
    items: [],
    loading: false,
    nextCursor: null
  });
});

test('MeshAgent events pages are continuous while delivery events keeps its reveal gate', () => {
  expect([
    observationEventPresentation({ hasPages: false, eventsRequested: false }),
    observationEventPresentation({ hasPages: true, eventsRequested: false }),
    observationEventPresentation({ deliveryId: 'deliv_current', hasPages: true, eventsRequested: false }),
    observationEventPresentation({ deliveryId: 'deliv_current', hasPages: true, eventsRequested: true })
  ]).toEqual([
    { active: false, includePages: true, showButton: false },
    { active: true, includePages: true, showButton: false },
    { active: false, includePages: false, showButton: true },
    { active: true, includePages: true, showButton: false }
  ]);
});
