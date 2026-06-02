import { expect, test } from 'bun:test';
import {
  meshAgentLoginRequirementSchema,
  meshAgentStateFrameSchema,
  meshAgentStateSessionSchema
} from '@monad/protocol';

const capabilities = {
  input: true,
  steer: false,
  interrupt: true,
  approvalResolution: false,
  providerSessionContinuation: true,
  runtimeRestoration: true,
  sessionReopen: true
};

const neutralSessionInput = {
  id: 'mesh_1234567890ab',
  sessionId: 'ses_1234567890ab',
  agentName: 'codex',
  projectMemberId: null,
  provider: 'codex',
  workingPath: '/workspace',
  lifecycle: { state: 'active' as const },
  activity: { state: 'idle' as const, pid: null, queuedTurnCount: 0 as const },
  connection: { state: 'inactive' as const },
  capabilities,
  startedAt: '2026-07-23T00:00:00.000Z',
  updatedAt: '2026-07-23T00:00:00.000Z'
};
const neutralSession = meshAgentStateSessionSchema.parse(neutralSessionInput);

test('parses a neutral snapshot with exact domain state', () => {
  expect(
    meshAgentStateFrameSchema.parse({
      kind: 'snapshot',
      cursor: 'evt_000000000001',
      sessions: [neutralSession],
      loginRequirements: [
        {
          id: 'mesh-login:codex:codex',
          observedAt: '2026-07-23T00:00:00.000Z',
          agentName: 'codex',
          authAgentName: 'codex',
          provider: 'codex',
          reason: 'authentication required'
        }
      ],
      approvals: []
    })
  ).toEqual({
    kind: 'snapshot',
    cursor: 'evt_000000000001',
    sessions: [neutralSession],
    loginRequirements: [
      {
        id: 'mesh-login:codex:codex',
        observedAt: '2026-07-23T00:00:00.000Z',
        agentName: 'codex',
        authAgentName: 'codex',
        provider: 'codex',
        reason: 'authentication required'
      }
    ],
    approvals: []
  });
});

test('rejects presentation metadata from neutral state records', () => {
  expect(
    meshAgentLoginRequirementSchema.safeParse({
      id: 'mesh-login:codex:codex',
      observedAt: '2026-07-23T00:00:00.000Z',
      agentName: 'codex',
      authAgentName: 'codex',
      provider: 'codex',
      reason: 'authentication required',
      label: 'Sign in'
    }).success
  ).toBe(false);
  expect(meshAgentStateSessionSchema.safeParse({ ...neutralSessionInput, productIcon: 'codex' }).success).toBe(false);
});

test('accepts only canonical mesh events as incremental frames', () => {
  expect(
    meshAgentStateFrameSchema.parse({
      kind: 'event',
      event: {
        id: 'evt_000000000002',
        sessionId: 'ses_1234567890ab',
        type: 'mesh.login_required',
        actorAgentId: null,
        payload: {
          agentName: 'codex',
          authAgentName: 'codex',
          provider: 'codex',
          reason: 'authentication required'
        },
        at: '2026-07-23T00:00:01.000Z'
      }
    })
  ).toEqual({
    kind: 'event',
    event: {
      id: 'evt_000000000002',
      sessionId: 'ses_1234567890ab',
      type: 'mesh.login_required',
      actorAgentId: null,
      payload: {
        agentName: 'codex',
        authAgentName: 'codex',
        provider: 'codex',
        reason: 'authentication required'
      },
      at: '2026-07-23T00:00:01.000Z'
    }
  });

  expect(
    meshAgentStateFrameSchema.safeParse({
      kind: 'event',
      event: {
        id: 'evt_000000000003',
        sessionId: 'ses_1234567890ab',
        type: 'session.created',
        actorAgentId: null,
        payload: { title: 'ordinary session event' },
        at: '2026-07-23T00:00:02.000Z'
      }
    }).success
  ).toBe(false);

  expect(
    meshAgentStateFrameSchema.safeParse({
      kind: 'event',
      event: {
        id: 'evt_000000000004',
        sessionId: 'ses_1234567890ab',
        type: 'mesh.login_resolved',
        actorAgentId: null,
        payload: { agentName: 'codex', provider: 'codex' },
        at: '2026-07-23T00:00:03.000Z'
      }
    }).success
  ).toBe(false);

  expect(
    meshAgentStateFrameSchema.safeParse({
      kind: 'event',
      event: {
        id: 'evt_000000000005',
        sessionId: 'ses_1234567890ab',
        type: 'mesh.connection_required',
        actorAgentId: null,
        payload: {
          agentName: '',
          provider: 'codex',
          reason: '',
          reconnectIn: 'studio'
        },
        at: '2026-07-23T00:00:04.000Z'
      }
    }).success
  ).toBe(false);
});
