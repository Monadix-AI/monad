// Observation Task 5: the pure orchestration that turns control notifications, stream frames, and
// events pages into the panel's rendered planes. React glue (useObservationPanel) is a thin wrapper
// over these; testing them here keeps the decision logic verifiable without a DOM.

import type {
  AgentObservationEvent,
  Event,
  MeshConvenienceFrame,
  MeshRawEvent,
  MeshRawEventPage
} from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  connectionControlAction,
  convenienceEventsRequest,
  convenienceStreamView,
  foldConvenienceEvents,
  foldRawFrame,
  observationEventBootstrap,
  observationPanelLoading,
  prependRawEventsRows,
  rawEventsRows
} from '../../src/workspace-experiences/chat-room/components/observation/observation-panel-orchestration.ts';
import { emptyObservationTimeline } from '../../src/workspace-experiences/chat-room/components/observation/timeline-merge.ts';

const SESSION = 'mesh_000000000001';
const OTHER = 'mesh_000000000002';

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

function rawFrame(cursor: string, data: unknown, stream?: MeshRawEvent['stream']): MeshRawEvent {
  return {
    meshSessionId: SESSION,
    provider: 'codex',
    origin: 'live',
    cursor,
    ...(stream ? { stream } : {}),
    data
  } as MeshRawEvent;
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
    controlEvent('mesh.session.connection.opened', {
      meshSessionId: SESSION,
      provider: 'codex',
      observationEpoch: 'e1'
    }),
    SESSION
  );
  expect(action).toEqual({ kind: 'refetch' });
});

