import type { AgentSessionSnapshot, Event } from '@monad/protocol';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { EventBus } from '#/services/event-bus.ts';
import { ManagedAgentSessionLifecycle } from '#/services/native-agent/agent-session-lifecycle.ts';
import { createStore } from '#/store/db/index.ts';

let store: ReturnType<typeof createStore>;
let bus: EventBus;
let lifecycle: ManagedAgentSessionLifecycle;
let tick: number;
let changed: Event[];

const sessionId = 'ses_100000000000';
const memberId = 'claude';

beforeEach(() => {
  store = createStore();
  store.insertSessionMember({
    sessionId,
    memberId,
    type: 'mesh-agent',
    data: { name: 'claude', settings: { modelId: 'claude-sonnet-4-5' } },
    createdAt: '2026-07-21T14:00:00.000Z',
    updatedAt: '2026-07-21T14:00:00.000Z'
  });
  bus = new EventBus();
  tick = 0;
  changed = [];
  bus.subscribeControl((event) => {
    if (event.type === 'agent.session.changed') changed.push(event);
  });
  lifecycle = new ManagedAgentSessionLifecycle({
    store,
    bus,
    now: () => `2026-07-21T14:00:${String(tick++).padStart(2, '0')}.000Z`
  });
});

afterEach(() => store.close());

function snapshot(): AgentSessionSnapshot {
  const value = lifecycle.snapshot(sessionId, memberId);
  if (!value) throw new Error('missing agent session snapshot');
  return value;
}

test('managed agent lifecycle reduces queued turns and tool activity to exact snapshots', () => {
  lifecycle.queue({ sessionId, memberId, deliveryId: 'deliv_100000000000' });
  lifecycle.queue({ sessionId, memberId, deliveryId: 'deliv_200000000000' });
  expect(snapshot()).toMatchObject({
    revision: 2,
    lifecycle: 'active',
    loop: { state: 'queued', pendingTurnCount: 2, activeToolCalls: [] }
  });

  lifecycle.startTurn({
    sessionId,
    memberId,
    deliveryId: 'deliv_100000000000',
    runtimeId: 'mesh_100000000000'
  });
  lifecycle.applyOutputEvent({
    sessionId,
    memberId,
    event: { type: 'tool_call', payload: { callId: 'call_1', tool: 'read_file', input: { path: 'README.md' } } }
  });
  expect(snapshot()).toMatchObject({
    revision: 4,
    runtimeId: 'mesh_100000000000',
    loop: {
      state: 'running',
      phase: 'using-tools',
      turnId: 'deliv_100000000000',
      pendingTurnCount: 2,
      activeToolCalls: [{ toolCallId: 'call_1', tool: 'read_file' }]
    }
  });

  lifecycle.applyOutputEvent({
    sessionId,
    memberId,
    event: { type: 'tool_result', payload: { callId: 'call_1', output: 'ok' } }
  });
  lifecycle.settleTurn({ sessionId, memberId, deliveryId: 'deliv_100000000000' });
  expect(snapshot()).toMatchObject({
    revision: 6,
    loop: { state: 'queued', pendingTurnCount: 1, activeToolCalls: [] }
  });

  lifecycle.settleTurn({ sessionId, memberId, deliveryId: 'deliv_200000000000' });
  expect(snapshot()).toMatchObject({
    revision: 7,
    loop: { state: 'idle', pendingTurnCount: 0, activeToolCalls: [] }
  });
  expect(changed).toHaveLength(7);
});

test('managed agent lifecycle ignores duplicate delivery and tool transitions', () => {
  lifecycle.queue({ sessionId, memberId, deliveryId: 'deliv_100000000000' });
  lifecycle.queue({ sessionId, memberId, deliveryId: 'deliv_100000000000' });
  lifecycle.startTurn({ sessionId, memberId, deliveryId: 'deliv_100000000000' });
  lifecycle.applyOutputEvent({
    sessionId,
    memberId,
    event: { type: 'tool_call', payload: { callId: 'call_1', tool: 'read_file' } }
  });
  lifecycle.applyOutputEvent({
    sessionId,
    memberId,
    event: { type: 'tool_call', payload: { callId: 'call_1', tool: 'read_file' } }
  });
  lifecycle.applyOutputEvent({
    sessionId,
    memberId,
    event: { type: 'tool_result', payload: { callId: 'call_1' } }
  });
  lifecycle.applyOutputEvent({
    sessionId,
    memberId,
    event: { type: 'tool_result', payload: { callId: 'call_1' } }
  });
  lifecycle.settleTurn({ sessionId, memberId, deliveryId: 'deliv_100000000000' });
  lifecycle.settleTurn({ sessionId, memberId, deliveryId: 'deliv_100000000000' });
  lifecycle.applyOutputEvent({
    sessionId,
    memberId,
    event: { type: 'agent_message', payload: { text: 'late duplicate', final: true } }
  });

  expect(snapshot()).toMatchObject({ revision: 5, loop: { state: 'idle', pendingTurnCount: 0 } });
  expect(changed).toHaveLength(5);
});

