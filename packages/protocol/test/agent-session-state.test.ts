import type { AgentSessionSnapshot } from '../src/index.ts';

import { expect, test } from 'bun:test';

import { agentSessionChangedPayloadSchema, agentSessionSnapshotSchema, parseEvent } from '../src/index.ts';

const queued: AgentSessionSnapshot = {
  id: 'ses_1234567890ab:claude',
  transcriptTargetId: 'ses_1234567890ab',
  memberInstanceId: 'claude',
  revision: 3,
  lifecycle: 'active',
  connection: 'connected',
  loop: {
    state: 'queued',
    pendingTurnCount: 2,
    enteredAt: '2026-07-21T14:00:00.000Z',
    activeToolCalls: [
      {
        toolCallId: 'call_1',
        tool: 'read_file',
        startedAt: '2026-07-21T14:00:01.000Z'
      }
    ]
  }
};

test('agent session snapshot preserves queued loop activity exactly', () => {
  expect(agentSessionSnapshotSchema.parse(queued)).toEqual(queued);
});

test('agent session snapshot preserves released and terminated lifecycle detail', () => {
  expect(
    agentSessionSnapshotSchema.parse({
      ...queued,
      revision: 4,
      lifecycle: 'released',
      connection: 'inactive',
      loop: { ...queued.loop, state: 'idle', pendingTurnCount: 0, activeToolCalls: [] }
    })
  ).toEqual({
    ...queued,
    revision: 4,
    lifecycle: 'released',
    connection: 'inactive',
    loop: { ...queued.loop, state: 'idle', pendingTurnCount: 0, activeToolCalls: [] }
  });
  expect(
    agentSessionSnapshotSchema.parse({
      ...queued,
      revision: 5,
      lifecycle: 'terminated',
      connection: 'inactive',
      loop: { ...queued.loop, state: 'idle', pendingTurnCount: 0, activeToolCalls: [] },
      termination: {
        reason: 'failed',
        at: '2026-07-21T14:00:05.000Z',
        error: { code: 'gateway_failed', message: 'gateway exited', retryable: false }
      }
    })
  ).toEqual({
    ...queued,
    revision: 5,
    lifecycle: 'terminated',
    connection: 'inactive',
    loop: { ...queued.loop, state: 'idle', pendingTurnCount: 0, activeToolCalls: [] },
    termination: {
      reason: 'failed',
      at: '2026-07-21T14:00:05.000Z',
      error: { code: 'gateway_failed', message: 'gateway exited', retryable: false }
    }
  });
});

test('agent session contract rejects invalid revision and impossible idle queue state', () => {
  expect(agentSessionSnapshotSchema.safeParse({ ...queued, revision: -1 }).success).toBe(false);
  expect(
    agentSessionSnapshotSchema.safeParse({
      ...queued,
      loop: { ...queued.loop, state: 'idle', pendingTurnCount: 1, activeToolCalls: [] }
    }).success
  ).toBe(false);
});

test('agent session changed event and session member preserve the business snapshot', () => {
  expect(agentSessionChangedPayloadSchema.parse({ memberId: 'claude', session: queued })).toEqual({
    memberId: 'claude',
    session: queued
  });
  expect(
    parseEvent({
      id: 'evt_1234567890ab',
      sessionId: 'ses_1234567890ab',
      type: 'agent.session.changed',
      actorAgentId: null,
      payload: { memberId: 'claude', session: queued },
      at: '2026-07-21T14:00:00.000Z'
    })
  ).toEqual({
    id: 'evt_1234567890ab',
    sessionId: 'ses_1234567890ab',
    type: 'agent.session.changed',
    actorAgentId: null,
    payload: { memberId: 'claude', session: queued },
    at: '2026-07-21T14:00:00.000Z'
  });
  expect(agentSessionSnapshotSchema.parse(queued)).toEqual(queued);
});