test('connection.closed for the observed session tears down the matching epoch', () => {
  const action = connectionControlAction(
    controlEvent('mesh.session.connection.closed', {
      meshSessionId: SESSION,
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
    controlEvent('mesh.session.connection.opened', {
      meshSessionId: OTHER,
      provider: 'codex',
      observationEpoch: 'e1'
    }),
    SESSION
  );
  expect(action).toBeNull();
});

test('a non-connection event yields no action', () => {
  const action = connectionControlAction(controlEvent('mesh.exited', { meshSessionId: SESSION }), SESSION);
  expect(action).toBeNull();
});

test('a connection notification with a malformed payload yields no action', () => {
  const action = connectionControlAction(
    controlEvent('mesh.session.connection.closed', { meshSessionId: SESSION }),
    SESSION
  );
  expect(action).toBeNull();
});

test('raw frames accumulate in order and dedupe a re-delivered cursor', () => {
  let rows = foldRawFrame([], rawFrame('c1', 'first', 'stdout'));
  rows = foldRawFrame(rows, rawFrame('c2', 'second', 'stderr'));
  rows = foldRawFrame(rows, rawFrame('c1', 'first-updated', 'stdout'));
  expect(rows).toEqual([
    { identity: 'c1', cursor: 'c1', stream: 'stdout', preview: 'first-updated' },
    { identity: 'c2', cursor: 'c2', stream: 'stderr', preview: 'second' }
  ]);
});

test('a raw frame with no stream classification renders as unknown, structured data serialized', () => {
  const rows = foldRawFrame([], rawFrame('c9', { a: 1 }));
  expect(rows).toEqual([{ identity: 'c9', cursor: 'c9', stream: 'unknown', preview: '{"a":1}' }]);
});

test('raw events records map to rows verbatim; a missing cursor collapses to empty', () => {
  const page: MeshRawEventPage = {
    coverage: 'exact',
    records: [{ cursor: 'h1', data: 'raw-text' }, { data: { k: 'v' } }]
  };
  expect(rawEventsRows(page)).toEqual([
    { identity: 'h1', cursor: 'h1', stream: 'unknown', preview: 'raw-text' },
    { identity: 'events:1', cursor: '', stream: 'unknown', preview: '{"k":"v"}' }
  ]);
});

test('raw events prepend keeps older rows first and removes the overlapping boundary row', () => {
  const older = rawEventsRows({ coverage: 'exact', records: [{ cursor: 'h1', data: 'older' }] });
  const current = rawEventsRows({
    coverage: 'exact',
    records: [
      { cursor: 'h1', data: 'overlap' },
      { cursor: 'h2', data: 'newer' }
    ]
  });
  expect(prependRawEventsRows(older, current).map((row) => row.cursor)).toEqual(['h1', 'h2']);
});

test('convenience events folds ahead of the live timeline and records the epoch boundary', () => {
  const frames: MeshConvenienceFrame[] = [
    { kind: 'ready', observationEpoch: 'e1', cursor: 'live:e1:3', eventsBefore: 'provider:b1' },
    { kind: 'patch', cursor: 'provider:b1', operations: [{ op: 'upsert', event: observationEvent('o1', 'hello') }] }
  ];
  const timeline = foldConvenienceEvents(emptyObservationTimeline, frames);
  expect(timeline).toEqual({
    events: [observationEvent('o1', 'hello')],
    epoch: 'e1',
    cursor: 'provider:b1',
    eventsBefore: 'provider:b1',
    unavailableReason: null
  });
});

test('older convenience events is prepended ahead of already received live events', () => {
  const current = {
    ...emptyObservationTimeline,
    events: [observationEvent('live', 'newer')]
  };
  const frames: MeshConvenienceFrame[] = [
    {
      kind: 'patch',
      cursor: 'provider:older',
      operations: [{ op: 'upsert', event: observationEvent('events', 'older') }]
    }
  ];

  expect(foldConvenienceEvents(current, frames).events.map((event) => event.id)).toEqual(['events', 'live']);
});

test('an older page whose positional id differs joins the live row it duplicates by dedupe key', () => {
  const live: AgentObservationEvent = {
    ...observationEvent('mesh:json:0:message', 'shared'),
    dedupeKey: 'codex:shared'
  };
  const older: AgentObservationEvent = {
    ...observationEvent('mesh@oep:9:json:0:message', 'shared'),
    dedupeKey: 'codex:shared'
  };
  const current = { ...emptyObservationTimeline, events: [live] };
  const frames: MeshConvenienceFrame[] = [
    { kind: 'patch', cursor: 'live:oep:9', operations: [{ op: 'upsert', event: older }] }
  ];

  expect(foldConvenienceEvents(current, frames).events).toEqual([live]);
});

test('older page events with their own dedupe keys prepend ahead of the live rows', () => {
  const live: AgentObservationEvent = {
    ...observationEvent('mesh:json:0:message', 'newer'),
    dedupeKey: 'codex:newer'
  };
  const older: AgentObservationEvent = {
    ...observationEvent('mesh@oep:9:json:0:message', 'older'),
    dedupeKey: 'codex:older'
  };
  const current = { ...emptyObservationTimeline, events: [live] };
  const frames: MeshConvenienceFrame[] = [
    { kind: 'patch', cursor: 'live:oep:9', operations: [{ op: 'upsert', event: older }] }
  ];

  expect(foldConvenienceEvents(current, frames).events.map((event) => event.text)).toEqual(['older', 'newer']);
});

test('convenience event request carries the boundary cursor', () => {
  expect(convenienceEventsRequest('provider:b1')).toEqual({
    limit: 20,
    before: 'provider:b1'
  });
  expect(convenienceEventsRequest(null)).toEqual({ limit: 20 });
});

test('opening a disconnected observation panel bootstraps the latest provider events page', () => {
  expect(
    observationEventBootstrap({
      panelOpen: true,
      connectionKnown: true,
      connected: false,
      eventsBefore: null
    })
  ).toEqual({
    key: 'disconnected:latest',
    request: { limit: 20 }
  });
});

test('disconnected provider events keeps the panel loading until bootstrap settles', () => {
  expect(
    observationPanelLoading({
      panelOpen: true,
      contentAvailable: false,
      connectionLoading: false,
      connectionKnown: true,
      liveWaiting: false,
      eventsWaiting: true,
      eventsLoading: true
    })
  ).toBe(true);
});

test('loading an older events page keeps already rendered activity visible', () => {
  expect(
    observationPanelLoading({
      panelOpen: true,
      contentAvailable: true,
      connectionLoading: false,
      connectionKnown: true,
      liveWaiting: false,
      eventsWaiting: false,
      eventsLoading: true
    })
  ).toBe(false);
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
    items: [
      {
        id: 'o1',
        kind: 'message',
        streaming: false,
        payload: { provider: 'codex', event: observationEvent('o1', 'hi') },
        provenance: { contractEvents: [{ raw: 'o1' }] }
      }
    ]
  });
});

test('convenience stream view reports an idle status when disconnected', () => {
  const view = convenienceStreamView({ id: SESSION, agentName: 'Codex', provider: 'codex' }, [], false);
  expect(view.status).toBe('ok');
});
