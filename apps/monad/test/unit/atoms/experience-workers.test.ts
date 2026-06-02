import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExperienceStateStore, createExperienceWorkerScheduler } from '#/atoms/experience-state.ts';
import { ExperienceWorkerRegistry } from '#/atoms/experience-workers.ts';
import { createStore } from '#/store/db/index.ts';

const projectId = 'prj_aaaaaaaaaaaa';
const missingProjectId = 'prj_missing00000';

async function removeTempDirectory(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt === 49) throw error;
      await Bun.sleep(100);
    }
  }
}

function seedProject(store: ReturnType<typeof createStore>, id = projectId) {
  const now = '2026-07-14T00:00:00.000Z';
  store.insertWorkplaceProject({
    id: id as never,
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
        projectId,
        key: 'task/x',
        expectedVersion: null,
        value: { n: 1 },
        event: { type: 'created' }
      })
    ).toBe(true);
    expect(
      await state.compareAndSwap({
        projectId,
        key: 'task/x',
        expectedVersion: null,
        value: { n: 2 },
        event: { type: 'duplicate' }
      })
    ).toBe(false);
    expect(await state.get<{ n: number }>(projectId, 'task/x')).toMatchObject({ value: { n: 1 }, version: 0 });
    expect(store.listExperienceStateEvents('pack-a', projectId, 'task/x')).toHaveLength(1);
  } finally {
    store.close();
  }
});

