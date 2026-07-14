import type { ExperienceStateStore, WorkspaceExperienceApiContext } from '@monad/sdk-atom';

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
    }
  };
}

function fixture() {
  const scheduled: string[] = [];
  const context = {
    atomPackId: 'monad-power-pack',
    principalId: 'prn_a',
    experienceState: memoryState(),
    projectSessions: {
      create: async () => ({ id: 'ses_a' }),
      sendMessage: async () => {},
      listMessages: async () => ({
        items: [{ id: 'msg_a', role: 'user', text: 'Discuss A', createdAt: '2026-07-14T00:00:00.000Z' }],
        nextCursor: null
      }),
      listObservations: async () => ({
        items: [{ id: 'evt_a', kind: 'tool.called', text: 'Tool calls', createdAt: '2026-07-14T00:00:00.000Z' }],
        nextCursor: null
      }),
      listPendingApprovals: async () => []
    },
    workerScheduler: {
      schedule: async (_projectId: string, input: { key: string }) => {
        scheduled.push(input.key);
      },
      cancel: async () => {}
    }
  } as unknown as WorkspaceExperienceApiContext;
  return { context, scheduled };
}

async function call(context: WorkspaceExperienceApiContext, method: string, path: string, body?: unknown, query = '') {
  const route = kanbanApi.routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`missing route: ${method} ${path}`);
  const response = await route.handle(
    new Request(`https://example.test${path}${query}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }),
    context
  );
  return { response, json: (await response.json()) as Record<string, unknown> };
}

test('Kanban API declares only the eight fixed routes', () => {
  expect(kanbanApi.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'GET /tasks',
    'POST /tasks/create',
    'GET /tasks/panel',
    'POST /messages/send',
    'POST /proposals/submit',
    'POST /proposals/decide',
    'POST /execution/control',
    'POST /acceptance/decide'
  ]);
});

test('create, proposal submit, and approval advance a task and schedule dispatch', async () => {
  const { context, scheduled } = fixture();
  const created = await call(context, 'POST', '/tasks/create', {
    projectId: 'prj_a',
    title: 'A',
    idempotencyKey: 'request-a'
  });
  const task = created.json.task as { id: string };
  const submitted = await call(context, 'POST', '/proposals/submit', {
    projectId: 'prj_a',
    taskId: task.id,
    expectedVersion: 0,
    summary: 'Ship A',
    acceptanceCriteria: ['tests pass']
  });
  expect(submitted.json.task).toMatchObject({ requirementsState: 'proposal_awaiting_approval', version: 1 });

  const approved = await call(context, 'POST', '/proposals/decide', {
    projectId: 'prj_a',
    taskId: task.id,
    expectedVersion: 1,
    decision: 'approve'
  });
  expect(approved.json.task).toMatchObject({ stage: 'execution', executionState: 'queued', version: 2 });
  expect(scheduled).toEqual(['dispatch']);
});

test('task panel reads transcript for requirements and normalized observations for execution', async () => {
  const { context } = fixture();
  const created = await call(context, 'POST', '/tasks/create', {
    projectId: 'prj_a',
    title: 'A',
    idempotencyKey: 'request-a'
  });
  const task = created.json.task as { id: string };
  const requirements = await call(context, 'GET', '/tasks/panel', undefined, `?projectId=prj_a&taskId=${task.id}`);
  expect(requirements.json.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Discuss A' })]));

  await call(context, 'POST', '/proposals/submit', {
    projectId: 'prj_a',
    taskId: task.id,
    expectedVersion: 0,
    summary: 'Ship A',
    acceptanceCriteria: []
  });
  await call(context, 'POST', '/proposals/decide', {
    projectId: 'prj_a',
    taskId: task.id,
    expectedVersion: 1,
    decision: 'approve'
  });
  const execution = await call(context, 'GET', '/tasks/panel', undefined, `?projectId=prj_a&taskId=${task.id}`);
  expect(execution.json.observations).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'tool.called' })])
  );
});

test('task listing is cursor paginated', async () => {
  const { context } = fixture();
  for (const title of ['A', 'B', 'C']) {
    await call(context, 'POST', '/tasks/create', { projectId: 'prj_a', title, idempotencyKey: title });
  }

  const first = await call(context, 'GET', '/tasks', undefined, '?projectId=prj_a&limit=2');
  expect(first.json.tasks).toHaveLength(2);
  expect(first.json.nextCursor).toBeString();
  const second = await call(
    context,
    'GET',
    '/tasks',
    undefined,
    `?projectId=prj_a&limit=2&cursor=${encodeURIComponent(String(first.json.nextCursor))}`
  );
  expect(second.json.tasks).toHaveLength(1);
  expect(second.json.nextCursor).toBeNull();
});