test('managed agent lifecycle preserves work across release and resume before termination', () => {
  lifecycle.release({ sessionId, memberId });
  expect(snapshot()).toMatchObject({ revision: 1, lifecycle: 'released', connection: 'inactive' });

  lifecycle.queue({ sessionId, memberId, deliveryId: 'deliv_100000000000' });
  expect(snapshot()).toMatchObject({
    revision: 2,
    lifecycle: 'resuming',
    loop: { state: 'queued', pendingTurnCount: 1 }
  });

  lifecycle.terminate({ sessionId, memberId, reason: 'failed' });
  expect(snapshot()).toMatchObject({
    revision: 3,
    lifecycle: 'terminated',
    connection: 'inactive',
    loop: { state: 'idle', pendingTurnCount: 0 },
    termination: { reason: 'failed' }
  });
});

test('provider login failure immediately clears the active turn to idle', () => {
  lifecycle.queue({ sessionId, memberId, deliveryId: 'deliv_100000000000' });
  lifecycle.startTurn({
    sessionId,
    memberId,
    deliveryId: 'deliv_100000000000',
    runtimeId: 'mesh_100000000000'
  });

  lifecycle.applyOutputEvent({
    sessionId,
    memberId,
    event: {
      type: 'connection_required',
      payload: { code: 'provider_connection_required', reason: 'Please log in' }
    }
  });

  expect(snapshot()).toMatchObject({
    lifecycle: 'released',
    connection: 'inactive',
    loop: { state: 'idle', pendingTurnCount: 0, activeToolCalls: [] }
  });
});

test('managed agent lifecycle persists snapshots without overwriting member configuration', () => {
  lifecycle.queue({ sessionId, memberId, deliveryId: 'deliv_100000000000' });
  const member = store.getSessionMember(sessionId, memberId);

  expect(member?.data).toMatchObject({
    name: 'claude',
    settings: { modelId: 'claude-sonnet-4-5' },
    agentSessionState: {
      activeDeliveryIds: ['deliv_100000000000'],
      snapshot: { revision: 1, loop: { state: 'queued', pendingTurnCount: 1 } }
    }
  });
});

test('managed agent lifecycle folds runtime suspension, resume, and termination into the logical session', () => {
  lifecycle.queue({ sessionId, memberId, deliveryId: 'deliv_100000000000' });
  lifecycle.applyRuntimeSnapshot({
    sessionId,
    memberId,
    runtimeId: 'mesh_100000000000',
    snapshot: {
      lifecycle: { state: 'starting' },
      activity: { state: 'starting', pid: null, queuedTurnCount: 1 },
      connection: { state: 'connecting' },
      capabilities: {
        input: true,
        steer: false,
        interrupt: true,
        approvalResolution: false,
        providerSessionContinuation: true,
        runtimeRestoration: true,
        sessionReopen: true
      }
    }
  });
  expect(snapshot()).toMatchObject({
    lifecycle: 'resuming',
    connection: 'connecting',
    runtimeId: 'mesh_100000000000',
    loop: { state: 'queued', pendingTurnCount: 1 }
  });

  lifecycle.applyRuntimeSnapshot({
    sessionId,
    memberId,
    runtimeId: 'mesh_100000000000',
    snapshot: {
      lifecycle: { state: 'active' },
      activity: { state: 'suspended', pid: null, suspendedAt: '2026-07-21T15:00:00.000Z', queuedTurnCount: 1 },
      connection: { state: 'inactive' },
      capabilities: {
        input: true,
        steer: false,
        interrupt: true,
        approvalResolution: false,
        providerSessionContinuation: true,
        runtimeRestoration: true,
        sessionReopen: true
      },
      providerSessionRef: 'thread-1'
    }
  });
  expect(snapshot()).toMatchObject({
    lifecycle: 'released',
    connection: 'inactive',
    providerSessionRef: 'thread-1',
    loop: { state: 'queued', pendingTurnCount: 1 }
  });

  lifecycle.applyRuntimeSnapshot({
    sessionId,
    memberId,
    runtimeId: 'mesh_100000000000',
    snapshot: {
      lifecycle: {
        state: 'terminal',
        termination: {
          kind: 'failed',
          at: '2026-07-21T15:00:01.000Z',
          error: { code: 'gateway_failed', message: 'gateway exited', retryable: false }
        }
      },
      activity: { state: 'idle', pid: null, queuedTurnCount: 0 },
      connection: { state: 'inactive' },
      capabilities: {
        input: false,
        steer: false,
        interrupt: false,
        approvalResolution: false,
        providerSessionContinuation: true,
        runtimeRestoration: true,
        sessionReopen: true
      }
    }
  });
  expect(snapshot()).toMatchObject({
    lifecycle: 'terminated',
    loop: { state: 'idle', pendingTurnCount: 0 },
    termination: {
      reason: 'failed',
      at: '2026-07-21T15:00:01.000Z',
      error: { code: 'gateway_failed', message: 'gateway exited', retryable: false }
    }
  });
});
