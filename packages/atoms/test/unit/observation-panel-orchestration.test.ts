// Observation Task 5: the pure orchestration that turns control notifications, stream frames, and
// history pages into the panel's rendered planes. React glue (useObservationPanel) is a thin wrapper
// over these; testing them here keeps the decision logic verifiable without a DOM.

import type {
  AgentObservationEvent,
  Event,
  ExternalAgentConvenienceFrame,
  ExternalAgentRawFrame,
  ExternalAgentRawHistoryPage
} from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  connectionControlAction,
  convenienceHistoryRequest,
  convenienceStreamView,
  foldConvenienceHistory,
  foldRawFrame,
  rawHistoryRows
} from '../../src/workspace-experiences/chat-room/components/observation/observation-panel-orchestration.ts';
import { emptyObservationTimeline } from '../../src/workspace-experiences/chat-room/components/observation/timeline-merge.ts';

const SESSION = 'exa_000000000001';
const OTHER = 'exa_000000000002';

function controlEvent(type: Event['type'], payload: Record<string, unknown>): Event {
  return {
    id: 'evt_000000000001',
    sessionId: 'ses_000000000001',
    type,
    actorAgentId: null,
    payload,
    at: '2026-07-19T00:00:00.000Z'
  } as Event;
}

function rawFrame(cursor: string, data: unknown, stream?: ExternalAgentRawFrame['stream']): ExternalAgentRawFrame {
  return {
    externalAgentSessionId: SESSION,
    provider: 'codex',
    origin: 'live',
    cursor,
    ...(stream ? { stream } : {}),
    data
  } as ExternalAgentRawFrame;
}

function observationEvent(id: string, text: string): AgentObservationEvent {
  return {
    id,
    kind: 'assistant-message',
    streaming: false,
    text,
    provenance: { contractEvents: [{ raw: id }] }
  };
}

test('connection.opened for the observed session requests a snapshot refetch', () => {
  const action = connectionControlAction(
    controlEvent('external_agent.session.connection.opened', {
      externalAgentSessionId: SESSION,
      provider: 'codex',
      observationEpoch: 'e1'
    }),
    SESSION
  );
  expect(action).toEqual({ kind: 'refetch' });
});

test('connection.closed for the observed session tears down the matching epoch', () => {
  const action = connectionControlAction(
    controlEvent('external_agent.session.connection.closed', {
      externalAgentSessionId: SESSION,
      provider: 'codex',
      observationEpoch: 'e2',
      reason: 'exited'
    }),
    SESSION
  );
  expect(action).toEqual({ kind: 'dispatch', event: { type: 'connectionClosed', epoch: 'e2' } });
});

test('a connection notification for a different session is ignored', () => {
  const action = connectionControlAction(
    controlEvent('external_agent.session.connection.opened', {
      externalAgentSessionId: OTHER,
      provider: 'codex',
      observationEpoch: 'e1'
    }),
    SESSION
  );
  expect(action).toBeNull();
});

test('a non-connection event yields no action', () => {
  const action = connectionControlAction(
    controlEvent('external_agent.exited', { externalAgentSessionId: SESSION }),
    SESSION
  );
  expect(action).toBeNull();
});

test('a connection notification with a malformed payload yields no action', () => {
  const action = connectionControlAction(
    controlEvent('external_agent.session.connection.closed', { externalAgentSessionId: SESSION }),
    SESSION
  );
  expect(action).toBeNull();
});

test('raw frames accumulate in order and dedupe a re-delivered cursor', () => {
  let rows = foldRawFrame([], rawFrame('c1', 'first', 'stdout'));
  rows = foldRawFrame(rows, rawFrame('c2', 'second', 'stderr'));
  rows = foldRawFrame(rows, rawFrame('c1', 'first-updated', 'stdout'));
  expect(rows).toEqual([
    { cursor: 'c1', stream: 'stdout', preview: 'first-updated' },
    { cursor: 'c2', stream: 'stderr', preview: 'second' }
  ]);
});

test('a raw frame with no stream classification renders as unknown, structured data serialized', () => {
  const rows = foldRawFrame([], rawFrame('c9', { a: 1 }));
  expect(rows).toEqual([{ cursor: 'c9', stream: 'unknown', preview: '{"a":1}' }]);
});

test('raw history records map to rows verbatim; a missing cursor collapses to empty', () => {
  const page: ExternalAgentRawHistoryPage = {
    coverage: 'exact',
    records: [{ cursor: 'h1', data: 'raw-text' }, { data: { k: 'v' } }]
  };
  expect(rawHistoryRows(page)).toEqual([
    { cursor: 'h1', stream: 'unknown', preview: 'raw-text' },
    { cursor: '', stream: 'unknown', preview: '{"k":"v"}' }
  ]);
});

test('convenience history folds ahead of the live timeline and records the epoch boundary', () => {
  const frames: ExternalAgentConvenienceFrame[] = [
    { kind: 'ready', observationEpoch: 'e1', historyBefore: 'b1' },
    { kind: 'upsert', cursor: 'c1', event: observationEvent('o1', 'hello') }
  ];
  const timeline = foldConvenienceHistory(emptyObservationTimeline, frames);
  expect(timeline).toEqual({
    events: [observationEvent('o1', 'hello')],
    epoch: 'e1',
    historyBefore: 'b1',
    unavailableReason: null
  });
});

test('convenience history request carries the boundary cursor and descending paging', () => {
  expect(convenienceHistoryRequest('b1')).toEqual({
    limit: 20,
    sortDirection: 'desc',
    itemsView: 'summary',
    before: 'b1'
  });
  expect(convenienceHistoryRequest(null)).toEqual({ limit: 20, sortDirection: 'desc', itemsView: 'summary' });
});

test('convenience stream view exposes folded events and a running status while connected', () => {
  const view = convenienceStreamView(
    { id: SESSION, transcriptTargetId: 'ses_000000000001', agentName: 'Codex', provider: 'codex' },
    [observationEvent('o1', 'hi')],
    true
  );
  expect(view).toEqual({
    id: SESSION,
    transcriptTargetId: 'ses_000000000001',
    agentName: 'Codex',
    provider: 'codex',
    tag: 'Agent',
    status: 'running',
    output: '',
    items: [observationEvent('o1', 'hi')]
  });
});

test('convenience stream view reports an idle status when disconnected', () => {
  const view = convenienceStreamView({ id: SESSION, agentName: 'Codex', provider: 'codex' }, [], false);
  expect(view.status).toBe('ok');
});
