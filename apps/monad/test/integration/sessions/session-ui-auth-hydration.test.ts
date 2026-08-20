import type { Event, SessionId, UIItem } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { buildMockModel } from '../../fixtures/mock-model.ts';
import { buildHandlers } from '../../helpers.ts';

async function authFailureHarness() {
  const handlers = buildHandlers(buildMockModel().text(['ok']).build());
  const { sessionId } = await handlers.session.create({ title: 'auth failure' });
  const at = new Date().toISOString();
  handlers.store.insertMessage(newId('msg'), sessionId, 'use opus', at, 'user');
  const authFailure: Event = {
    id: newId('evt'),
    sessionId: sessionId as SessionId,
    type: 'mesh.connection_required',
    actorAgentId: null,
    payload: {
      meshSessionId: 'mesh_authfailure1',
      agentName: 'opus',
      provider: 'claude-code',
      code: 'authentication_failed',
      reason: 'Not logged in · Please run /login',
      reconnectIn: 'studio'
    },
    at
  };
  const persistedLoginRequired: Event = {
    id: newId('evt'),
    sessionId: sessionId as SessionId,
    type: 'mesh.login_required',
    actorAgentId: null,
    payload: {
      meshSessionId: 'mesh_authfailure1',
      agentName: 'opus',
      provider: 'claude-code',
      reason: 'Not logged in · Please run /login'
    },
    at
  };
  handlers.store.appendEvents([authFailure, persistedLoginRequired]);
  return { handlers, sessionId: sessionId as SessionId };
}

function loginCard(items: UIItem[]) {
  return items.find((item) => item.kind === 'custom' && item.name === 'mesh.login_required');
}

test('uiItems does not restore a persisted authentication failure as a login card', async () => {
  const { handlers, sessionId } = await authFailureHarness();

  const response = await handlers.session.uiItems({ id: sessionId });

  // presence-ok: hydrating durable history must not recreate an ephemeral login card
  expect(loginCard(response.items)).toBeUndefined();
  handlers.store.close();
});

test('subscribeUi does not restore a persisted authentication failure as a login card', async () => {
  const { handlers, sessionId } = await authFailureHarness();
  const snapshots: UIItem[][] = [];

  const { dispose } = await handlers.session.subscribeUi({ sessionId }, (event) => {
    if (event.kind === 'snapshot') snapshots.push(event.items);
  });

  // presence-ok: subscribing after restart must not recreate an ephemeral login card from history
  expect(loginCard(snapshots[0] ?? [])).toBeUndefined();
  dispose();
  handlers.store.close();
});
