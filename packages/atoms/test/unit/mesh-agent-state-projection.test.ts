import type { EventId, MeshAgentStateEvent, MeshAgentStateSession, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { projectCanvasIsBusy } from '../../src/workplace-experiences/chat-room/utils/canvas.ts';
import {
  applyMeshAgentExperienceEvent,
  foldMeshAgentExperienceState,
  meshAgentLifecycleNotices,
  meshAgentRuntimeStatus
} from '../../src/workplace-experiences/experience/mesh-agent-state.ts';
import {
  activeMeshAgentNames,
  projectApprovalViews
} from '../../src/workplace-experiences/experience/project-projection.ts';

const sessionId = 'ses_1234567890ab' as SessionId;
const meshSessionId = 'mesh_1234567890ab';
const session: MeshAgentStateSession = {
  id: meshSessionId,
  sessionId,
  agentName: 'codex',
  provider: 'codex',
  workingPath: '/tmp/project',
  approvalOwnership: 'provider-owned',
  runtimeRole: 'managed-project-agent',
  lastDeliveredSeq: 0,
  lastVisibleSeq: 0,
  pendingApprovalCount: 0,
  lifecycle: { state: 'active' },
  activity: { state: 'idle', pid: null, queuedTurnCount: 0 },
  connection: { state: 'connected' },
  capabilities: {
    input: true,
    steer: true,
    interrupt: true,
    approvalResolution: true,
    providerSessionContinuation: true,
    runtimeRestoration: true,
    sessionReopen: true
  },
  startedAt: '2026-07-23T00:00:00.000Z',
  updatedAt: '2026-07-23T00:00:00.000Z'
};

function event(id: number, type: MeshAgentStateEvent['type'], payload: Record<string, unknown>): MeshAgentStateEvent {
  return {
    id: `evt_${String(id).padStart(12, '0')}` as EventId,
    sessionId,
    type,
    actorAgentId: null,
    payload,
    at: `2026-07-23T00:00:${String(id).padStart(2, '0')}.000Z`
  };
}

test('folds login and approval lifecycles from neutral canonical events', () => {
  const required = event(1, 'mesh.login_required', {
    agentName: 'codex',
    authAgentName: 'codex',
    provider: 'codex',
    reason: 'authentication required'
  });
  const approval = event(2, 'mesh.approval_requested', {
    meshSessionId,
    provider: 'codex',
    requestId: 'req-1',
    text: 'Allow command?'
  });
  const resolved = event(3, 'mesh.login_resolved', {
    agentName: 'codex',
    authAgentName: 'codex',
    provider: 'codex'
  });

  const state = foldMeshAgentExperienceState({
    sessions: { [meshSessionId]: session },
    loginRequirements: {},
    approvals: {},
    events: [required, approval, resolved],
    snapshotReceived: true,
    stale: false
  });

  expect({
    sessions: [...state.sessions.keys()],
    loginRequirements: [...state.loginRequirements.values()],
    approvals: [...state.approvals.values()],
    acceptedEventIds: [...state.acceptedEventIds]
  }).toEqual({
    sessions: [meshSessionId],
    loginRequirements: [],
    approvals: [
      {
        requestId: 'req-1',
        meshSessionId,
        provider: 'codex',
        text: 'Allow command?',
        requestedAt: '2026-07-23T00:00:02.000Z'
      }
    ],
    acceptedEventIds: ['evt_000000000001', 'evt_000000000002', 'evt_000000000003']
  });
});

test('folds turn and connection state in daemon acceptance order and ignores duplicates', () => {
  const started = event(1, 'mesh.turn_started', { meshSessionId });
  const opened = event(2, 'mesh.session.connection.opened', {
    meshSessionId,
    provider: 'codex',
    observationEpoch: 'epoch-1'
  });
  const settled = event(3, 'mesh.turn_settled', { meshSessionId });
  const state = foldMeshAgentExperienceState({
    sessions: {},
    loginRequirements: {},
    approvals: {},
    events: [started, opened, settled],
    snapshotReceived: true,
    stale: false
  });
  applyMeshAgentExperienceEvent(state, opened);

  expect({
    active: [...state.activeMeshSessionIds],
    connected: [...state.connectedMeshSessionIds],
    events: state.events.map((item) => item.id)
  }).toEqual({
    active: [],
    connected: [meshSessionId],
    events: ['evt_000000000001', 'evt_000000000002', 'evt_000000000003']
  });
});

test('projects neutral approvals without retaining duplicate daemon UI approvals', () => {
  const approvals = projectApprovalViews(
    [
      {
        kind: 'approval',
        id: 'legacy-approval',
        seq: 'evt_legacy',
        tool: 'mesh-agent:codex',
        input: { approvalOwnership: 'provider-owned', provider: 'codex', text: 'Legacy' }
      }
    ],
    [
      {
        requestId: 'req-1',
        meshSessionId,
        provider: 'codex',
        text: 'Allow command?',
        requestedAt: '2026-07-23T00:00:02.000Z'
      }
    ]
  );

  expect(approvals).toEqual([
    {
      id: 'req-1',
      meshSessionId,
      approvalOwnership: 'provider-owned',
      av: 'C',
      name: 'Codex approval',
      tag: 'CLI',
      tool: 'mesh-agent:codex',
      text: 'Allow command?',
      meta: 'mesh approval: req-1',
      scopes: ['once']
    }
  ]);
});

test('projects Monad approvals with remembered scopes and the concrete requested tool', () => {
  expect(
    projectApprovalViews(
      [],
      [
        {
          requestId: 'req-monad',
          meshSessionId,
          provider: 'monad',
          text: 'tool',
          data: { requestId: 'gate-1', kind: 'tool', tool: 'monad__project_post', input: { text: 'Hello' } },
          requestedAt: '2026-07-23T00:00:02.000Z'
        }
      ]
    )
  ).toEqual([
    {
      id: 'req-monad',
      meshSessionId,
      approvalOwnership: 'provider-owned',
      av: 'M',
      name: 'Monad approval',
      tag: 'CLI',
      tool: 'mesh-agent:monad',
      text: 'monad__project_post',
      meta: 'mesh approval: req-monad',
      scopes: ['once', 'session', 'global']
    }
  ]);
});

test('derives active agent identity from neutral turn state without mesh tool rows', () => {
  expect([
    ...activeMeshAgentNames({
      activityOverrideAgentNames: [],
      liveTools: [],
      meshSessions: [session],
      streamingAgentNames: new Set(),
      activeMeshSessionIds: new Set([meshSessionId])
    })
  ]).toEqual(['codex']);
});

test('derives canvas busy state from neutral turns and approvals without mesh UI rows', () => {
  expect([
    projectCanvasIsBusy([], [], {
      activeMeshSessionIds: new Set([meshSessionId]),
      approvals: new Map()
    }),
    projectCanvasIsBusy([], [], {
      activeMeshSessionIds: new Set(),
      approvals: new Map([['req-1', {}]])
    }),
    projectCanvasIsBusy([], [], {
      activeMeshSessionIds: new Set(),
      approvals: new Map()
    })
  ]).toEqual([true, true, false]);
});

test('projects canonical lifecycle events into localized experience notices', () => {
  const state = foldMeshAgentExperienceState({
    sessions: { [meshSessionId]: session },
    loginRequirements: {},
    approvals: {},
    events: [
      event(1, 'mesh.idle_suspended', {
        agentId: 'codex',
        agentName: 'Reviewer',
        type: 'idle_suspended',
        payload: { meshSessionId, idleTimeoutMs: 300_000 }
      }),
      event(2, 'mesh.idle_resumed', {
        agentId: 'codex',
        agentName: 'Reviewer',
        type: 'idle_resumed',
        payload: { meshSessionId }
      }),
      event(3, 'mesh.resume_failed', {
        agentName: 'codex',
        provider: 'codex',
        providerSessionRef: 'thread-old',
        code: 'resume-failed',
        message: 'failed',
        fallback: 'cold-start'
      }),
      event(4, 'mesh.connection_required', {
        meshSessionId,
        agentName: 'codex',
        provider: 'codex',
        reason: 'connection required',
        reconnectIn: 'studio'
      }),
      event(5, 'mesh.exited', { meshSessionId, exitCode: 1, state: 'failed' })
    ],
    snapshotReceived: true,
    stale: false
  });

  expect(
    meshAgentLifecycleNotices(state).map(({ kind, agentName, event, text, tone }) => ({
      kind,
      agentName,
      event,
      text,
      tone
    }))
  ).toEqual([
    {
      kind: 'idle-suspended',
      agentName: 'Reviewer',
      event: {
        agentId: 'codex',
        agentName: 'Reviewer',
        type: 'idle_suspended',
        payload: { meshSessionId, idleTimeoutMs: 300_000 }
      },
      text: 'fell asleep.',
      tone: 'info'
    },
    {
      kind: 'idle-resumed',
      agentName: 'Reviewer',
      event: {
        agentId: 'codex',
        agentName: 'Reviewer',
        type: 'idle_resumed',
        payload: { meshSessionId }
      },
      text: 'woke up.',
      tone: 'info'
    },
    {
      kind: 'resume-failed',
      agentName: 'codex',
      event: {
        agentId: 'codex',
        agentName: 'codex',
        type: 'resume_failed',
        payload: { provider: 'codex', providerSessionRef: 'thread-old' }
      },
      text: 'codex resume failed for provider session thread-old; started a new runtime.',
      tone: 'warning'
    },
    {
      kind: 'connection-required',
      agentName: 'codex',
      event: {
        agentId: 'codex',
        agentName: 'codex',
        type: 'connection_required',
        payload: { meshSessionId }
      },
      text: 'codex needs to reconnect in Studio.',
      tone: 'error'
    },
    {
      kind: 'failed',
      agentName: 'codex',
      event: {
        agentId: 'codex',
        agentName: 'codex',
        type: 'failed',
        payload: { meshSessionId, exitCode: 1 }
      },
      text: 'codex failed (1).',
      tone: 'error'
    }
  ]);
});

test('replaces a connection-required notice with the verified login requirement for the same runtime', () => {
  const connectionRequired = event(1, 'mesh.connection_required', {
    meshSessionId,
    agentName: 'pmem_claude',
    authAgentName: 'claude-code',
    provider: 'claude-code',
    code: 'authentication_failed',
    reason: 'Please run /login',
    reconnectIn: 'studio'
  });
  const liveState = foldMeshAgentExperienceState({
    sessions: { [meshSessionId]: { ...session, agentName: 'pmem_claude' } },
    loginRequirements: {},
    approvals: {},
    events: [
      connectionRequired,
      event(2, 'mesh.login_required', {
        meshSessionId,
        agentName: 'pmem_claude',
        authAgentName: 'claude-code',
        provider: 'claude-code',
        reason: 'Please run /login'
      }),
      event(3, 'mesh.login_resolved', {
        agentName: 'pmem_claude',
        authAgentName: 'claude-code',
        provider: 'claude-code'
      })
    ],
    snapshotReceived: true,
    stale: false
  });

  const snapshotState = foldMeshAgentExperienceState({
    sessions: { [meshSessionId]: { ...session, agentName: 'pmem_claude' } },
    loginRequirements: {
      login: {
        id: 'mesh-agent-login-required:pmem_claude:claude-code',
        observedAt: '2026-07-23T00:00:02.000Z',
        meshSessionId,
        agentName: 'pmem_claude',
        authAgentName: 'claude-code',
        provider: 'claude-code',
        reason: 'Please run /login'
      }
    },
    approvals: {},
    events: [connectionRequired],
    snapshotReceived: true,
    stale: false
  });

  for (const state of [liveState, snapshotState]) {
    expect(meshAgentLifecycleNotices(state).filter((notice) => notice.kind === 'connection-required')).toEqual([]);
  }
});

test('omits a generic failed notice when the runtime snapshot carries the specific error', () => {
  const failedSession: MeshAgentStateSession = {
    ...session,
    lifecycle: {
      state: 'terminal',
      termination: {
        kind: 'failed',
        at: '2026-07-23T00:00:05.000Z',
        exitCode: 1,
        error: {
          code: 'session_event_runtime_failed',
          message: 'JSON Parse error: Unexpected identifier "error"',
          retryable: false
        }
      }
    },
    activity: { state: 'idle', pid: null, queuedTurnCount: 0 },
    connection: { state: 'inactive' }
  };
  const state = foldMeshAgentExperienceState({
    sessions: { [meshSessionId]: failedSession },
    loginRequirements: {},
    approvals: {},
    events: [event(5, 'mesh.exited', { meshSessionId, exitCode: 1, state: 'failed' })],
    snapshotReceived: true,
    stale: false
  });

  expect(meshAgentLifecycleNotices(state)).toEqual([]);
});

test('projects a failed lifecycle fallback only when its runtime snapshot is unavailable', () => {
  const state = foldMeshAgentExperienceState({
    sessions: {},
    loginRequirements: {},
    approvals: {},
    events: [event(5, 'mesh.exited', { meshSessionId, exitCode: 1, state: 'failed' })],
    snapshotReceived: true,
    stale: false
  });

  expect(meshAgentLifecycleNotices(state)).toEqual([
    {
      id: 'mesh-agent-failed:mesh_1234567890ab:evt_000000000005',
      agentName: 'mesh_1234567890ab',
      event: {
        agentId: 'mesh_1234567890ab',
        agentName: 'mesh_1234567890ab',
        type: 'failed',
        payload: { meshSessionId, exitCode: 1 }
      },
      kind: 'failed',
      meshSessionId,
      observedAt: '2026-07-23T00:00:05.000Z',
      text: 'mesh_1234567890ab failed (1).',
      tone: 'error'
    }
  ]);
});

test('shares localized runtime status semantics with Web and TUI', () => {
  expect([meshAgentRuntimeStatus({ stale: true }, session), meshAgentRuntimeStatus({ stale: false }, session)]).toEqual(
    [
      { kind: 'stale', label: 'Reconnecting', tone: 'working' },
      { kind: 'idle', label: 'Idle', tone: 'idle' }
    ]
  );
});
