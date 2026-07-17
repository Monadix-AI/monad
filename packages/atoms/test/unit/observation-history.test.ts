import type { AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  findOlderObservationPage,
  historyItemsThroughCheckpoint,
  observationHistoryLoadScope,
  prependObservationHistory,
  providerObservationIdentity
} from '../../src/workspace-experiences/chat-room/utils/observation-history.ts';

function event(id: string, at?: string): AgentObservationEvent {
  return {
    id,
    kind: 'assistant-message',
    streaming: false,
    text: id,
    ...(at ? { at } : {})
  };
}

function providerEvent(id: string, identity: string): AgentObservationEvent {
  return {
    ...event(id),
    raw: { type: 'assistant', uuid: identity }
  };
}

test('providerObservationIdentity reads Claude UUID and Codex turn identity on every event', () => {
  expect([
    providerObservationIdentity(providerEvent('claude', 'message-1')),
    providerObservationIdentity({
      ...event('codex-tool'),
      raw: { method: 'item/completed', params: { turnId: 'turn-1' } }
    }),
    providerObservationIdentity({
      ...event('codex'),
      raw: { method: 'turn/completed', params: { turn: { id: 'turn-1' } } }
    })
  ]).toEqual(['message-1', 'turn-1', 'turn-1']);
});

test('historyItemsThroughCheckpoint keeps the canonical prefix by provider identity', () => {
  expect(
    historyItemsThroughCheckpoint(
      [providerEvent('older', 'message-1'), providerEvent('seam', 'message-2'), providerEvent('new', 'message-3')],
      'message-2'
    )?.map((item) => item.id)
  ).toEqual(['older', 'seam']);
});

test('Codex history checkpoint includes the full completed turn rather than stopping at its first item', () => {
  const items = [
    { ...event('tool'), raw: { method: 'item/completed', params: { turnId: 'turn-1' } } },
    { ...event('completed'), raw: { method: 'turn/completed', params: { turnId: 'turn-1' } } },
    { ...event('newer'), raw: { method: 'turn/started', params: { turnId: 'turn-2' } } }
  ];

  expect(historyItemsThroughCheckpoint(items, 'turn-1')?.map((item) => item.id)).toEqual(['tool', 'completed']);
});

test('prependObservationHistory preserves chronological page order without ID deduplication', () => {
  const repeated = event('same-render-id', '2026-07-12T14:14:39.000Z');
  const result = prependObservationHistory(
    [event('oldest', '2026-07-12T14:14:38.000Z'), repeated],
    [repeated, event('live', '2026-07-12T14:14:40.000Z')]
  );

  expect(result.map((item) => item.id)).toEqual(['oldest', 'same-render-id', 'same-render-id', 'live']);
});

test('prependObservationHistory replaces live overlay records only by provider identity', () => {
  const result = prependObservationHistory(
    [providerEvent('canonical-turn', 'turn-1')],
    [providerEvent('live-replay', 'turn-1'), providerEvent('same-text-new-turn', 'turn-2')]
  );

  expect(result.map((item) => item.id)).toEqual(['canonical-turn', 'same-text-new-turn']);
});

test('findOlderObservationPage follows newer pages until the checkpoint identity appears', async () => {
  const cursors: Array<string | undefined> = [];
  const result = await findOlderObservationPage({
    before: undefined,
    checkpoint: 'message-2',
    load: async (before) => {
      cursors.push(before);
      if (!before) {
        return {
          items: [providerEvent('new', 'message-3')],
          nextCursor: 'older-1'
        };
      }
      return {
        items: [providerEvent('older', 'message-1'), providerEvent('seam', 'message-2')],
        nextCursor: 'older-2'
      };
    }
  });

  expect(cursors).toEqual([undefined, 'older-1']);
  expect(result.items.map((item) => item.id)).toEqual(['older', 'seam']);
  expect(result.nextCursor).toBe('older-2');
});

test('observation history load scope is keyed by daemon epoch and canonical checkpoint', () => {
  const scopes = [
    observationHistoryLoadScope({
      externalAgentSessionId: 'exa_running',
      observationEpoch: undefined
    }),
    observationHistoryLoadScope({
      externalAgentSessionId: 'exa_running',
      observationEpoch: 'oep_first',
      providerHistoryCheckpoint: 'message-1'
    }),
    observationHistoryLoadScope({
      externalAgentSessionId: 'exa_running',
      observationEpoch: 'oep_second',
      providerHistoryCheckpoint: 'message-1'
    }),
    observationHistoryLoadScope({
      deliveryId: 'deliv_current',
      externalAgentSessionId: 'exa_running',
      observationEpoch: 'oep_second',
      providerHistoryCheckpoint: 'message-1'
    })
  ];

  expect(scopes).toEqual([undefined, 'exa_running:oep_first:message-1', 'exa_running:oep_second:message-1', undefined]);
});
