import type { ExperienceStateStore, WorkspaceExperienceApiContext } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { approveProposal, submitProposal } from '../../src/experiences/kanban/domain.ts';
import { KanbanStore } from '../../src/experiences/kanban/store.ts';
import { dispatchRunnableTasks, kanbanWorker } from '../../src/experiences/kanban/worker.ts';

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

async function fixture() {
  const runs: string[] = [];
  const pending = new Map<string, Array<{ id: string; sessionId: string; summary: string }>>();
  const context = {
    atomPackId: 'monad-power-pack',
    principalId: 'prn_a',
    experienceState: memoryState(),
    projectSessions: {
      create: async (_projectId: string, input: { title: string }) => ({ id: `ses_${input.title}` }),
      runTurn: async (sessionId: string) => {
        runs.push(sessionId);
        return { runId: `run_${sessionId}` };
      },
      listPendingApprovals: async (_projectId: string, sessionId?: string) => pending.get(sessionId ?? '') ?? []
    },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkspaceExperienceApiContext;
  const store = new KanbanStore(context);
  const tasks = [];
  for (const title of ['A', 'B', 'C']) {
    const created = await store.createTask({ projectId: 'prj_a', title, idempotencyKey: title });
    const proposed = submitProposal(
      created,
      0,
      { summary: title, acceptanceCriteria: [`${title} done`] },
      '2026-07-14T00:00:00.000Z'
    );
    await store.saveTask(proposed, 0, { type: 'proposal.submitted' });
    const queued = approveProposal(proposed, 1, '2026-07-14T00:00:01.000Z');
    await store.saveTask(queued, 1, { type: 'proposal.approved' });
    tasks.push(queued);
  }
  return { context, store, tasks, runs, pending };
}

test('worker starts no more than the configured number of tasks per project', async () => {
  const { context, store, runs } = await fixture();

  const started = await dispatchRunnableTasks(context, 'prj_a', {
    limit: 2,
    workerId: 'worker-a',
    now: '2026-07-14T00:00:02.000Z'
  });

  expect(runs).toHaveLength(2);
  expect(new Set(runs)).toEqual(new Set(started.map((task) => task.sessionId)));
  expect((await store.listTasks('prj_a')).filter((task) => task.executionState === 'running')).toHaveLength(2);
  expect((await store.listTasks('prj_a')).filter((task) => task.executionState === 'queued')).toHaveLength(1);
});

test('approval_requested pauses only its matching task', async () => {
  const { context, store, tasks, pending } = await fixture();
  await dispatchRunnableTasks(context, 'prj_a', { limit: 2, workerId: 'worker-a', now: '2026-07-14T00:00:02.000Z' });
  const [first, second] = tasks;
  if (!first || !second) throw new Error('fixture requires two tasks');
  pending.set(first.sessionId, [{ id: 'apr_a', sessionId: first.sessionId, summary: 'shell' }]);

  await kanbanWorker.onEvent(
    {
      id: 'evt_approval',
      projectId: 'prj_a',
      sessionId: first.sessionId,
      type: 'tool.approval_requested',
      payload: { requestId: 'apr_a' },
      createdAt: '2026-07-14T00:00:03.000Z'
    },
    context
  );

  expect((await store.findTask(first.id, 'prj_a')).executionState).toBe('waiting_approval');
  expect((await store.findTask(second.id, 'prj_a')).executionState).toBe('running');
});

test('session.stream_ended moves a clean run to acceptance without parsing chat', async () => {
  const { context, store, tasks } = await fixture();
  await dispatchRunnableTasks(context, 'prj_a', { limit: 1, workerId: 'worker-a', now: '2026-07-14T00:00:02.000Z' });
  const running = (await store.listTasks('prj_a')).find((task) => task.executionState === 'running');
  if (!running) throw new Error('fixture requires a running task');

  await kanbanWorker.onEvent(
    {
      id: 'evt_end',
      projectId: 'prj_a',
      sessionId: running.sessionId,
      type: 'session.stream_ended',
      payload: {},
      createdAt: '2026-07-14T00:00:04.000Z'
    },
    context
  );

  const task = await store.findTask(running.id, 'prj_a');
  expect(task.stage).toBe('acceptance');
  expect(task.runs.at(-1)?.status).toBe('succeeded');
  expect(tasks).toHaveLength(3);
});

test('agent error records a failed run and the following stream end does not enter acceptance', async () => {
  const { context, store, tasks } = await fixture();
  await dispatchRunnableTasks(context, 'prj_a', { limit: 1, workerId: 'worker-a', now: '2026-07-14T00:00:02.000Z' });
  const running = (await store.listTasks('prj_a')).find((task) => task.executionState === 'running');
  if (!running) throw new Error('fixture requires a running task');

  await kanbanWorker.onEvent(
    {
      id: 'evt_error',
      projectId: 'prj_a',
      sessionId: running.sessionId,
      type: 'agent.error',
      payload: { message: 'model failed' },
      createdAt: '2026-07-14T00:00:03.000Z'
    },
    context
  );
  await kanbanWorker.onEvent(
    {
      id: 'evt_end_after_error',
      projectId: 'prj_a',
      sessionId: running.sessionId,
      type: 'session.stream_ended',
      payload: {},
      createdAt: '2026-07-14T00:00:04.000Z'
    },
    context
  );

  const failed = await store.findTask(running.id, 'prj_a');
  expect(failed.stage).toBe('execution');
  expect(failed.executionState).toBe('failed');
  expect(failed.runs.at(-1)?.status).toBe('failed');
  expect(tasks).toHaveLength(3);
});
