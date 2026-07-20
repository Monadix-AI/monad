import type { MeshAgentAuthStatusResponse, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { EventBus, makeEvent } from '#/services/event-bus.ts';
import { MeshAgentLoginNudge } from '#/services/mesh-agent/login-nudge.ts';

const sessionId = 'ses_login0000000' as SessionId;

function authStatusResponse(state: 'authenticated' | 'unauthenticated'): MeshAgentAuthStatusResponse {
  return {
    agentName: 'claude-code',
    provider: 'claude-code',
    state,
    output: '',
    checkedAt: new Date().toISOString()
  };
}

function connectionRequired(bus: EventBus): void {
  bus.publish(
    makeEvent(sessionId, 'mesh.connection_required', {
      meshSessionId: 'mesh_login0000000',
      agentName: 'claude-code',
      provider: 'claude-code',
      code: 'authentication_failed',
      reason: 'Not logged in · Please run /login',
      reconnectIn: 'studio'
    })
  );
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('publishes login_required only after the auth probe confirms unauthenticated', async () => {
  const bus = new EventBus();
  const nudge = new MeshAgentLoginNudge({
    bus,
    authStatus: async () => authStatusResponse('unauthenticated')
  });
  const dispose = nudge.start();
  const seen: { type: string; payload: unknown }[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'mesh.login_required') seen.push({ type: event.type, payload: event.payload });
  });

  connectionRequired(bus);
  await settled();

  expect(seen).toEqual([
    {
      type: 'mesh.login_required',
      payload: {
        meshSessionId: 'mesh_login0000000',
        agentName: 'claude-code',
        authAgentName: 'claude-code',
        provider: 'claude-code',
        reason: 'Not logged in · Please run /login'
      }
    }
  ]);
  dispose();
});

test('probes the configured agent while publishing the project member login card identity', async () => {
  const bus = new EventBus();
  const probed: string[] = [];
  const nudge = new MeshAgentLoginNudge({
    bus,
    authStatus: async (agentName) => {
      probed.push(agentName);
      if (agentName !== 'claude-code') throw new Error(`unexpected auth probe: ${agentName}`);
      return authStatusResponse('unauthenticated');
    }
  });
  const dispose = nudge.start();
  const seen: { type: string; payload: unknown }[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'mesh.login_required') seen.push({ type: event.type, payload: event.payload });
  });

  bus.publish(
    makeEvent(sessionId, 'mesh.connection_required', {
      agentName: 'pmem_claude_opus',
      authAgentName: 'claude-code',
      provider: 'claude-code',
      code: 'provider_connection_required',
      reason: 'Reconnect claude-code in Studio before using it in this project.',
      reconnectIn: 'studio'
    })
  );
  await settled();

  expect(probed).toEqual(['claude-code']);
  expect(seen).toEqual([
    {
      type: 'mesh.login_required',
      payload: {
        agentName: 'pmem_claude_opus',
        authAgentName: 'claude-code',
        provider: 'claude-code',
        reason: 'Reconnect claude-code in Studio before using it in this project.'
      }
    }
  ]);
  dispose();
});

test('exposes pending login_required cards for late UI hydration', async () => {
  const bus = new EventBus();
  const nudge = new MeshAgentLoginNudge({
    bus,
    authStatus: async (agentName) => {
      if (agentName !== 'claude-code') throw new Error(`unexpected auth probe: ${agentName}`);
      return authStatusResponse('unauthenticated');
    }
  });
  const dispose = nudge.start();

  bus.publish(
    makeEvent(sessionId, 'mesh.connection_required', {
      agentName: 'pmem_claude_opus',
      authAgentName: 'claude-code',
      provider: 'claude-code',
      code: 'provider_connection_required',
      reason: 'Reconnect claude-code in Studio before using it in this project.',
      reconnectIn: 'studio'
    })
  );
  await settled();

  expect(nudge.pendingLoginRequiredEvents(sessionId).map((event) => [event.type, event.payload])).toEqual([
    [
      'mesh.login_required',
      {
        agentName: 'pmem_claude_opus',
        authAgentName: 'claude-code',
        provider: 'claude-code',
        reason: 'Reconnect claude-code in Studio before using it in this project.'
      }
    ]
  ]);

  nudge.resolveAuthenticated({
    agentName: 'claude-code',
    provider: 'claude-code'
  });
  expect(nudge.pendingLoginRequiredEvents(sessionId)).toEqual([]);
  dispose();
});

test('suppresses the nudge when the probe reports the agent is already authenticated', async () => {
  const bus = new EventBus();
  const nudge = new MeshAgentLoginNudge({
    bus,
    authStatus: async () => authStatusResponse('authenticated')
  });
  const dispose = nudge.start();
  const seen: string[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'mesh.login_required') seen.push(event.type);
  });

  connectionRequired(bus);
  await settled();

  expect(seen).toEqual([]);
  dispose();
});