test('compareAndDelete removes only the expected version and appends a deletion audit event', async () => {
  const store = createStore();
  seedProject(store);
  const state = createExperienceStateStore(store, 'pack-a');

  try {
    await state.compareAndSwap({
      projectId,
      key: 'task/x',
      expectedVersion: null,
      value: { n: 1 },
      event: { type: 'created' }
    });

    expect(
      await state.compareAndDelete({
        projectId,
        key: 'task/x',
        expectedVersion: 1,
        event: { type: 'deleted' }
      })
    ).toBe(false);
    expect(await state.get(projectId, 'task/x')).toEqual({ value: { n: 1 }, version: 0 });
    expect(
      await state.compareAndDelete({
        projectId,
        key: 'task/x',
        expectedVersion: 0,
        event: { type: 'deleted' }
      })
    ).toBe(true);

    expect(await state.get(projectId, 'task/x')).toBeNull();
    expect(store.listExperienceStateEvents('pack-a', projectId, 'task/x')).toEqual([
      expect.objectContaining({ version: 0, payload: { type: 'created' } }),
      expect.objectContaining({ version: 1, payload: { type: 'deleted' } })
    ]);
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
    await createExperienceWorkerScheduler(first, 'pack-a', 'board').schedule(projectId, {
      key: 'dispatch',
      runAt: '2026-07-14T00:00:00.000Z'
    });
  } finally {
    first.close();
  }

  const reopened = createStore({ path });
  try {
    expect(reopened.listDueExperienceWorkerWakeups('2026-07-14T00:00:01.000Z')).toEqual([
      expect.objectContaining({ atomPackId: 'pack-a', projectId, key: 'dispatch' })
    ]);
  } finally {
    reopened.close();
    await removeTempDirectory(base);
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
    projectMembers: {} as never,
    requestInteraction: async () => ({ status: 'cancelled' as const, reason: 'unavailable' as const }),
    experienceId: 'board',
    workerScheduler: createExperienceWorkerScheduler(store, 'pack-a', 'board')
  };
  const registry = new ExperienceWorkerRegistry({ store, contextFor: () => context });
  registry.register('pack-a', ['experience.worker'], {
    experienceId: 'board',
    subscriptions: ['session.updated'],
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
    await registry.startProjects([projectId]);
    await registry.publish({
      id: 'evt_1',
      projectId,
      sessionId: 'ses_a',
      type: 'session.updated',
      payload: {},
      createdAt: '2026-07-14T00:00:00.000Z'
    });
    await context.workerScheduler.schedule(projectId, { key: 'dispatch', runAt: '2026-07-14T00:00:00.000Z' });
    await registry.deliverDueWakeups('2026-07-14T00:00:01.000Z');

    expect(seen).toEqual([`start:${projectId}`, 'event:evt_1', 'wake:dispatch']);
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
    subscriptions: ['session.updated'],
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
    projectId,
    sessionId: 'ses_a',
    type: 'session.updated' as const,
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

test('worker receives only explicitly subscribed event types', async () => {
  const store = createStore();
  const seen: string[] = [];
  const registry = new ExperienceWorkerRegistry({ store, contextFor: () => ({}) as never });
  registry.register('pack-a', ['experience.worker'], {
    experienceId: 'board',
    subscriptions: ['session.deleted'],
    onProjectStart: async () => {},
    onEvent: async (event) => {
      seen.push(event.type);
    },
    onWake: async () => {}
  });

  try {
    await registry.publish({
      id: 'evt_1',
      projectId,
      sessionId: 'ses_aaaaaaaaaaaa',
      type: 'session.updated',
      payload: {},
      createdAt: '2026-07-14T00:00:00.000Z'
    });
    await registry.publish({
      id: 'evt_2',
      projectId,
      sessionId: 'ses_aaaaaaaaaaaa',
      type: 'session.deleted',
      payload: {},
      createdAt: '2026-07-14T00:00:01.000Z'
    });

    expect(seen).toEqual(['session.deleted']);
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
    projectMembers: {} as never,
    requestInteraction: async () => ({ status: 'cancelled' as const, reason: 'unavailable' as const }),
    workerScheduler: createExperienceWorkerScheduler(store, 'pack-a', experienceId)
  });
  const registry = new ExperienceWorkerRegistry({
    store,
    contextFor: (_atomPackId, _permissions, experienceId) => contextFor(experienceId)
  });
  for (const experienceId of ['board', 'timeline']) {
    registry.register('pack-a', ['experience.worker'], {
      experienceId,
      subscriptions: [],
      onProjectStart: async () => {},
      onEvent: async () => {},
      onWake: async () => {
        seen.push(experienceId);
      }
    });
  }

  try {
    await contextFor('board').workerScheduler.schedule(projectId, {
      key: 'dispatch',
      runAt: '2026-07-14T00:00:00.000Z'
    });
    await contextFor('timeline').workerScheduler.schedule(projectId, {
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
    await expect(state.get(missingProjectId, 'task/a')).rejects.toThrow('project not found');
    await expect(
      scheduler.schedule(missingProjectId, { key: 'dispatch', runAt: '2026-07-14T00:00:00.000Z' })
    ).rejects.toThrow('project not found');
  } finally {
    store.close();
  }
});

test('draining lets an in-flight delivery finish and drops the events admitted after it', async () => {
  const store = createStore();
  const seen: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const registry = new ExperienceWorkerRegistry({ store, contextFor: () => ({}) as never });
  registry.register('pack-a', ['experience.worker'], {
    experienceId: 'board',
    subscriptions: ['session.updated'],
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
    projectId,
    sessionId: 'ses_a',
    type: 'session.updated' as const,
    payload: {},
    createdAt: '2026-07-14T00:00:00.000Z'
  });

  try {
    const inFlight = registry.publish(event('evt_1'));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(['start:evt_1']);

    const drained = registry.drain();
    await registry.publish(event('evt_2'));
    releaseFirst();
    await Promise.all([inFlight, drained]);

    expect(seen).toEqual(['start:evt_1', 'end:evt_1']);
  } finally {
    store.close();
  }
});

test('a drained registry delivers again only once it is rebound and resumed', async () => {
  const store = createStore();
  const seen: string[] = [];
  const registry = new ExperienceWorkerRegistry({ store, contextFor: () => ({}) as never });
  const worker = (label: string) => ({
    experienceId: 'board',
    subscriptions: ['session.updated' as const],
    onProjectStart: async () => {},
    onEvent: async (event: { id: string }) => {
      seen.push(`${label}:${event.id}`);
    },
    onWake: async () => {}
  });
  const event = (id: string) => ({
    id,
    projectId,
    sessionId: 'ses_a',
    type: 'session.updated' as const,
    payload: {},
    createdAt: '2026-07-14T00:00:00.000Z'
  });

  try {
    registry.register('pack-a', ['experience.worker'], worker('old'));
    await registry.publish(event('evt_1'));

    await registry.drain();
    await registry.publish(event('evt_2'));

    registry.register('pack-a', ['experience.worker'], worker('new'));
    registry.resume();
    await registry.publish(event('evt_3'));

    expect(seen).toEqual(['old:evt_1', 'new:evt_3']);
  } finally {
    store.close();
  }
});
