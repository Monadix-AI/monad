import type { ExperienceStateStore, WorkspaceExperienceApiContext } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { KanbanStore } from '../../src/experiences/kanban/store.ts';

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
    }
  };
}

test('createTask is idempotent and binds exactly one project session', async () => {
  let creates = 0;
  const context = {
    atomPackId: 'monad-power-pack',
    experienceState: memoryState(),
    projectSessions: {
      create: async () => {
        creates += 1;
        return { id: 'ses_a' };
      }
    },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkspaceExperienceApiContext;
  const store = new KanbanStore(context);

  const first = await store.createTask({ projectId: 'prj_a', title: 'A', idempotencyKey: 'request-a' });
  const second = await store.createTask({ projectId: 'prj_a', title: 'A', idempotencyKey: 'request-a' });

  expect(second).toEqual(first);
  expect(first).toMatchObject({ projectId: 'prj_a', sessionId: 'ses_a', stage: 'requirements' });
  expect(creates).toBe(1);
  expect(await store.listTasks('prj_a')).toEqual([first]);
});

test('saveTask rejects a stale domain version', async () => {
  const context = {
    atomPackId: 'monad-power-pack',
    experienceState: memoryState(),
    projectSessions: { create: async () => ({ id: 'ses_a' }) },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkspaceExperienceApiContext;
  const store = new KanbanStore(context);
  const task = await store.createTask({ projectId: 'prj_a', title: 'A', idempotencyKey: 'request-a' });

  await expect(store.saveTask({ ...task, version: 1 }, 7, { type: 'invalid' })).rejects.toThrow('version conflict');
});

test('recoverProvisioning resumes an incomplete create saga after restart', async () => {
  const state = memoryState();
  let creates = 0;
  const context = {
    atomPackId: 'monad-power-pack',
    experienceState: state,
    projectSessions: {
      create: async () => {
        creates += 1;
        return { id: 'ses_recovered' };
      }
    },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkspaceExperienceApiContext;
  await state.compareAndSwap({
    projectId: 'prj_a',
    key: 'provision/task_recovery',
    expectedVersion: null,
    value: {
      taskId: 'task_recovery',
      title: 'Recover me',
      idempotencyKey: 'request-recovery',
      sessionId: null,
      complete: false
    },
    event: { type: 'task.provisioning_started' }
  });

  const recovered = await new KanbanStore(context).recoverProvisioning('prj_a');

  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({ title: 'Recover me', sessionId: 'ses_recovered' });
  expect(creates).toBe(1);
});
