import type { MeshAgentStateFrame } from '../src/mesh-agent/mesh-agent-state.ts';

import { expect, test } from 'bun:test';

import {
  MESH_APPROVAL_DATA_MAX_BYTES,
  MESH_APPROVAL_TEXT_MAX,
  MESH_LOGIN_REASON_MAX,
  meshAgentApprovalRequestedPayloadSchema,
  meshAgentLoginRequiredPayloadSchema
} from '../src/event-table.ts';
import {
  MESH_SNAPSHOT_ARRAY_MAX,
  meshAgentPendingApprovalSchema,
  meshAgentStateSnapshotSchema,
  meshStateFrameWithinBudget
} from '../src/mesh-agent/mesh-agent-state.ts';

const approval = (over: Partial<{ text: string; data: unknown }>) => ({
  meshSessionId: 'mesh_1234567890ab',
  provider: 'codex' as const,
  requestId: 'req-1',
  text: 'ok',
  requestedAt: '2026-07-23T00:00:00.000Z',
  ...over
});

test('approval payload rejects text and data past the canonical size budget', () => {
  expect({
    textAtMax: meshAgentApprovalRequestedPayloadSchema.safeParse(approval({ text: 'x'.repeat(MESH_APPROVAL_TEXT_MAX) }))
      .success,
    textOverMax: meshAgentApprovalRequestedPayloadSchema.safeParse(
      approval({ text: 'x'.repeat(MESH_APPROVAL_TEXT_MAX + 1) })
    ).success,
    dataWithinBudget: meshAgentApprovalRequestedPayloadSchema.safeParse(approval({ data: { note: 'small' } })).success,
    dataOverBudget: meshAgentApprovalRequestedPayloadSchema.safeParse(
      approval({ data: { blob: 'y'.repeat(MESH_APPROVAL_DATA_MAX_BYTES + 1) } })
    ).success
  }).toEqual({ textAtMax: true, textOverMax: false, dataWithinBudget: true, dataOverBudget: false });
});

test('login payload rejects a reason past the canonical size budget', () => {
  const base = { agentName: 'codex', provider: 'codex' as const };
  expect({
    atMax: meshAgentLoginRequiredPayloadSchema.safeParse({ ...base, reason: 'r'.repeat(MESH_LOGIN_REASON_MAX) })
      .success,
    overMax: meshAgentLoginRequiredPayloadSchema.safeParse({ ...base, reason: 'r'.repeat(MESH_LOGIN_REASON_MAX + 1) })
      .success
  }).toEqual({ atMax: true, overMax: false });
});

test('snapshot rejects a collection past the cardinality bound', () => {
  const one = meshAgentPendingApprovalSchema.parse(approval({}));
  const snapshot = (count: number) => ({
    kind: 'snapshot' as const,
    sessions: [],
    loginRequirements: [],
    approvals: Array.from({ length: count }, () => one)
  });
  expect({
    atMax: meshAgentStateSnapshotSchema.safeParse(snapshot(MESH_SNAPSHOT_ARRAY_MAX)).success,
    overMax: meshAgentStateSnapshotSchema.safeParse(snapshot(MESH_SNAPSHOT_ARRAY_MAX + 1)).success
  }).toEqual({ atMax: true, overMax: false });
});

// 600k UTF-16 units × the 6-bytes-per-unit upper bound = 3.6MB > the 3.5MB budget, whichever field
// carries it. Used to prove the estimator counts EVERY field of EVERY frame kind, not just approvals.
const HUGE = 600_000;
const snapshotFrame = (over: Record<string, unknown>): MeshAgentStateFrame =>
  ({ kind: 'snapshot', sessions: [], loginRequirements: [], approvals: [], ...over }) as unknown as MeshAgentStateFrame;
const session = (over: Record<string, unknown>) => ({
  id: 'mesh_1234567890ab',
  sessionId: 'ses_1234567890ab',
  agentName: 'codex',
  projectMemberId: null,
  provider: 'codex',
  workingPath: '/tmp',
  ...over
});
const loginReq = (over: Record<string, unknown>) => ({
  id: 'mesh-login:codex:codex',
  observedAt: '2026-07-23T00:00:00.000Z',
  agentName: 'codex',
  authAgentName: 'codex',
  provider: 'codex',
  reason: 'auth',
  ...over
});

test('frame budget is a true upper bound over every field of every frame kind', () => {
  expect({
    bounded: meshStateFrameWithinBudget(
      snapshotFrame({
        approvals: [meshAgentPendingApprovalSchema.parse(approval({ text: 'x'.repeat(MESH_APPROVAL_TEXT_MAX) }))]
      })
    ),
    unavailable: meshStateFrameWithinBudget({ kind: 'unavailable', reason: 'mesh-agent-service-unavailable' }),
    // session strings the old estimator ignored entirely
    giantSessionWorkingPath: meshStateFrameWithinBudget(
      snapshotFrame({ sessions: [session({ workingPath: 'p'.repeat(HUGE) })] })
    ),
    giantSessionAgentName: meshStateFrameWithinBudget(
      snapshotFrame({ sessions: [session({ agentName: 'a'.repeat(HUGE) })] })
    ),
    // Sol's PoC: a login requirement's agentName (the old estimator only counted login.reason)
    giantLoginAgentName: meshStateFrameWithinBudget(
      snapshotFrame({ loginRequirements: [loginReq({ agentName: 'n'.repeat(HUGE) })] })
    ),
    // event frames were unconditionally admitted before
    giantEventPayload: meshStateFrameWithinBudget({
      kind: 'event',
      event: {
        id: 'evt_000000000001',
        sessionId: 'ses_1234567890ab',
        type: 'mesh.login_required',
        actorAgentId: null,
        payload: { agentName: 'n'.repeat(HUGE), provider: 'codex', reason: 'x' },
        at: '2026-07-23T00:00:00.000Z'
      }
    } as unknown as MeshAgentStateFrame),
    // multibyte: each emoji is 2 UTF-16 units, so 300k emoji reach the same 600k-unit ceiling
    multibyte: meshStateFrameWithinBudget(
      snapshotFrame({ sessions: [session({ workingPath: '😀'.repeat(HUGE / 2) })] })
    ),
    // control chars escape to \uXXXX (6 bytes each) — the 6×length bound covers it
    jsonEscape: meshStateFrameWithinBudget(
      snapshotFrame({ sessions: [session({ workingPath: '\u0001'.repeat(HUGE) })] })
    )
  }).toEqual({
    bounded: true,
    unavailable: true,
    giantSessionWorkingPath: false,
    giantSessionAgentName: false,
    giantLoginAgentName: false,
    giantEventPayload: false,
    multibyte: false,
    jsonEscape: false
  });
});
