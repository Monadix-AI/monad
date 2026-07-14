import type { WorkspaceExperienceApi, WorkspaceExperienceApiContext } from '@monad/sdk-atom';

import {
  acceptTask,
  approveProposal,
  type ProjectTask,
  rejectProposal,
  returnForRevision,
  submitProposal
} from './domain.ts';
import { KanbanStore } from './store.ts';

type Json = Record<string, unknown>;

async function body(request: Request): Promise<Json> {
  const value = (await request.json()) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required');
  return value as Json;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be an integer`);
  return value;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new Error(`${name} must be strings`);
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function route(handler: (request: Request, context: WorkspaceExperienceApiContext) => Promise<Response>) {
  return async (request: Request, context: WorkspaceExperienceApiContext): Promise<Response> => {
    try {
      return await handler(request, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, message.includes('version conflict') ? 409 : 400);
    }
  };
}

async function taskFrom(data: Json, store: KanbanStore): Promise<ProjectTask> {
  return store.findTask(string(data.taskId, 'taskId'), string(data.projectId, 'projectId'));
}

const listTasks = route(async (request, context) => {
  const query = new URL(request.url).searchParams;
  const projectId = string(query.get('projectId'), 'projectId');
  const tasks = await new KanbanStore(context).listTasks(projectId);
  const parsedLimit = Number(query.get('limit') ?? 50);
  const limit = Number.isInteger(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 50;
  const cursor = query.get('cursor');
  const cursorIndex = cursor ? tasks.findIndex((task) => task.id === cursor) : -1;
  const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  const page = tasks.slice(start, start + limit);
  const nextCursor = start + page.length < tasks.length ? (page.at(-1)?.id ?? null) : null;
  return json({ tasks: page, nextCursor });
});

const createTask = route(async (request, context) => {
  const data = await body(request);
  const task = await new KanbanStore(context).createTask({
    projectId: string(data.projectId, 'projectId'),
    title: string(data.title, 'title'),
    idempotencyKey: string(data.idempotencyKey, 'idempotencyKey')
  });
  return json({ task }, 201);
});

const getTaskPanel = route(async (request, context) => {
  const query = new URL(request.url).searchParams;
  const projectId = string(query.get('projectId'), 'projectId');
  const task = await new KanbanStore(context).findTask(string(query.get('taskId'), 'taskId'), projectId);
  if (task.stage === 'requirements') {
    const transcript = await context.projectSessions.listMessages(task.sessionId, query.get('cursor') ?? undefined);
    return json({ task, messages: transcript.items, nextCursor: transcript.nextCursor });
  }
  const [observations, approvals] = await Promise.all([
    context.projectSessions.listObservations(task.sessionId, query.get('cursor') ?? undefined),
    context.projectSessions.listPendingApprovals(task.projectId, task.sessionId)
  ]);
  return json({
    task,
    observations: observations.items,
    approvals,
    nextCursor: observations.nextCursor
  });
});

const sendTaskMessage = route(async (request, context) => {
  const data = await body(request);
  const task = await taskFrom(data, new KanbanStore(context));
  await context.projectSessions.sendMessage(task.sessionId, {
    text: string(data.text, 'text'),
    idempotencyKey: string(data.idempotencyKey, 'idempotencyKey')
  });
  return json({ ok: true });
});

const submitTaskProposal = route(async (request, context) => {
  const data = await body(request);
  const store = new KanbanStore(context);
  const current = await taskFrom(data, store);
  const next = submitProposal(
    current,
    number(data.expectedVersion, 'expectedVersion'),
    {
      summary: string(data.summary, 'summary'),
      acceptanceCriteria: strings(data.acceptanceCriteria, 'acceptanceCriteria')
    },
    new Date().toISOString()
  );
  await store.saveTask(next, current.version, { type: 'proposal.submitted', taskId: current.id });
  return json({ task: next });
});

const decideProposal = route(async (request, context) => {
  const data = await body(request);
  const store = new KanbanStore(context);
  const current = await taskFrom(data, store);
  const expectedVersion = number(data.expectedVersion, 'expectedVersion');
  const decision = string(data.decision, 'decision');
  const now = new Date().toISOString();
  const next =
    decision === 'approve'
      ? approveProposal(current, expectedVersion, now)
      : rejectProposal(current, expectedVersion, now);
  await store.saveTask(next, current.version, { type: `proposal.${decision}`, taskId: current.id });
  if (decision === 'approve') {
    await context.workerScheduler.schedule(current.projectId, { key: 'dispatch', runAt: now });
  }
  return json({ task: next });
});

const controlExecution = route(async (request, context) => {
  const data = await body(request);
  const action = string(data.action, 'action');
  if (action === 'resolve-approval') {
    const decision = string(data.decision, 'decision');
    await context.projectSessions.resolveApproval(
      string(data.approvalId, 'approvalId'),
      decision === 'approved' ? 'approved' : 'denied'
    );
    return json({ ok: true });
  }
  const store = new KanbanStore(context);
  const current = await taskFrom(data, store);
  const expectedVersion = number(data.expectedVersion, 'expectedVersion');
  if (current.version !== expectedVersion) throw new Error(`version conflict: expected ${expectedVersion}`);
  const now = new Date().toISOString();
  if (action === 'pause') await context.projectSessions.pause(current.sessionId);
  if (action === 'cancel') await context.projectSessions.cancel(current.sessionId);
  const next: ProjectTask = {
    ...current,
    stage: action === 'cancel' ? 'cancelled' : 'execution',
    executionState: action === 'cancel' ? 'failed' : 'queued',
    version: current.version + 1,
    updatedAt: now
  };
  await store.saveTask(next, current.version, { type: `execution.${action}`, taskId: current.id });
  if (action !== 'cancel') await context.workerScheduler.schedule(current.projectId, { key: 'dispatch', runAt: now });
  return json({ task: next });
});

const decideAcceptance = route(async (request, context) => {
  const data = await body(request);
  const store = new KanbanStore(context);
  const current = await taskFrom(data, store);
  const expectedVersion = number(data.expectedVersion, 'expectedVersion');
  const decision = string(data.decision, 'decision');
  const now = new Date().toISOString();
  const next =
    decision === 'accept'
      ? acceptTask(current, expectedVersion, now)
      : returnForRevision(current, expectedVersion, string(data.reason, 'reason'), now);
  await store.saveTask(next, current.version, { type: `acceptance.${decision}`, taskId: current.id });
  if (decision !== 'accept') await context.workerScheduler.schedule(current.projectId, { key: 'dispatch', runAt: now });
  return json({ task: next });
});

export const kanbanApi: WorkspaceExperienceApi = {
  experienceId: 'kanban',
  routes: [
    { method: 'GET', path: '/tasks', handle: listTasks },
    { method: 'POST', path: '/tasks/create', handle: createTask },
    { method: 'GET', path: '/tasks/panel', handle: getTaskPanel },
    { method: 'POST', path: '/messages/send', handle: sendTaskMessage },
    { method: 'POST', path: '/proposals/submit', handle: submitTaskProposal },
    { method: 'POST', path: '/proposals/decide', handle: decideProposal },
    { method: 'POST', path: '/execution/control', handle: controlExecution },
    { method: 'POST', path: '/acceptance/decide', handle: decideAcceptance }
  ]
};
