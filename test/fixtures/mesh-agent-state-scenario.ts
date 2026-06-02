import type {
  MeshAgentLoginRequirement,
  MeshAgentPendingApproval,
  MeshAgentStateEvent,
  MeshAgentStateSession,
  MeshSessionId,
  SessionId
} from '../../packages/protocol/src/index.ts';

import { meshAgentLoginRequirementId } from '../../packages/protocol/src/index.ts';

// Neutral mesh-state snapshot shared by the web and tui parity tests. Kept structurally compatible
// with the atoms fold input (MeshAgentExperienceInput) using protocol types ONLY — importing a
// client-rtk implementation type here would drag packages/client into the root tsconfig program
// (include: ["test/**/*.ts"]) and break the whole-repo typecheck.
export interface ScenarioMeshState {
  sessions: Record<string, MeshAgentStateSession>;
  loginRequirements: Record<string, MeshAgentLoginRequirement>;
  approvals: Record<string, MeshAgentPendingApproval>;
  events: MeshAgentStateEvent[];
  snapshotReceived: boolean;
  stale: boolean;
}

export interface MeshAgentStateScenario {
  meshSessionId: MeshSessionId;
  running: MeshAgentStateSession;
  idle: MeshAgentStateSession;
  terminal: MeshAgentStateSession;
  loginRequirement: MeshAgentLoginRequirement;
  approval: MeshAgentPendingApproval;
  streamState: ScenarioMeshState;
}

export function buildMeshAgentStateScenario(sessionId: SessionId): MeshAgentStateScenario {
  const meshSessionId = 'mesh_1234567890ab' as MeshSessionId;
  const running: MeshAgentStateSession = {
    id: meshSessionId,
    sessionId,
    agentName: 'codex',
    projectMemberId: 'pmem_codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    approvalOwnership: 'provider-owned',
    runtimeRole: 'managed-project-agent',
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    pendingApprovalCount: 0,
    lifecycle: { state: 'active' },
    activity: { state: 'running', pid: 4242, queuedTurnCount: 0 },
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
  const idle: MeshAgentStateSession = {
    ...running,
    activity: { state: 'idle', pid: null, queuedTurnCount: 0 }
  };
  const terminal: MeshAgentStateSession = {
    ...running,
    lifecycle: { state: 'terminal', termination: { kind: 'exited', at: '2026-07-23T00:01:00.000Z' } }
  };
  const loginRequirement: MeshAgentLoginRequirement = {
    id: meshAgentLoginRequirementId('codex', 'codex'),
    observedAt: '2026-07-23T00:00:00.000Z',
    agentName: 'codex',
    authAgentName: 'codex',
    provider: 'codex',
    reason: 'authentication required'
  };
  const approval: MeshAgentPendingApproval = {
    requestId: 'req-1',
    meshSessionId,
    provider: 'codex',
    text: 'Allow command?',
    requestedAt: '2026-07-23T00:00:02.000Z'
  };
  const streamState: ScenarioMeshState = {
    sessions: { [meshSessionId]: running },
    loginRequirements: { [loginRequirement.id]: loginRequirement },
    approvals: { [approval.requestId]: approval },
    events: [],
    snapshotReceived: true,
    stale: false
  };
  return { meshSessionId, running, idle, terminal, loginRequirement, approval, streamState };
}
