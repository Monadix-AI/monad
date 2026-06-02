import type { SessionMemberBinding } from '@monad/protocol';
import type { ExperienceStateStore, ProjectSessionRunSnapshot, WorkplaceExperienceApiContext } from '@monad/sdk-atom';

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
      const current = records.get(compound);
      if (current?.version !== expectedVersion) return false;
      records.delete(compound);
      return true;
    }
  };
}

function fixture({ confirmed = false }: { confirmed?: boolean } = {}) {
  const runs = new Map<string, ProjectSessionRunSnapshot>();
  const prompts: string[] = [];
  const artifacts: Array<{
    messageId: string;
    memberId?: string;
    name?: string;
    path: string;
    createdAt: string;
  }> = [];
  const interactionRequests: unknown[] = [];
  const removals: Array<{ memberId: string; sessionId: string }> = [];
  const sessions = [{ id: 'ses_a', title: 'A', state: 'active' }];
  const templates = [
    { id: 'tmpl_codex', type: 'mesh-agent' as const, name: 'codex', displayName: 'Codex' },
    { id: 'tmpl_claude', type: 'mesh-agent' as const, name: 'claude-code', displayName: 'Claude' }
  ];
  const members: SessionMemberBinding[] = [];
  const context = {
    atomPackId: 'monad-power-pack',
    experienceState: memoryState(),
    projectSessions: {
      list: async () => sessions,
      create: async (_projectId: string, input: { title: string }) => {
        sessions[0] = { id: 'ses_a', title: input.title, state: 'active' };
        return { id: 'ses_a' };
      },
      runTurn: async (_sessionId: string, input: { text: string }) => {
        prompts.push(input.text);
        const id = `run_${prompts.length}`;
        runs.set(id, { id, state: 'running' });
        return { runId: id };
      },
      getRun: async (_sessionId: string, runId: string) => runs.get(runId) ?? null,
      sendMessage: async () => {},
      listMessages: async () => ({
        items: [{ id: 'msg_a', role: 'user', text: 'Discuss A', createdAt: '2026-07-22T00:00:00.000Z' }],
        nextCursor: null
      }),
      listArtifacts: async () => artifacts,
      listObservations: async () => ({
        items: [{ id: 'evt_a', kind: 'tool.called', text: 'Tool calls', createdAt: '2026-07-22T00:00:00.000Z' }],
        nextCursor: null
      }),
      listPendingApprovals: async () => [],
      pause: async () => {},
      cancel: async () => {},
      resolveApproval: async () => {}
    },
    projectMembers: {
      listTemplates: async () => templates,
      listSessionMembers: async () => members,
      inviteSessionMember: async (_sessionId: string, templateId: string) => {
        const template = templates.find((candidate) => candidate.id === templateId);
        if (!template) throw new Error(`member template not found: ${templateId}`);
        if (members.some((entry) => entry.member.profileId === templateId)) {
          throw new Error(`member already invited into this session: ${templateId}`);
        }
        const now = '2026-07-22T00:00:00.000Z';
        // The mock keeps member.id === templateId so the tests can address members by their template id.
        const entry: SessionMemberBinding = {
          member: {
            id: templateId,
            projectId: 'prj_test000000001',
            profileId: templateId,
            type: template.type,
            displayName: template.displayName,
            customPrompt: null,
            launchOverrides: {},
            workingDirectoryOverride: null,
            lifecycle: 'enabled',
            createdAt: now,
            updatedAt: now
          },
          binding: {
            sessionId: 'ses_a',
            projectMemberId: templateId,
            lastDeliveredSeq: 0,
            lastVisibleSeq: 0,
            currentNativeRuntimeSessionId: null,
            lifecycle: 'active',
            lastHealth: null,
            createdAt: now,
            updatedAt: now
          }
        };
        members.push(entry);
        return entry;
      },
      removeSessionMember: async (sessionId: string, memberId: string) => {
        removals.push({ sessionId, memberId });
        const index = members.findIndex((entry) => entry.member.id === memberId);
        if (index < 0) throw new Error(`session member not found: ${memberId}`);
        members.splice(index, 1);
      }
    },
    requestInteraction: async (request: unknown) => {
      interactionRequests.push(request);
      return confirmed
        ? { status: 'submitted' as const, values: { confirmed: true } }
        : { status: 'cancelled' as const, reason: 'close' as const };
    },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkplaceExperienceApiContext;
  return { artifacts, context, interactionRequests, prompts, removals, runs, sessions };
}

async function call(context: WorkplaceExperienceApiContext, method: string, path: string, body?: unknown, query = '') {
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

async function create(context: WorkplaceExperienceApiContext) {
  const result = await call(context, 'POST', '/tasks/create', {
    projectId: 'prj_a',
    title: 'A',
    idempotencyKey: 'request-a'
  });
  return result.json.task as { id: string; version: number };
}

async function invite(
  context: WorkplaceExperienceApiContext,
  task: { id: string },
  role: 'host' | 'member' = 'host',
  templateId = 'tmpl_codex'
) {
  return call(context, 'POST', '/tasks/members', {
    projectId: 'prj_a',
    taskId: task.id,
    templateId,
    role
  });
}

test('Kanban API declares the explicit five-stage command surface', () => {
  expect(kanbanApi.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'GET /tasks',
    'GET /member-templates',
    'POST /tasks/create',
    'POST /tasks/members',
    'POST /tasks/members/remove',
    'POST /tasks/start',
    'POST /tasks/move',
    'GET /tasks/panel',
    'POST /messages/send',
    'POST /execution/control'
  ]);
});

test('created sessions compose into waiting Product Design cards', async () => {
  const { context } = fixture();
  const task = await create(context);
  const listed = await call(context, 'GET', '/tasks', undefined, '?projectId=prj_a');

  expect(listed.json).toEqual({
    tasks: [
      {
        id: task.id,
        projectId: 'prj_a',
        sessionId: 'ses_a',
        title: 'A',
        stage: 'product_design',
        version: 0,
        displayState: 'waiting',
        host: null,
        members: [],
        documents: { product_design: null, tech_design: null },
        availableActions: { start: false, moveNext: false }
      }
    ],
    nextCursor: null
  });
});

test('task listing removes an orphaned projection whose daemon session was deleted', async () => {
  const { context, sessions } = fixture();
  await create(context);
  sessions.splice(0, sessions.length);

  const listed = await call(context, 'GET', '/tasks', undefined, '?projectId=prj_a');

  expect(listed.response.status).toBe(200);
  expect(listed.json).toEqual({ tasks: [], nextCursor: null });
});

test('a member template can fill the unique host slot without starting a turn', async () => {
  const { context, prompts } = fixture();
  const task = await create(context);
  const templates = await call(context, 'GET', '/member-templates', undefined, '?projectId=prj_a');
  const assigned = await invite(context, task);

  expect(templates.json).toEqual({
    templates: [
      { id: 'tmpl_codex', type: 'mesh-agent', name: 'codex', displayName: 'Codex' },
      { id: 'tmpl_claude', type: 'mesh-agent', name: 'claude-code', displayName: 'Claude' }
    ]
  });
  expect(assigned.json.task).toMatchObject({
    version: 1,
    host: {
      member: {
        id: 'tmpl_codex',
        profileId: 'tmpl_codex',
        type: 'mesh-agent',
        displayName: 'Codex'
      },
      binding: { projectMemberId: 'tmpl_codex', lifecycle: 'active' }
    },
    members: [],
    availableActions: { start: true, moveNext: false }
  });
  expect(prompts).toEqual([]);
});

test('a second host is rejected while ordinary members remain assignable', async () => {
  const { context } = fixture();
  const task = await create(context);
  await invite(context, task);
  const member = await invite(context, task, 'member', 'tmpl_claude');
  const secondHost = await call(context, 'POST', '/tasks/members', {
    projectId: 'prj_a',
    taskId: task.id,
    templateId: 'tmpl_claude',
    role: 'host'
  });

  expect(member.json.task).toMatchObject({
    host: {
      member: {
        profileId: 'tmpl_codex',
        displayName: 'Codex'
      }
    },
    members: [{ member: { profileId: 'tmpl_claude', displayName: 'Claude' } }]
  });
  expect(secondHost.json).toEqual({ error: 'Kanban task already has a host' });
});

test('cards show only the latest canonical Markdown documents published by the current host', async () => {
  const { artifacts, context } = fixture();
  const task = await create(context);
  await invite(context, task);
  artifacts.push(
    {
      messageId: 'msg_member',
      memberId: 'tmpl_claude',
      name: 'product-design.md',
      path: '/workspace/member/product-design.md',
      createdAt: '2026-07-22T00:01:00.000Z'
    },
    {
      messageId: 'msg_host_old',
      memberId: 'tmpl_codex',
      name: 'product-design.md',
      path: '/workspace/old/product-design.md',
      createdAt: '2026-07-22T00:02:00.000Z'
    },
    {
      messageId: 'msg_host_latest',
      memberId: 'tmpl_codex',
      path: `/workspace/prj_a/sessions/ses_a/docs/kanban/${task.id}/product-design.md`,
      createdAt: '2026-07-22T00:03:00.000Z'
    },
    {
      messageId: 'msg_host_tech',
      memberId: 'tmpl_codex',
      name: 'tech-design.md',
      path: `/workspace/prj_a/sessions/ses_a/docs/kanban/${task.id}/tech-design.md`,
      createdAt: '2026-07-22T00:04:00.000Z'
    }
  );

  const listed = await call(context, 'GET', '/tasks', undefined, '?projectId=prj_a');

  expect((listed.json.tasks as Array<Record<string, unknown>>)[0]).toMatchObject({
    documents: {
      product_design: {
        name: 'product-design.md',
        path: `/workspace/prj_a/sessions/ses_a/docs/kanban/${task.id}/product-design.md`,
        updatedAt: '2026-07-22T00:03:00.000Z'
      },
      tech_design: {
        name: 'tech-design.md',
        path: `/workspace/prj_a/sessions/ses_a/docs/kanban/${task.id}/tech-design.md`,
        updatedAt: '2026-07-22T00:04:00.000Z'
      }
    }
  });
});

test('member removal rejects a task mismatch before requesting host confirmation', async () => {
  const { context, interactionRequests, removals } = fixture();
  const task = await create(context);
  await invite(context, task);

  const removed = await call(context, 'POST', '/tasks/members/remove', {
    projectId: 'prj_a',
    taskId: task.id,
    memberId: 'tmpl_other'
  });

  expect(removed.response.status).toBe(400);
  expect(removed.json).toEqual({ error: 'member does not belong to Kanban task: tmpl_other' });
  expect(interactionRequests).toEqual([]);
  expect(removals).toEqual([]);
});

test('cancelling the X confirmation keeps the assigned member without starting a turn', async () => {
  const { context, interactionRequests, prompts, removals } = fixture();
  const task = await create(context);
  await invite(context, task);

  const removed = await call(context, 'POST', '/tasks/members/remove', {
    projectId: 'prj_a',
    taskId: task.id,
    memberId: 'tmpl_codex'
  });

  expect(removed.json).toEqual({ deleted: false });
  expect(interactionRequests).toEqual([
    {
      type: 'confirm',
      title: 'Remove member?',
      description: 'Remove Codex from A?',
      confirmLabel: 'Remove'
    }
  ]);
  expect(removals).toEqual([]);
  expect(prompts).toEqual([]);
});

test('confirming the X removal returns the daemon-backed card without starting a turn', async () => {
  const { context, prompts, removals } = fixture({ confirmed: true });
  const task = await create(context);
  await invite(context, task);

  const removed = await call(context, 'POST', '/tasks/members/remove', {
    projectId: 'prj_a',
    taskId: task.id,
    memberId: 'tmpl_codex'
  });

  expect(removed.json).toEqual({
    deleted: true,
    task: {
      id: task.id,
      projectId: 'prj_a',
      sessionId: 'ses_a',
      title: 'A',
      stage: 'product_design',
      version: 2,
      displayState: 'waiting',
      host: null,
      members: [],
      documents: { product_design: null, tech_design: null },
      availableActions: { start: false, moveNext: false }
    }
  });
  expect(removals).toEqual([{ sessionId: 'ses_a', memberId: 'tmpl_codex' }]);
  expect(prompts).toEqual([]);
});

test('Start rejects a task without a host before invoking a daemon turn', async () => {
  const { context, prompts } = fixture();
  const task = await create(context);
  const started = await call(context, 'POST', '/tasks/start', {
    projectId: 'prj_a',
    taskId: task.id,
    expectedVersion: 0
  });

  expect(started.response.status).toBe(400);
  expect(started.json).toEqual({ error: 'task requires a host' });
  expect(prompts).toEqual([]);
});

test('starting a stage invokes one daemon turn and exposes daemon run state', async () => {
  const { context, prompts, runs } = fixture();
  const task = await create(context);
  await invite(context, task);
  await invite(context, task, 'member', 'tmpl_claude');
  const started = await call(context, 'POST', '/tasks/start', {
    projectId: 'prj_a',
    taskId: task.id,
    expectedVersion: 1
  });

  expect(started.json.task).toMatchObject({
    stage: 'product_design',
    version: 2,
    displayState: 'running',
    availableActions: { start: false, moveNext: false }
  });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('Stage prompt:\nDefine the user outcome');
  expect(prompts[0]).toContain(`$MONAD_SESSION_WORKSPACE/docs/kanban/${task.id}/product-design.md`);
  expect(prompts[0]).toContain('host is its sole maintainer');
  expect(prompts[0]).toContain('Advanced prompt for host [Codex (tmpl_codex)]');
  expect(prompts[0]).toContain('Advanced prompt for member [Claude (tmpl_claude)]');

  runs.set('run_1', { id: 'run_1', state: 'completed' });
  const listed = await call(context, 'GET', '/tasks', undefined, '?projectId=prj_a');
  expect((listed.json.tasks as Array<Record<string, unknown>>)[0]).toMatchObject({
    displayState: 'ready',
    documents: { product_design: null, tech_design: null },
    availableActions: { start: false, moveNext: false }
  });
});

test('moving requires a completed daemon run, the host document, and exactly the adjacent stage', async () => {
  const { artifacts, context, runs } = fixture();
  const task = await create(context);
  await invite(context, task);
  await call(context, 'POST', '/tasks/start', {
    projectId: 'prj_a',
    taskId: task.id,
    expectedVersion: 1
  });

  const early = await call(context, 'POST', '/tasks/move', {
    projectId: 'prj_a',
    taskId: task.id,
    expectedVersion: 2,
    destination: 'tech_design'
  });
  expect(early.response.status).toBe(400);

  runs.set('run_1', { id: 'run_1', state: 'completed' });
  const missingDocument = await call(context, 'POST', '/tasks/move', {
    projectId: 'prj_a',
    taskId: task.id,
    expectedVersion: 2,
    destination: 'tech_design'
  });
  expect(missingDocument.json).toEqual({
    error: 'stage requires host-maintained Markdown document: product-design.md'
  });
  artifacts.push({
    messageId: 'msg_product_doc',
    memberId: 'tmpl_codex',
    name: 'product-design.md',
    path: `/workspace/prj_a/sessions/ses_a/docs/kanban/${task.id}/product-design.md`,
    createdAt: '2026-07-22T00:05:00.000Z'
  });
  const jump = await call(context, 'POST', '/tasks/move', {
    projectId: 'prj_a',
    taskId: task.id,
    expectedVersion: 2,
    destination: 'implementation'
  });
  expect(jump.response.status).toBe(400);

  const moved = await call(context, 'POST', '/tasks/move', {
    projectId: 'prj_a',
    taskId: task.id,
    expectedVersion: 2,
    destination: 'tech_design'
  });
  expect(moved.json.task).toMatchObject({
    stage: 'tech_design',
    version: 3,
    displayState: 'waiting',
    availableActions: { start: true, moveNext: false }
  });
});

test('task panel composes daemon messages, observations, and approvals for every stage', async () => {
  const { context } = fixture();
  const task = await create(context);
  const panel = await call(context, 'GET', '/tasks/panel', undefined, `?projectId=prj_a&taskId=${task.id}`);

  expect(panel.json).toEqual({
    messages: [{ id: 'msg_a', role: 'user', text: 'Discuss A', createdAt: '2026-07-22T00:00:00.000Z' }],
    observations: [{ id: 'evt_a', kind: 'tool.called', text: 'Tool calls', createdAt: '2026-07-22T00:00:00.000Z' }],
    approvals: [],
    nextCursor: null
  });
});
