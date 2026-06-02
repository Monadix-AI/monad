import type { ExperienceStateStore, WorkplaceExperienceApiContext } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { kanbanApi } from '../../src/experiences/kanban/api.ts';

function memoryState(): ExperienceStateStore {
  const records = new Map<string, { value: unknown; version: number }>();
  return {
    get: async <T>(projectId: string, key: string) =>
      (records.get(`${projectId}:${key}`) as { value: T; version: number }) ?? null,
    list: async <T>(projectId: string, prefix: string) =>
      [...records.entries()].flatMap(([compound, record]) => {
        const key = compound.slice(projectId.length + 1);
        return compound.startsWith(`${projectId}:${prefix}`)
          ? [{ key, value: record.value as T, version: record.version }]
          : [];
      }),
    compareAndSwap: async ({ projectId, key, expectedVersion, value }) => {
      const compound = `${projectId}:${key}`;
      const current = records.get(compound);
      if (expectedVersion === null ? current !== undefined : current?.version !== expectedVersion) return false;
      records.set(compound, { value, version: expectedVersion === null ? 0 : expectedVersion + 1 });
      return true;
    },
    compareAndDelete: async ({ projectId, key, expectedVersion }) => {
      const compound = `${projectId}:${key}`;
      if (records.get(compound)?.version !== expectedVersion) return false;
      records.delete(compound);
      return true;
    }
  };
}

function route(method: 'GET' | 'POST', path: string) {
  const found = kanbanApi.routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!found) throw new Error(`missing route: ${method} ${path}`);
  return found.handle;
}

test('lists only sessions created and registered by the Kanban experience', async () => {
  const sessions = [{ id: 'ses_external', title: 'Created elsewhere', state: 'active' }];
  const context = {
    atomPackId: 'monad-power-pack',
    experienceId: 'kanban',
    experienceState: memoryState(),
    projectSessions: {
      create: async (_projectId: string, input: { title: string }) => {
        const session = { id: 'ses_kanban', title: input.title, state: 'active' };
        sessions.push(session);
        return { id: session.id };
      },
      getRun: async () => null,
      list: async () => sessions
    },
    projectMembers: { listSessionMembers: async () => [] },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkplaceExperienceApiContext;
  const list = route('GET', '/tasks');
  const create = route('POST', '/tasks/create');

  const before = await list(new Request('http://localhost/tasks?projectId=prj_a'), context);
  expect(await before.json()).toEqual({ tasks: [], nextCursor: null });

  const created = await create(
    new Request('http://localhost/tasks/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'prj_a', title: 'Created in Kanban', idempotencyKey: 'create-kanban' })
    }),
    context
  );
  expect(created.status).toBe(201);
  const createdPayload = (await created.json()) as { task: { sessionId: string; title: string } };
  expect(createdPayload.task.sessionId).toBe('ses_kanban');

  const after = await list(new Request('http://localhost/tasks?projectId=prj_a'), context);
  const payload = (await after.json()) as { tasks: Array<{ sessionId: string; title: string }>; nextCursor: null };
  expect(payload).toEqual({
    tasks: [createdPayload.task],
    nextCursor: null
  });
});
