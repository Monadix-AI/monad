import type { AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  findOlderObservationPage,
  historyItemsBefore,
  observationHistoryLoadScope,
  oldestObservationTimestamp,
  prependObservationHistory
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

test('oldestObservationTimestamp returns the earliest valid provider time', () => {
  expect(
    oldestObservationTimestamp([
      event('latest', '2026-07-12T14:17:48.887Z'),
      event('untimed'),
      event('earliest', '2026-07-12T14:14:40.000Z')
    ])
  ).toBe('2026-07-12T14:14:40.000Z');
});

test('historyItemsBefore keeps only timestamped observations strictly before the live seam', () => {
  expect(
    historyItemsBefore(
      [
        event('older', '2026-07-12T14:14:39.999Z'),
        event('seam', '2026-07-12T14:14:40.000Z'),
        event('overlap', '2026-07-12T14:17:48.887Z'),
        event('untimed')
      ],
      '2026-07-12T14:14:40.000Z'
    ).map((item) => item.id)
  ).toEqual(['older']);
});

test('prependObservationHistory preserves chronological page order without ID deduplication', () => {
  const repeated = event('same-render-id', '2026-07-12T14:14:39.000Z');
  const result = prependObservationHistory(
    [event('oldest', '2026-07-12T14:14:38.000Z'), repeated],
    [repeated, event('live', '2026-07-12T14:14:40.000Z')]
  );

  expect(result.map((item) => item.id)).toEqual(['oldest', 'same-render-id', 'same-render-id', 'live']);
});

test('findOlderObservationPage follows overlap-only cursors until an older page exists', async () => {
  const cursors: Array<string | undefined> = [];
  const result = await findOlderObservationPage({
    before: undefined,
    liveBoundaryAt: '2026-07-12T14:14:40.000Z',
    load: async (before) => {
      cursors.push(before);
      if (!before) {
        return {
          items: [event('overlap', '2026-07-12T14:17:48.887Z')],
          nextCursor: 'older-1'
        };
      }
      return {
        items: [event('older', '2026-07-12T14:14:39.000Z')],
        nextCursor: 'older-2'
      };
    }
  });

  expect(cursors).toEqual([undefined, 'older-1']);
  expect(result.items.map((item) => item.id)).toEqual(['older']);
  expect(result.nextCursor).toBe('older-2');
});

test('observation history keeps one load scope while the bounded live seam advances', () => {
  const scopes = [
    observationHistoryLoadScope({
      externalAgentSessionId: 'exa_running',
      liveBoundaryAt: undefined
    }),
    observationHistoryLoadScope({
      externalAgentSessionId: 'exa_running',
      liveBoundaryAt: '2026-07-17T05:39:45.999Z'
    }),
    observationHistoryLoadScope({
      externalAgentSessionId: 'exa_running',
      liveBoundaryAt: '2026-07-17T05:44:08.059Z'
    }),
    observationHistoryLoadScope({
      deliveryId: 'deliv_current',
      externalAgentSessionId: 'exa_running',
      liveBoundaryAt: '2026-07-17T05:44:08.059Z'
    })
  ];

  expect(scopes).toEqual([undefined, 'exa_running', 'exa_running', undefined]);
});
