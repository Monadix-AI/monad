import type { Event, PrincipalId, ProjectId, Session, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { createProjectSessionOperations } from '#/atoms/experience-project-sessions.ts';
import { createStore } from '#/store/db/index.ts';

const principalId = 'prn_a' as PrincipalId;
const projectId = 'prj_a' as ProjectId;
const sessionId = 'ses_a' as SessionId;

function fixture() {
  const store = createStore();
  const now = '2026-07-14T00:00:00.000Z';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Project',
    ownerPrincipalId: principalId,
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: now,
    updatedAt: now
  });
  store.insertSession({
    id: sessionId,
    projectId,
    title: 'Task',
    ownerPrincipalId: principalId,
    state: 'active',
    agentIds: [],
    parentSessionId: null,
    archived: false,
    restoreCount: 0,
    createdAt: now,
    updatedAt: now
  } satisfies Session);
  let generated = 0;
  const operations = createProjectSessionOperations({
    store,
    principalId,
    sessions: {
      generate: async () => {
        generated++;
      }
    } as never,
    oversight: {
      listPendingRequests: () => [],
      respond: async () => true
    } as never
  });
  return { store, operations, generated: () => generated };
}

test('listObservations returns a neutral summary without raw tool payload values', async () => {
  const { store, operations } = fixture();
  store.appendEvents([
    {
      id: 'evt_tool' as Event['id'],
      sessionId,
      type: 'tool.called',
      actorAgentId: null,
      payload: { toolCallId: 'call_a', tool: 'shell_exec', input: { apiKey: 'top-secret' } },
      at: '2026-07-14T00:00:01.000Z'
    }
  ]);

  try {
    const result = await operations.listObservations(sessionId);
    expect(result.items[0]?.text).toContain('shell_exec');
    expect(result.items[0]?.text).not.toContain('top-secret');
  } finally {
    store.close();
  }
});

test('sendMessage executes a namespaced idempotency key only once', async () => {
  const { store, operations, generated } = fixture();

  try {
    const request = { text: 'Hello', idempotencyKey: 'pack-a:request-a' };
    await operations.sendMessage(sessionId, request);
    await operations.sendMessage(sessionId, request);
    expect(generated()).toBe(1);
  } finally {
    store.close();
  }
});
