import type { AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  findOlderObservationPage,
  observationHistoryLoadScope,
  observationHistoryPresentation,
  prependObservationHistory
} from '../../src/workspace-experiences/chat-room/utils/observation-history.ts';
import {
  beginObservationHistoryLoad,
  completeObservationHistoryLoad,
  failObservationHistoryLoad
} from '../../src/workspace-experiences/chat-room/utils/observation-history-state.ts';

function event(id: string, dedupeKey = id): AgentObservationEvent {
  return {
    id,
    dedupeKey,
    kind: 'assistant-message',
    streaming: false,
    text: id,
    provenance: { contractEvents: [{ id }] }
  };
}

test('prependObservationHistory removes live and history overlap by stable dedupe key', () => {
  expect(
    prependObservationHistory(
      [event('history-oldest'), event('history-render-id', 'shared-provider-event')],
      [event('live-render-id', 'shared-provider-event'), event('live')]
    ).map((item) => item.id)
  ).toEqual(['history-oldest', 'history-render-id', 'live']);
});

test('findOlderObservationPage follows overlap-only cursors until a new event exists', async () => {
  const cursors: Array<string | undefined> = [];
  const result = await findOlderObservationPage({
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

test('observation history load scope requires the daemon-provided history cursor', () => {
  expect([
    observationHistoryLoadScope({ externalAgentSessionId: 'exa_running' }),
    observationHistoryLoadScope({ externalAgentSessionId: 'exa_running', historyBefore: 'provider:' }),
    observationHistoryLoadScope({
      externalAgentSessionId: 'exa_running',
      historyBefore: 'provider:',
      observationEpoch: 'epoch-2'
    }),
    observationHistoryLoadScope({
      deliveryId: 'deliv_current',
      externalAgentSessionId: 'exa_running',
      historyBefore: 'provider:'
    })
  ]).toEqual([undefined, 'exa_running:provider:', 'exa_running:epoch-2:provider:', undefined]);
});

test('observation history failure retains the attempted cursor for retry and is not exhaustion', () => {
  const loading = beginObservationHistoryLoad(undefined, 'provider:100');
  const failed = failObservationHistoryLoad(loading);
  if (!failed.nextCursor) throw new Error('Expected the failed history cursor to remain retryable');
  const retried = beginObservationHistoryLoad(failed, failed.nextCursor);
  const completed = completeObservationHistoryLoad(retried, {
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

test('observation history is exhausted only after a successful page without a next cursor', () => {
  expect(completeObservationHistoryLoad(beginObservationHistoryLoad(undefined, 'provider:100'), { items: [] })).toEqual(
    { error: false, exhausted: true, items: [], loading: false, nextCursor: null }
  );
});

test('external agent history pages are continuous while delivery history keeps its reveal gate', () => {
  expect([
    observationHistoryPresentation({ hasPages: false, historyRequested: false }),
    observationHistoryPresentation({ hasPages: true, historyRequested: false }),
    observationHistoryPresentation({ deliveryId: 'deliv_current', hasPages: true, historyRequested: false }),
    observationHistoryPresentation({ deliveryId: 'deliv_current', hasPages: true, historyRequested: true })
  ]).toEqual([
    { active: false, includePages: true, showButton: false },
    { active: true, includePages: true, showButton: false },
    { active: false, includePages: false, showButton: true },
    { active: true, includePages: true, showButton: false }
  ]);
});
