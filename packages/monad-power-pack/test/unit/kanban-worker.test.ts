import type { ExperienceStateStore, WorkplaceExperienceApiContext } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { KanbanStore } from '../../src/experiences/kanban/store.ts';
import { kanbanWorker } from '../../src/experiences/kanban/worker.ts';

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
      const current = records.get(compound);
      if (current?.version !== expectedVersion) return false;
      records.delete(compound);
      return true;
    }
  };
}

test('worker events never duplicate daemon run state or move a card', async () => {
  const context = {
    atomPackId: 'monad-power-pack',
    experienceState: memoryState(),
    projectSessions: { create: async () => ({ id: 'ses_a' }) },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkplaceExperienceApiContext;
  const store = new KanbanStore(context);
  const task = await store.createTask({ projectId: 'prj_a', title: 'A', idempotencyKey: 'request-a' });

  await kanbanWorker.onEvent(
    {
      id: 'evt_completed',
      projectId: 'prj_a',
      sessionId: task.sessionId,
      type: 'session.run.completed',
      payload: {},
      createdAt: '2026-07-22T00:01:00.000Z'
    },
    context
  );

  expect(await store.findTask(task.id, 'prj_a')).toEqual(task);
});

test('session deletion removes the matching Kanban task and provision idempotently', async () => {
  const state = memoryState();
  const context = {
    atomPackId: 'monad-power-pack',
    experienceState: state,
    projectSessions: { create: async () => ({ id: 'ses_a' }), list: async () => [] },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkplaceExperienceApiContext;
  const store = new KanbanStore(context);
  const task = await store.createTask({ projectId: 'prj_a', title: 'A', idempotencyKey: 'request-a' });
  const deleted = {
    id: 'evt_deleted',
    projectId: 'prj_a',
    sessionId: task.sessionId,
    type: 'session.deleted' as const,
    payload: {},
    createdAt: '2026-07-22T00:01:00.000Z'
  };

  await kanbanWorker.onEvent(deleted, context);
  await kanbanWorker.onEvent(deleted, context);

  expect(await store.listTasks('prj_a')).toEqual([]);
  expect(await state.list('prj_a', 'provision/')).toEqual([]);
});
