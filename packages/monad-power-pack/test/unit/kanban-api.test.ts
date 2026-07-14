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

function fixture(pendingApprovals: Array<{ id: string }> = []) {
  const scheduled: string[] = [];
  const paused: string[] = [];
  const resolvedApprovals: Array<{ decision: string; id: string }> = [];
  const approvalScopes: Array<{ projectId: string; sessionId: string }> = [];
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
      listPendingApprovals: async (projectId: string, sessionId: string) => {
        approvalScopes.push({ projectId, sessionId });
        return pendingApprovals;
      },
      pause: async (sessionId: string) => {
        paused.push(sessionId);
      },
      cancel: async () => {},
      resolveApproval: async (id: string, decision: string) => {
        resolvedApprovals.push({ id, decision });
      }
    },
    workerScheduler: {
      schedule: async (_projectId: string, input: { key: string }) => {
        scheduled.push(input.key);
      },
      cancel: async () => {}
    }
  } as unknown as WorkspaceExperienceApiContext;
  return { context, scheduled, paused, resolvedApprovals, approvalScopes };
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

test('pause keeps a task non-runnable until an explicit resume', async () => {
  const { context, scheduled, paused } = fixture();
  const created = await call(context, 'POST', '/tasks/create', {
    projectId: 'prj_a',
    title: 'A',
    idempotencyKey: 'request-a'
  });
  const taskId = String((created.json.task as { id: string }).id);
  await call(context, 'POST', '/proposals/submit', {
    projectId: 'prj_a',
    taskId,
    expectedVersion: 0,
    summary: 'Ship A',
    acceptanceCriteria: []
  });
  await call(context, 'POST', '/proposals/decide', {
    projectId: 'prj_a',
    taskId,
    expectedVersion: 1,
    decision: 'approve'
  });
  scheduled.length = 0;

  const pausedTask = await call(context, 'POST', '/execution/control', {
    projectId: 'prj_a',
    taskId,
    expectedVersion: 2,
    action: 'pause'
  });
  expect(pausedTask.json.task).toMatchObject({ executionState: 'paused', version: 3 });
  expect(paused).toEqual(['ses_a']);
  expect(scheduled).toEqual([]);

  const resumedTask = await call(context, 'POST', '/execution/control', {
    projectId: 'prj_a',
    taskId,
    expectedVersion: 3,
    action: 'resume'
  });
  expect(resumedTask.json.task).toMatchObject({ executionState: 'queued', version: 4 });
  expect(scheduled).toEqual(['dispatch']);
});

test('resolves only approvals that belong to the requested task session', async () => {
  const { context, resolvedApprovals, approvalScopes } = fixture([{ id: 'approval-a' }]);
  const created = await call(context, 'POST', '/tasks/create', {
    projectId: 'prj_a',
    title: 'A',
    idempotencyKey: 'request-a'
  });
  const taskId = String((created.json.task as { id: string }).id);

  const rejected = await call(context, 'POST', '/execution/control', {
    action: 'resolve-approval',
    approvalId: 'approval-other',
    decision: 'approved',
    projectId: 'prj_a',
    taskId
  });
  expect(rejected.response.status).toBe(400);
  expect(resolvedApprovals).toEqual([]);

  const resolved = await call(context, 'POST', '/execution/control', {
    action: 'resolve-approval',
    approvalId: 'approval-a',
    decision: 'approved',
    projectId: 'prj_a',
    taskId
  });
  expect(resolved.response.status).toBe(200);
  expect(resolvedApprovals).toEqual([{ id: 'approval-a', decision: 'approved' }]);
  expect(approvalScopes).toEqual([
    { projectId: 'prj_a', sessionId: 'ses_a' },
    { projectId: 'prj_a', sessionId: 'ses_a' }
  ]);
});

test('unknown proposal decisions and execution actions are rejected without mutation', async () => {
  const { context, scheduled } = fixture();
  const created = await call(context, 'POST', '/tasks/create', {
    projectId: 'prj_a',
    title: 'A',
    idempotencyKey: 'request-a'
  });
  const taskId = String((created.json.task as { id: string }).id);
  await call(context, 'POST', '/proposals/submit', {
    projectId: 'prj_a',
    taskId,
    expectedVersion: 0,
    summary: 'Ship A',
    acceptanceCriteria: []
  });

  const badDecision = await call(context, 'POST', '/proposals/decide', {
    projectId: 'prj_a',
    taskId,
    expectedVersion: 1,
    decision: 'maybe'
  });
  expect(badDecision.response.status).toBe(400);

  const approved = await call(context, 'POST', '/proposals/decide', {
    projectId: 'prj_a',
    taskId,
    expectedVersion: 1,
    decision: 'approve'
  });
  expect(approved.response.status).toBe(200);
  scheduled.length = 0;

  const badAction = await call(context, 'POST', '/execution/control', {
    projectId: 'prj_a',
    taskId,
    expectedVersion: 2,
    action: 'restart-everything'
  });
  expect(badAction.response.status).toBe(400);
  expect(scheduled).toEqual([]);
});
