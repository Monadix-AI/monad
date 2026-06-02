import type { ExperienceStateStore, WorkplaceExperienceApiContext } from '@monad/sdk-atom';

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
    },
    compareAndDelete: async ({ projectId, key, expectedVersion }) => {
      const compound = `${projectId}:${key}`;
      if (records.get(compound)?.version !== expectedVersion) return false;
      records.delete(compound);
      return true;
    }
  };
}

test('createTask is idempotent and binds exactly one project session', async () => {
  let creates = 0;
  const createInputs: unknown[] = [];
  const context = {
    atomPackId: 'monad-power-pack',
    experienceState: memoryState(),
    projectSessions: {
      create: async (_projectId: string, input: unknown) => {
        creates += 1;
        createInputs.push(input);
        return { id: 'ses_a' };
      }
    },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkplaceExperienceApiContext;
  const store = new KanbanStore(context);

  const first = await store.createTask({ projectId: 'prj_a', title: 'A', idempotencyKey: 'request-a' });
  const second = await store.createTask({ projectId: 'prj_a', title: 'A', idempotencyKey: 'request-a' });

  expect(second).toEqual(first);
  expect(first).toMatchObject({
    schemaVersion: 3,
    projectId: 'prj_a',
    sessionId: 'ses_a',
    stage: 'product_design',
    stageRunId: null
  });
  expect(creates).toBe(1);
  expect(createInputs).toEqual([
    {
      title: 'A',
      idempotencyKey: expect.stringMatching(/^kanban:create:/),
      memberPolicy: 'empty'
    }
  ]);
  expect(await store.listTasks('prj_a')).toEqual([first]);
});

test('saveTask rejects a stale domain version', async () => {
  const context = {
    atomPackId: 'monad-power-pack',
    experienceState: memoryState(),
    projectSessions: { create: async () => ({ id: 'ses_a' }) },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkplaceExperienceApiContext;
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
  } as unknown as WorkplaceExperienceApiContext;
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

test('reading a legacy task persists its normalized stage projection', async () => {
  const state = memoryState();
  const context = {
    atomPackId: 'monad-power-pack',
    experienceState: state,
    projectSessions: { create: async () => ({ id: 'ses_a' }) },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkplaceExperienceApiContext;
  await state.compareAndSwap({
    projectId: 'prj_a',
    key: 'task/task_legacy',
    expectedVersion: null,
    value: {
      schemaVersion: 1,
      id: 'task_legacy',
      projectId: 'prj_a',
      sessionId: 'ses_legacy',
      title: 'Legacy',
      stage: 'execution',
      version: 0,
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z'
    },
    event: { type: 'legacy' }
  });

  const normalized = await new KanbanStore(context).findTask('task_legacy', 'prj_a');

  expect(normalized).toMatchObject({
    schemaVersion: 3,
    sessionId: 'ses_legacy',
    stage: 'implementation',
    version: 1
  });
  expect(await state.get('prj_a', 'task/task_legacy')).toMatchObject({
    version: 1,
    value: { schemaVersion: 3, stage: 'implementation', version: 1 }
  });
});
