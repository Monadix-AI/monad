import type {
  EventId,
  MeshAgentLoginRequirement,
  MeshAgentPendingApproval,
  MeshAgentStateEvent,
  MeshAgentStateFrame
} from '@monad/protocol';

import { expect, test } from 'bun:test';
import { meshAgentStateLifecycleEventSchema } from '@monad/protocol';

import {
  applyMeshAgentStateFrame,
  initialMeshAgentStateStreamState,
  MAX_MESH_AGENT_STATE_EVENTS
} from '../../src/endpoints/mesh-agent/stream-mesh-agent-state.ts';

const login: MeshAgentLoginRequirement = {
  id: 'mesh-login:codex:codex',
  observedAt: '2026-07-23T00:00:00.000Z',
  agentName: 'codex',
  authAgentName: 'codex',
  provider: 'codex',
  reason: 'authentication required'
};
const approval: MeshAgentPendingApproval = {
  requestId: 'req-1',
  meshSessionId: 'mesh_1234567890ab',
  provider: 'codex',
  text: 'approve',
  requestedAt: '2026-07-23T00:00:00.000Z'
};

const evtId = (index: number): EventId => `evt_${String(index).padStart(12, '0')}` as EventId;

function event(index: number): MeshAgentStateEvent {
  return {
    id: evtId(index),
    sessionId: 'ses_1234567890ab',
    type: 'mesh.turn_started',
    actorAgentId: null,
    payload: { meshSessionId: 'mesh_1234567890ab' },
    at: '2026-07-23T00:00:01.000Z'
  };
}

function meshFrameEvent(index: number, type: string, payload: Record<string, unknown>): MeshAgentStateFrame {
  return {
    kind: 'event',
    event: {
      id: evtId(index),
      sessionId: 'ses_1234567890ab',
      type,
      actorAgentId: null,
      payload,
      at: '2026-07-23T00:00:01.000Z'
    } as MeshAgentStateEvent
  };
}

const floodTail = (state: ReturnType<typeof initialMeshAgentStateStreamState>, from: number): void => {
  for (let index = from; index <= from + MAX_MESH_AGENT_STATE_EVENTS + 4; index++) {
    applyMeshAgentStateFrame(state, { kind: 'event', event: event(index) });
  }
};

test('a replacement snapshot atomically clears prior domain records and event history', () => {
  const state = initialMeshAgentStateStreamState();
  applyMeshAgentStateFrame(state, {
    kind: 'snapshot',
    cursor: 'evt_000000000001',
    sessions: [],
    loginRequirements: [login],
    approvals: [approval]
  });
  applyMeshAgentStateFrame(state, { kind: 'event', event: event(2) });
  applyMeshAgentStateFrame(state, {
    kind: 'snapshot',
    cursor: 'evt_000000000003',
    sessions: [],
    loginRequirements: [],
    approvals: []
  });

  expect(state).toEqual({
    sessions: {},
    loginRequirements: {},
    approvals: {},
    events: [],
    acceptedEventIds: [],
    lastEventId: 'evt_000000000003',
    snapshotReceived: true,
    stale: false
  });
});

test('a replacement snapshot seeds recent lifecycle notices without advancing past its cursor', () => {
  const state = initialMeshAgentStateStreamState();
  const asleep = meshFrameEvent(1, 'mesh.idle_suspended', {
    agentId: 'member-codex',
    agentName: 'Codex',
    type: 'idle_suspended',
    payload: { meshSessionId: 'mesh_1234567890ab', idleTimeoutMs: 300_000 }
  });
  const awake = meshFrameEvent(2, 'mesh.idle_resumed', {
    agentId: 'member-codex',
    agentName: 'Codex',
    type: 'idle_resumed',
    payload: { meshSessionId: 'mesh_1234567890ab' }
  });
  if (asleep.kind !== 'event' || awake.kind !== 'event') throw new Error('expected event frames');

  applyMeshAgentStateFrame(state, {
    kind: 'snapshot',
    cursor: evtId(3),
    sessions: [],
    loginRequirements: [],
    approvals: [],
    lifecycleEvents: [
      meshAgentStateLifecycleEventSchema.parse(asleep.event),
      meshAgentStateLifecycleEventSchema.parse(awake.event)
    ]
  });

  expect({
    eventIds: state.events.map((event) => event.id),
    acceptedEventIds: state.acceptedEventIds,
    lastEventId: state.lastEventId
  }).toEqual({
    eventIds: [evtId(1), evtId(2)],
    acceptedEventIds: [evtId(1), evtId(2)],
    lastEventId: evtId(3)
  });
});

