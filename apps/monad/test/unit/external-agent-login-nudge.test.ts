import type { ExternalAgentAuthStatusResponse, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { EventBus, makeEvent } from '#/services/event-bus.ts';
import { ExternalAgentLoginNudge } from '#/services/external-agent/login-nudge.ts';

const sessionId = 'ses_login0000000' as SessionId;

function authStatusResponse(state: 'authenticated' | 'unauthenticated'): ExternalAgentAuthStatusResponse {
  return { agentName: 'claude-code', provider: 'claude-code', state, output: '', checkedAt: new Date().toISOString() };
}

function connectionRequired(bus: EventBus): void {
  bus.publish(
    makeEvent(sessionId, 'external_agent.connection_required', {
      externalAgentSessionId: 'exa_login0000000',
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
  const nudge = new ExternalAgentLoginNudge({
    bus,
    authStatus: async () => authStatusResponse('unauthenticated')
  });
  const dispose = nudge.start();
  const seen: { type: string; payload: unknown }[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'external_agent.login_required') seen.push({ type: event.type, payload: event.payload });
  });

  connectionRequired(bus);
  await settled();

  expect(seen).toEqual([
    {
      type: 'external_agent.login_required',
      payload: {
        externalAgentSessionId: 'exa_login0000000',
        agentName: 'claude-code',
        provider: 'claude-code',
        reason: 'Not logged in · Please run /login'
      }
    }
  ]);
  dispose();
});

test('suppresses the nudge when the probe reports the agent is already authenticated', async () => {
  const bus = new EventBus();
  const nudge = new ExternalAgentLoginNudge({
    bus,
    authStatus: async () => authStatusResponse('authenticated')
  });
  const dispose = nudge.start();
  const seen: string[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'external_agent.login_required') seen.push(event.type);
  });

  connectionRequired(bus);
  await settled();

  expect(seen).toEqual([]);
  dispose();
});

test('resolveAuthenticated publishes login_resolved to every session that got a nudge, once', async () => {
  const bus = new EventBus();
  const nudge = new ExternalAgentLoginNudge({
    bus,
    authStatus: async () => authStatusResponse('unauthenticated')
  });
  const dispose = nudge.start();
  const resolved: unknown[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'external_agent.login_resolved') resolved.push(event.payload);
  });

  connectionRequired(bus);
  await settled();
  nudge.resolveAuthenticated({ agentName: 'claude-code', provider: 'claude-code' });
  nudge.resolveAuthenticated({ agentName: 'claude-code', provider: 'claude-code' });

  expect(resolved).toEqual([{ agentName: 'claude-code', provider: 'claude-code' }]);
  dispose();
});

test('resolveAuthenticated for an agent with no pending nudge publishes nothing', async () => {
  const bus = new EventBus();
  const nudge = new ExternalAgentLoginNudge({
    bus,
    authStatus: async () => authStatusResponse('unauthenticated')
  });
  const resolved: unknown[] = [];
  bus.subscribe(sessionId, (event) => {
    if (event.type === 'external_agent.login_resolved') resolved.push(event.payload);
  });

  nudge.resolveAuthenticated({ agentName: 'claude-code', provider: 'claude-code' });
  await settled();

  expect(resolved).toEqual([]);
});
