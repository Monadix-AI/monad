import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExperienceStateStore, createExperienceWorkerScheduler } from '#/atoms/experience-state.ts';
import { ExperienceWorkerRegistry } from '#/atoms/experience-workers.ts';
import { createStore } from '#/store/db/index.ts';

function seedProject(store: ReturnType<typeof createStore>, projectId = 'prj_a') {
  const now = '2026-07-14T00:00:00.000Z';
  store.insertWorkplaceProject({
    id: projectId as never,
    title: 'Project',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: now,
    updatedAt: now
  });
}

test('compareAndSwap appends one audit event only for the expected version', async () => {
  const store = createStore();
  seedProject(store);
  const state = createExperienceStateStore(store, 'pack-a');

  try {
    expect(
      await state.compareAndSwap({
        projectId: 'prj_a',
        key: 'task/x',
        expectedVersion: null,
        value: { n: 1 },
        event: { type: 'created' }
      })
    ).toBe(true);
    expect(
      await state.compareAndSwap({
        projectId: 'prj_a',
        key: 'task/x',
        expectedVersion: null,
        value: { n: 2 },
        event: { type: 'duplicate' }
      })
    ).toBe(false);
    expect(await state.get<{ n: number }>('prj_a', 'task/x')).toMatchObject({ value: { n: 1 }, version: 0 });
    expect(store.listExperienceStateEvents('pack-a', 'prj_a', 'task/x')).toHaveLength(1);
  } finally {
    store.close();
  }
});

test('a scheduled wake-up survives reopening the database', async () => {
  const base = await mkdtemp(join(tmpdir(), 'monad-experience-worker-'));
  const path = join(base, 'store.sqlite');
  const first = createStore({ path });
  seedProject(first);

  try {
    await createExperienceWorkerScheduler(first, 'pack-a', 'board').schedule('prj_a', {
      key: 'dispatch',
      runAt: '2026-07-14T00:00:00.000Z'
    });
  } finally {
    first.close();
  }

  const reopened = createStore({ path });
  try {
    expect(reopened.listDueExperienceWorkerWakeups('2026-07-14T00:00:01.000Z')).toEqual([
      expect.objectContaining({ atomPackId: 'pack-a', projectId: 'prj_a', key: 'dispatch' })
    ]);
  } finally {
    reopened.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('worker receives a project-scoped event and a durable wake-up', async () => {
  const store = createStore();
  seedProject(store);
  const seen: string[] = [];
  const context = {
    atomPackId: 'pack-a',
    experienceState: createExperienceStateStore(store, 'pack-a'),
    projectSessions: {} as never,
    experienceId: 'board',
    workerScheduler: createExperienceWorkerScheduler(store, 'pack-a', 'board')
  };
  const registry = new ExperienceWorkerRegistry({ store, contextFor: () => context });
  registry.register('pack-a', ['experience.worker'], {
    experienceId: 'board',
    onProjectStart: async (projectId) => {
      seen.push(`start:${projectId}`);
    },
    onEvent: async (event) => {
      seen.push(`event:${event.id}`);
    },
    onWake: async (wake) => {
      seen.push(`wake:${wake.key}`);
    }
  });

  try {
    await registry.startProjects(['prj_a']);
    await registry.publish({
      id: 'evt_1',
      projectId: 'prj_a',
      sessionId: 'ses_a',
      type: 'approval_requested',
      payload: {},
      createdAt: '2026-07-14T00:00:00.000Z'
    });
    await context.workerScheduler.schedule('prj_a', { key: 'dispatch', runAt: '2026-07-14T00:00:00.000Z' });
    await registry.deliverDueWakeups('2026-07-14T00:00:01.000Z');

    expect(seen).toEqual(['start:prj_a', 'event:evt_1', 'wake:dispatch']);
    expect(store.listDueExperienceWorkerWakeups('2026-07-14T00:00:01.000Z')).toEqual([]);
  } finally {
    store.close();
  }
});

test('events for one session are delivered in order without overlapping', async () => {
  const store = createStore();
  const seen: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const registry = new ExperienceWorkerRegistry({
    store,
    contextFor: () => ({}) as never
  });
  registry.register('pack-a', ['experience.worker'], {
    experienceId: 'board',
    onProjectStart: async () => {},
    onEvent: async (event) => {
      seen.push(`start:${event.id}`);
      if (event.id === 'evt_1') await firstBlocked;
      seen.push(`end:${event.id}`);
    },
    onWake: async () => {}
  });
  const event = (id: string) => ({
    id,
    projectId: 'prj_a',
    sessionId: 'ses_a',
    type: 'agent.message',
    payload: {},
    createdAt: '2026-07-14T00:00:00.000Z'
  });

  try {
    const first = registry.publish(event('evt_1'));
    await Promise.resolve();
    const second = registry.publish(event('evt_2'));
    await Promise.resolve();
    expect(seen).toEqual(['start:evt_1']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(seen).toEqual(['start:evt_1', 'end:evt_1', 'start:evt_2', 'end:evt_2']);
  } finally {
    store.close();
  }
});

test('same-key wakeups are isolated between sibling experience workers', async () => {
  const store = createStore();
  seedProject(store);
  const seen: string[] = [];
  const contextFor = (experienceId: string) => ({
    atomPackId: 'pack-a',
    experienceId,
    experienceState: createExperienceStateStore(store, 'pack-a'),
    projectSessions: {} as never,
    workerScheduler: createExperienceWorkerScheduler(store, 'pack-a', experienceId)
  });
  const registry = new ExperienceWorkerRegistry({
    store,
    contextFor: (_atomPackId, _permissions, experienceId) => contextFor(experienceId)
  });
  for (const experienceId of ['board', 'timeline']) {
    registry.register('pack-a', ['experience.worker'], {
      experienceId,
      onProjectStart: async () => {},
      onEvent: async () => {},
      onWake: async () => {
        seen.push(experienceId);
      }
    });
  }

  try {
    await contextFor('board').workerScheduler.schedule('prj_a', {
      key: 'dispatch',
      runAt: '2026-07-14T00:00:00.000Z'
    });
    await contextFor('timeline').workerScheduler.schedule('prj_a', {
      key: 'dispatch',
      runAt: '2026-07-14T00:00:00.000Z'
    });
    await registry.deliverDueWakeups('2026-07-14T00:00:01.000Z');
    expect(seen).toEqual(['board', 'timeline']);
  } finally {
    store.close();
  }
});

test('state and scheduler reject an unknown project', async () => {
  const store = createStore();
  const state = createExperienceStateStore(store, 'pack-a');
  const scheduler = createExperienceWorkerScheduler(store, 'pack-a', 'board');

  try {
    await expect(state.get('prj_missing', 'task/a')).rejects.toThrow('project not found');
    await expect(
      scheduler.schedule('prj_missing', { key: 'dispatch', runAt: '2026-07-14T00:00:00.000Z' })
    ).rejects.toThrow('project not found');
  } finally {
    store.close();
  }
});