test('duplicate events are ignored and the ordered transport window stays bounded', () => {
  const state = initialMeshAgentStateStreamState();
  for (let index = 1; index <= MAX_MESH_AGENT_STATE_EVENTS + 1; index++) {
    const frame: MeshAgentStateFrame = { kind: 'event', event: event(index) };
    applyMeshAgentStateFrame(state, frame);
    applyMeshAgentStateFrame(state, frame);
  }

  expect({
    eventCount: state.events.length,
    idCount: state.acceptedEventIds.length,
    first: state.events[0]?.id,
    last: state.events.at(-1)?.id,
    lastEventId: state.lastEventId
  }).toEqual({
    eventCount: MAX_MESH_AGENT_STATE_EVENTS,
    idCount: MAX_MESH_AGENT_STATE_EVENTS,
    first: 'evt_000000000002',
    last: `evt_${String(MAX_MESH_AGENT_STATE_EVENTS + 1).padStart(12, '0')}`,
    lastEventId: `evt_${String(MAX_MESH_AGENT_STATE_EVENTS + 1).padStart(12, '0')}`
  });
});

test('login and approval transitions materialize into authoritative maps and survive tail eviction', () => {
  const state = initialMeshAgentStateStreamState();
  applyMeshAgentStateFrame(state, { kind: 'snapshot', sessions: [], loginRequirements: [], approvals: [] });

  applyMeshAgentStateFrame(
    state,
    meshFrameEvent(1, 'mesh.login_required', {
      agentName: 'codex',
      provider: 'codex',
      reason: 'authentication required'
    })
  );
  applyMeshAgentStateFrame(
    state,
    meshFrameEvent(2, 'mesh.approval_requested', {
      meshSessionId: 'mesh_1234567890ab',
      provider: 'codex',
      requestId: 'req-1',
      text: 'approve'
    })
  );
  floodTail(state, 3); // evict the tail well past its bound with unrelated notice events

  const afterRequests = {
    liveLoginReason: state.loginRequirements['mesh-login:codex:codex']?.reason,
    liveApprovalText: state.approvals['req-1']?.text,
    tailRetainsLoginOrApproval: state.events.some(
      (event) => event.type === 'mesh.login_required' || event.type === 'mesh.approval_requested'
    ),
    tailBounded: state.events.length <= MAX_MESH_AGENT_STATE_EVENTS
  };

  applyMeshAgentStateFrame(
    state,
    meshFrameEvent(9000, 'mesh.login_resolved', { agentName: 'codex', authAgentName: 'codex', provider: 'codex' })
  );
  applyMeshAgentStateFrame(
    state,
    meshFrameEvent(9001, 'mesh.approval_resolved', {
      meshSessionId: 'mesh_1234567890ab',
      provider: 'codex',
      requestId: 'req-1',
      allow: true
    })
  );
  floodTail(state, 9002); // evict the resolutions too; the maps must not revive the resolved entries

  expect({
    ...afterRequests,
    loginAfterResolveAndEviction: state.loginRequirements['mesh-login:codex:codex'],
    approvalAfterResolveAndEviction: state.approvals['req-1']
  }).toEqual({
    liveLoginReason: 'authentication required',
    liveApprovalText: 'approve',
    tailRetainsLoginOrApproval: false,
    tailBounded: true,
    loginAfterResolveAndEviction: undefined,
    approvalAfterResolveAndEviction: undefined
  });
});

test('stream failures retain cached state while marking it stale', () => {
  const state = initialMeshAgentStateStreamState();
  applyMeshAgentStateFrame(state, { kind: 'event', event: event(1) });
  state.stale = true;
  state.streamError = { kind: 'transient', status: 503 };

  expect(state).toEqual({
    sessions: {},
    loginRequirements: {},
    approvals: {},
    events: [event(1)],
    acceptedEventIds: ['evt_000000000001'],
    lastEventId: 'evt_000000000001',
    snapshotReceived: false,
    stale: true,
    streamError: { kind: 'transient', status: 503 }
  });
});
