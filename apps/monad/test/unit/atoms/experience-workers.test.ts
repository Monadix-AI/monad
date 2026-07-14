import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExperienceStateStore, createExperienceWorkerScheduler } from '#/atoms/experience-state.ts';
import { ExperienceWorkerRegistry } from '#/atoms/experience-workers.ts';
import { createStore } from '#/store/db/index.ts';

test('compareAndSwap appends one audit event only for the expected version', async () => {
  const store = createStore();
  const state = createExperienceStateStore(store, 'pack-a', 'prn_a');

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
    expect(store.listExperienceStateEvents('pack-a', 'prn_a', 'prj_a', 'task/x')).toHaveLength(1);
  } finally {
    store.close();
  }
});

test('a scheduled wake-up survives reopening the database', async () => {
  const base = await mkdtemp(join(tmpdir(), 'monad-experience-worker-'));
  const path = join(base, 'store.sqlite');
  const first = createStore({ path });

  try {
    await createExperienceWorkerScheduler(first, 'pack-a', 'prn_a').schedule('prj_a', {
      key: 'dispatch',
      runAt: '2026-07-14T00:00:00.000Z'
    });
  } finally {
    first.close();
  }

  const reopened = createStore({ path });
  try {
    expect(reopened.listDueExperienceWorkerWakeups('2026-07-14T00:00:01.000Z')).toEqual([
      expect.objectContaining({ atomPackId: 'pack-a', principalId: 'prn_a', projectId: 'prj_a', key: 'dispatch' })
    ]);
  } finally {
    reopened.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('worker receives a project-scoped event and a durable wake-up', async () => {
  const store = createStore();
  const seen: string[] = [];
  const context = {
    atomPackId: 'pack-a',
    principalId: 'prn_a',
    experienceState: createExperienceStateStore(store, 'pack-a', 'prn_a'),
    projectSessions: {} as never,
    workerScheduler: createExperienceWorkerScheduler(store, 'pack-a', 'prn_a')
  };
  const registry = new ExperienceWorkerRegistry({ store, contextFor: () => context });
  registry.register('pack-a', 'prn_a', ['experience.worker'], {
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
