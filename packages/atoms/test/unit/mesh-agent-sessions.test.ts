import type { MeshSessionView, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { meshAgentMemberPresence } from '../../src/workplace-experiences/experience/mesh-agent-presence.ts';
import { mergeMeshAgentSessions } from '../../src/workplace-experiences/experience/mesh-agent-sessions.ts';
import { activeMeshAgentNames } from '../../src/workplace-experiences/experience/project-projection.ts';

const sessionId = 'ses_1234567890ab' as SessionId;

function meshSession(
  id: MeshSessionView['id'],
  updatedAt: string,
  activity: MeshSessionView['activity']
): MeshSessionView {
  return {
    id,
    sessionId,
    agentName: 'codex',
    provider: 'codex',
    productIcon: 'codex',
    workingPath: '/tmp/project',
    approvalOwnership: 'provider-owned',
    runtimeRole: 'managed-project-agent',
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    pendingApprovalCount: 0,
    lifecycle: { state: 'active' },
    activity,
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
    startedAt: '2026-08-09T00:00:00.000Z',
    updatedAt
  };
}

test('keeps a newly listed runtime when the initial stream snapshot has no sessions', () => {
  const listed = meshSession('mesh_1234567890ab', '2026-08-09T00:00:01.000Z', {
    state: 'running',
    pid: 42,
    queuedTurnCount: 0
  });
  const sessions = mergeMeshAgentSessions([listed], []);
  const activeAgentNames = activeMeshAgentNames({
    activityOverrideAgentNames: [],
    liveTools: [],
    meshSessions: sessions,
    streamingAgentNames: new Set(),
    activeMeshSessionIds: new Set([listed.id])
  });

  expect({
    sessions,
    activeAgentNames: [...activeAgentNames],
    presence: meshAgentMemberPresence({
      activeAgentNames,
      agentName: 'codex',
      enabled: true,
      meshSessions: sessions,
      liveTools: []
    })
  }).toEqual({ sessions: [listed], activeAgentNames: ['codex'], presence: 'working' });
});

test('uses the newer runtime state while preserving fields omitted from the stream snapshot', () => {
  const listed = meshSession('mesh_1234567890ab', '2026-08-09T00:00:01.000Z', {
    state: 'idle',
    pid: null,
    queuedTurnCount: 0
  });
  const streamed = {
    ...listed,
    productIcon: undefined,
    activity: { state: 'running' as const, pid: 42, queuedTurnCount: 0 },
    updatedAt: '2026-08-09T00:00:02.000Z'
  };

  expect(mergeMeshAgentSessions([listed], [streamed])).toEqual([
    {
      ...streamed,
      productIcon: 'codex'
    }
  ]);
});