test('refresh reprobe clears a pending login card after the agent authenticated elsewhere', async () => {
  const bus = new EventBus();
  const states: Array<'unauthenticated' | 'authenticated'> = ['unauthenticated', 'authenticated'];
  const nudge = new MeshAgentLoginNudge({
    bus,
    authStatus: async () => authStatusResponse(states.shift() ?? 'authenticated')
  });
  const dispose = nudge.start();
  const resolved: unknown[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'mesh.login_resolved') resolved.push(event.payload);
  });

  bus.publish(
    makeEvent(sessionId, 'mesh.connection_required', {
      agentName: 'pmem_claude_opus',
      authAgentName: 'claude-code',
      provider: 'claude-code',
      code: 'provider_connection_required',
      reason: 'Reconnect claude-code in Studio before using it in this project.',
      reconnectIn: 'studio'
    })
  );
  await settled();
  expect(nudge.pendingLoginRequiredEvents(sessionId).map((event) => event.payload)).toEqual([
    {
      agentName: 'pmem_claude_opus',
      authAgentName: 'claude-code',
      provider: 'claude-code',
      reason: 'Reconnect claude-code in Studio before using it in this project.'
    }
  ]);

  bus.publish(
    makeEvent(sessionId, 'mesh.connection_required', {
      agentName: 'pmem_claude_opus',
      authAgentName: 'claude-code',
      provider: 'claude-code',
      code: 'provider_connection_required',
      reason: 'Reconnect claude-code in Studio before using it in this project.',
      reconnectIn: 'studio'
    })
  );
  await settled();

  expect(nudge.pendingLoginRequiredEvents(sessionId)).toEqual([]);
  expect(resolved).toEqual([{ agentName: 'pmem_claude_opus', provider: 'claude-code' }]);
  dispose();
});

test('does not probe auth for disabled or missing adapter connection cards', async () => {
  const bus = new EventBus();
  const probed: string[] = [];
  const nudge = new MeshAgentLoginNudge({
    bus,
    authStatus: async (agentName) => {
      probed.push(agentName);
      return authStatusResponse('unauthenticated');
    }
  });
  const dispose = nudge.start();
  const seen: string[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'mesh.login_required') seen.push(event.type);
  });

  for (const code of ['provider_disabled', 'provider_unavailable']) {
    bus.publish(
      makeEvent(sessionId, 'mesh.connection_required', {
        agentName: 'pmem_claude_opus',
        authAgentName: 'claude-code',
        provider: 'claude-code',
        code,
        reason: 'MeshAgent adapter is unavailable.',
        reconnectIn: 'studio'
      })
    );
  }
  await settled();

  expect(probed).toEqual([]);
  expect(seen).toEqual([]);
  dispose();
});

test('resolveAuthenticated publishes login_resolved to every session that got a nudge, once', async () => {
  const bus = new EventBus();
  const nudge = new MeshAgentLoginNudge({
    bus,
    authStatus: async () => authStatusResponse('unauthenticated')
  });
  const dispose = nudge.start();
  const resolved: unknown[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'mesh.login_resolved') resolved.push(event.payload);
  });

  connectionRequired(bus);
  await settled();
  nudge.resolveAuthenticated({
    agentName: 'claude-code',
    provider: 'claude-code'
  });
  nudge.resolveAuthenticated({
    agentName: 'claude-code',
    provider: 'claude-code'
  });

  expect(resolved).toEqual([{ agentName: 'claude-code', provider: 'claude-code' }]);
  dispose();
});

test('resolveAuthenticated removes project member login cards for the authenticated config agent', async () => {
  const bus = new EventBus();
  const nudge = new MeshAgentLoginNudge({
    bus,
    authStatus: async () => authStatusResponse('unauthenticated')
  });
  const dispose = nudge.start();
  const resolved: unknown[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'mesh.login_resolved') resolved.push(event.payload);
  });

  bus.publish(
    makeEvent(sessionId, 'mesh.connection_required', {
      agentName: 'pmem_claude_opus',
      authAgentName: 'claude-code',
      provider: 'claude-code',
      code: 'provider_connection_required',
      reason: 'Reconnect claude-code in Studio before using it in this project.',
      reconnectIn: 'studio'
    })
  );
  bus.publish(
    makeEvent(sessionId, 'mesh.connection_required', {
      agentName: 'pmem_claude_sonnet',
      authAgentName: 'claude-code',
      provider: 'claude-code',
      code: 'provider_connection_required',
      reason: 'Reconnect claude-code in Studio before using it in this project.',
      reconnectIn: 'studio'
    })
  );
  await settled();

  nudge.resolveAuthenticated({
    agentName: 'claude-code',
    provider: 'claude-code'
  });

  expect(resolved).toEqual([
    { agentName: 'pmem_claude_opus', provider: 'claude-code' },
    { agentName: 'pmem_claude_sonnet', provider: 'claude-code' }
  ]);
  dispose();
});

test('resolveAuthenticated for an agent with no pending nudge publishes nothing', async () => {
  const bus = new EventBus();
  const nudge = new MeshAgentLoginNudge({
    bus,
    authStatus: async () => authStatusResponse('unauthenticated')
  });
  const resolved: unknown[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'mesh.login_resolved') resolved.push(event.payload);
  });

  nudge.resolveAuthenticated({
    agentName: 'claude-code',
    provider: 'claude-code'
  });
  await settled();

  expect(resolved).toEqual([]);
});
