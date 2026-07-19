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
  handlers.store.appendEvents([authFailure]);
  return { handlers, sessionId: sessionId as SessionId, authFailure };
}

function loginCard(items: UIItem[]) {
  return items.find((item) => item.kind === 'custom' && item.name === 'mesh.login_required');
}

test('uiItems restores a persisted authentication failure as a login card', async () => {
  const { handlers, sessionId, authFailure } = await authFailureHarness();

  const response = await handlers.session.uiItems({ id: sessionId });

  expect(loginCard(response.items)).toEqual({
    kind: 'custom',
    id: 'mesh-agent-login-required:opus',
    name: 'mesh.login_required',
    status: 'error',
    data: {
      meshSessionId: 'mesh_authfailure1',
      agentName: 'opus',
      provider: 'claude-code',
      reason: 'Not logged in · Please run /login'
    },
    seq: authFailure.id
  });
  handlers.store.close();
});

test('subscribeUi restores a persisted authentication failure as a login card', async () => {
  const { handlers, sessionId, authFailure } = await authFailureHarness();
  const snapshots: UIItem[][] = [];

  const { dispose } = await handlers.session.subscribeUi({ sessionId }, (event) => {
    if (event.kind === 'snapshot') snapshots.push(event.items);
  });

  expect(loginCard(snapshots[0] ?? [])).toEqual({
    kind: 'custom',
    id: 'mesh-agent-login-required:opus',
    name: 'mesh.login_required',
    status: 'error',
    data: {
      meshSessionId: 'mesh_authfailure1',
      agentName: 'opus',
      provider: 'claude-code',
      reason: 'Not logged in · Please run /login'
    },
    seq: authFailure.id
  });
  dispose();
  handlers.store.close();
});
