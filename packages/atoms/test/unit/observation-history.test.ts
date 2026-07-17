import type { AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  findOlderObservationPage,
  observationHistoryLoadScope,
  prependObservationHistory
} from '../../src/workspace-experiences/chat-room/utils/observation-history.ts';

function event(id: string, dedupeKey = id): AgentObservationEvent {
  return { id, dedupeKey, kind: 'assistant-message', streaming: false, text: id };
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
