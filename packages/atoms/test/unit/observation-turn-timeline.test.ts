import type { AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { agentObservationCards } from '../../src/agent-adapters/observation-cards.ts';
import {
  type ObservationTurnTimelineItem,
  observationTurnTimelineItems
} from '../../src/workplace-experiences/chat-room/components/observation/turn-timeline.ts';

function event(id: string, kind: AgentObservationEvent['kind'], text?: string): AgentObservationEvent {
  return {
    id,
    kind,
    streaming: false,
    ...(text ? { text } : {}),
    provenance: { contractEvents: [{ id, kind, text }] }
  };
}

function project(events: AgentObservationEvent[]) {
  return observationTurnTimelineItems(agentObservationCards(events, 'codex'), 'codex');
}

function itemShape(item: ObservationTurnTimelineItem) {
  return { rowId: item.row.id };
}

test('explicit turn boundaries stay structural and do not create timeline rows', () => {
  const items = project([
    event('turn-1-start', 'turn-start'),
    event('turn-1-user', 'user-message', 'question'),
    event('turn-1-assistant', 'assistant-message', 'answer'),
    event('turn-1-end', 'turn-end')
  ]);

  expect(items.map(itemShape)).toEqual([{ rowId: 'turn-1-user' }, { rowId: 'turn-1-assistant' }]);
});

test('turn timestamps fill missing user and assistant message times only', () => {
  const start = { ...event('turn-time-start', 'turn-start'), at: '2026-08-09T04:38:54.000Z' };
  const end = { ...event('turn-time-end', 'turn-end'), at: '2026-08-09T04:39:22.000Z' };
  const items = project([
    start,
    event('turn-time-user', 'user-message', 'question'),
    event('turn-time-reasoning', 'reasoning', 'thinking'),
    event('turn-time-tool', 'tool-call', 'tool'),
    event('turn-time-assistant', 'assistant-message', 'answer'),
    end
  ]);

  expect(items.map((item) => ({ id: item.id, timestamp: item.row.entries[0]?.timestamp }))).toEqual([
    { id: 'turn-time-user', timestamp: start.at },
    { id: 'turn-time-reasoning', timestamp: undefined },
    { id: 'turn-time-tool', timestamp: undefined },
    { id: 'turn-time-assistant', timestamp: end.at }
  ]);
});

test('a later turn start separates an orphan from the final turn', () => {
  const items = project([
    event('turn-1-start', 'turn-start'),
    event('turn-1-assistant', 'assistant-message', 'first'),
    event('turn-2-start', 'turn-start'),
    event('turn-2-assistant', 'assistant-message', 'second')
  ]);

  expect(items.map(itemShape)).toEqual([{ rowId: 'turn-1-assistant' }, { rowId: 'turn-2-assistant' }]);
});

test('unknown system activity stays hidden while unmatched turn ends stay structural', () => {
  const items = project([
    event('before', 'system', 'before'),
    event('orphan-end', 'turn-end'),
    event('turn-start', 'turn-start'),
    event('inside', 'reasoning', 'inside'),
    event('turn-end', 'turn-end'),
    event('after', 'system', 'after')
  ]);

  expect(items.map(itemShape)).toEqual([{ rowId: 'inside' }]);
});

test('consecutive starts do not create empty timeline rows', () => {
  const items = project([event('turn-1-start', 'turn-start'), event('turn-2-start', 'turn-start')]);

  expect(items.map(itemShape)).toEqual([]);
});

test('turn bodies stay visible after prepending older events', () => {
  const currentEvents = [
    event('current-start', 'turn-start'),
    event('current-body', 'assistant-message', 'current'),
    event('current-end', 'turn-end')
  ];
  const olderEvents = [
    event('older-start', 'turn-start'),
    event('older-body', 'assistant-message', 'older'),
    event('older-end', 'turn-end')
  ];
  const before = project(currentEvents);
  const after = project([...olderEvents, ...currentEvents]);

  expect(before.map(itemShape)).toEqual([{ rowId: 'current-body' }]);
  expect(after.map(itemShape)).toEqual([{ rowId: 'older-body' }, { rowId: 'current-body' }]);
});
