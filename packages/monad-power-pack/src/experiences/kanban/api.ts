import type { SessionMemberBinding } from '@monad/protocol';
import type {
  ProjectSessionArtifact,
  ProjectSessionRunSnapshot,
  WorkplaceExperienceApi,
  WorkplaceExperienceApiContext
} from '@monad/sdk-atom';
import type { KanbanStage, KanbanTaskProjection } from './domain.ts';

import { z } from 'zod';

import { injectExperiencePrompts } from '../prompt-injection.ts';
import {
  assignTaskHostProjection,
  clearTaskHostProjection,
  KANBAN_STAGES,
  moveTaskProjection,
  nextKanbanStage,
  startTaskProjection
} from './domain.ts';
import { KanbanStore } from './store.ts';

type Json = Record<string, unknown>;
type DisplayState = 'waiting' | 'scheduled' | 'running' | 'ready' | 'failed' | 'cancelled' | 'completed';
type KanbanDocumentStage = Extract<KanbanStage, 'product_design' | 'tech_design'>;

interface KanbanStageDocument {
  name: string;
  path: string;
  updatedAt: string;
}

interface KanbanCard {
  id: string;
  projectId: string;
  sessionId: string;
  title: string;
  stage: KanbanStage;
  version: number;
  displayState: DisplayState;
  host: SessionMemberBinding | null;
  members: SessionMemberBinding[];
  documents: Record<KanbanDocumentStage, KanbanStageDocument | null>;
  availableActions: { start: boolean; moveNext: boolean };
}

const STAGE_LABELS: Record<KanbanStage, string> = {
  product_design: 'Product Design',
  tech_design: 'Tech Design',
  implementation: 'Implementation',
  verify: 'Verify',
  completed: 'Completed'
};

type KanbanMemberRole = 'host' | 'member';

const KANBAN_DOCUMENTS: Record<KanbanDocumentStage, { label: string; name: string }> = {
  product_design: { label: 'Product Design', name: 'product-design.md' },
  tech_design: { label: 'Tech Design', name: 'tech-design.md' }
};

function documentPath(task: KanbanTaskProjection, stage: KanbanDocumentStage): string {
  return `$MONAD_SESSION_WORKSPACE/docs/kanban/${task.id}/${KANBAN_DOCUMENTS[stage].name}`;
}

function canonicalDocumentSuffix(task: KanbanTaskProjection, stage: KanbanDocumentStage): string {
  return `/sessions/${task.sessionId}/docs/kanban/${task.id}/${KANBAN_DOCUMENTS[stage].name}`;
}

const KANBAN_PROMPT_INJECTION = {
  stagePrompts: {
    product_design: (task: KanbanTaskProjection) =>
      `Define the user outcome, constraints, scope boundaries, and observable acceptance criteria. Resolve product ambiguity before proposing implementation details. The required output is a Markdown document at ${documentPath(task, 'product_design')}. The host is its sole maintainer and must attach the latest file to a public project message before completing this stage.`,
    tech_design: (task: KanbanTaskProjection) =>
      `Turn the approved product outcome into an implementable technical design. Cover contracts, ownership boundaries, data flow, failure modes, migration risk, and validation strategy. The required output is a Markdown document at ${documentPath(task, 'tech_design')}. The host is its sole maintainer and must attach the latest file to a public project message before completing this stage.`,
    implementation:
      'Implement the approved design within scope. Preserve unrelated work, add behavior-focused coverage, and report changed surfaces plus concrete validation evidence.',
    verify:
      'Validate the delivered behavior against the acceptance criteria. Exercise relevant failure paths and regressions, and report evidence for every conclusion.',
    completed: 'Do not begin new work. Summarize the completed outcome and retained follow-ups.'
  },
  advancedPrompts: {
    host: 'You own this stage. Coordinate the team, decompose and route work, reconcile conflicting findings, and synthesize the stage result. You alone maintain and publish any required stage document; incorporate member contributions into the canonical Markdown file and attach every material update. Do not declare the stage complete without evidence.',
    member:
      'Execute the work routed to you, keep the host informed of evidence and blockers, and stay within the current stage. Do not independently redefine the stage outcome.'
  }
} as const;

function artifactName(artifact: ProjectSessionArtifact): string {
  return artifact.name ?? artifact.path.split(/[\\/]/).at(-1) ?? artifact.path;
}

function stageDocuments(
  task: KanbanTaskProjection,
  artifacts: readonly ProjectSessionArtifact[]
): Record<KanbanDocumentStage, KanbanStageDocument | null> {
  const hostArtifacts = task.hostMemberId
    ? artifacts.filter((artifact) => artifact.memberId === task.hostMemberId)
    : [];
  return Object.fromEntries(
    (Object.entries(KANBAN_DOCUMENTS) as Array<[KanbanDocumentStage, { label: string; name: string }]>).map(
      ([stage, spec]) => {
        const suffix = canonicalDocumentSuffix(task, stage);
        const artifact = hostArtifacts.findLast(
          (candidate) => artifactName(candidate) === spec.name && candidate.path.replaceAll('\\', '/').endsWith(suffix)
        );
        return [stage, artifact ? { name: spec.name, path: artifact.path, updatedAt: artifact.createdAt } : null];
      }
    )
  ) as Record<KanbanDocumentStage, KanbanStageDocument | null>;
}

async function body(request: Request): Promise<Json> {
  const value = z.json().parse(await request.json());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required');
  return value as Json;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function number(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${name} must be an integer`);
  return Number(value);
}

function oneOf<const T extends readonly string[]>(value: unknown, name: string, allowed: T): T[number] {
  const parsed = string(value, name);
  if (!allowed.includes(parsed)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  return parsed as T[number];
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function route(handler: (request: Request, context: WorkplaceExperienceApiContext) => Promise<Response>) {
  return async (request: Request, context: WorkplaceExperienceApiContext): Promise<Response> => {
    try {
      return await handler(request, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, message.includes('version conflict') ? 409 : 400);
    }
  };
}

function displayState(
  task: KanbanTaskProjection,
  sessionState: string | undefined,
  run: ProjectSessionRunSnapshot | null
): DisplayState {
  if (task.stage === 'completed') return 'completed';
  if (sessionState === 'cancelled') return 'cancelled';
  if (!task.stageRunId) return 'waiting';
  if (!run || run.state === 'failed' || run.state === 'cancelled') return 'failed';
  if (run.state === 'completed') return 'ready';
  return run.state;
}

async function composeCard(
  context: WorkplaceExperienceApiContext,
  task: KanbanTaskProjection,
  sessionState?: string
): Promise<KanbanCard> {
  const [run, members, artifacts] = await Promise.all([
    task.stageRunId ? context.projectSessions.getRun(task.sessionId, task.stageRunId) : Promise.resolve(null),
    context.projectMembers.listSessionMembers(task.sessionId),
    context.projectSessions.listArtifacts?.(task.sessionId) ?? Promise.resolve([])
  ]);
  const state = displayState(task, sessionState, run);
  const host = members.find((candidate) => candidate.member.id === task.hostMemberId) ?? null;
  const documents = stageDocuments(task, artifacts);
  const requiredDocument = task.stage in KANBAN_DOCUMENTS ? documents[task.stage as KanbanDocumentStage] : null;
  return {
    id: task.id,
    projectId: task.projectId,
    sessionId: task.sessionId,
    title: task.title,
    stage: task.stage,
    version: task.version,
    displayState: state,
    host,
    members: members.filter((candidate) => candidate.member.id !== host?.member.id),
    documents,
    availableActions: {
      start: host !== null && (state === 'waiting' || state === 'failed'),
      moveNext:
        state === 'ready' &&
        nextKanbanStage(task.stage) !== null &&
        (!(task.stage in KANBAN_DOCUMENTS) || requiredDocument !== null)
    }
  };
}

async function taskFrom(data: Json, store: KanbanStore): Promise<KanbanTaskProjection> {
  return store.findTask(string(data.taskId, 'taskId'), string(data.projectId, 'projectId'));
}

async function sessionState(context: WorkplaceExperienceApiContext, task: KanbanTaskProjection): Promise<string> {
  return (
    (await context.projectSessions.list(task.projectId)).find((session) => session.id === task.sessionId)?.state ?? ''
  );
}

function stageDirective(
  task: KanbanTaskProjection,
  host: SessionMemberBinding,
  members: readonly SessionMemberBinding[]
): string {
  const stage = STAGE_LABELS[task.stage];
  return injectExperiencePrompts({
    basePrompt: `Work on the ${stage} stage for "${task.title}". Complete this stage and report the result in the session.`,
    stage: task.stage,
    context: task,
    participants: [
      { id: host.member.id, label: host.member.displayName, role: 'host' as const },
      ...members.map((member) => ({
        id: member.member.id,
        label: member.member.displayName,
        role: 'member' as const
      }))
    ],
    injection: KANBAN_PROMPT_INJECTION
  });
}

const listTasks = route(async (request, context) => {
  const query = new URL(request.url).searchParams;
  const projectId = string(query.get('projectId'), 'projectId');
  const sessions = await context.projectSessions.list(projectId);
  const tasks = await new KanbanStore(context).reconcileTasks(projectId, sessions);
  const states = new Map(sessions.map((session) => [session.id, session.state]));
  const parsedLimit = Number(query.get('limit') ?? 50);
  const limit = Number.isInteger(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 50;
  const cursor = query.get('cursor');
  const cursorIndex = cursor ? tasks.findIndex((task) => task.id === cursor) : -1;
  const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  const page = tasks.slice(start, start + limit);
  const cards = await Promise.all(page.map((task) => composeCard(context, task, states.get(task.sessionId))));
  const nextCursor = start + page.length < tasks.length ? (page.at(-1)?.id ?? null) : null;
  return json({ tasks: cards, nextCursor });
});

const createTask = route(async (request, context) => {
  const data = await body(request);
  const task = await new KanbanStore(context).createTask({
    projectId: string(data.projectId, 'projectId'),
    title: string(data.title, 'title'),
    idempotencyKey: string(data.idempotencyKey, 'idempotencyKey')
  });
  return json({ task: await composeCard(context, task, await sessionState(context, task)) }, 201);
});

const listMemberTemplates = route(async (request, context) => {
  const projectId = string(new URL(request.url).searchParams.get('projectId'), 'projectId');
  return json({ templates: await context.projectMembers.listTemplates(projectId) });
});

const addTaskMember = route(async (request, context) => {
  const data = await body(request);
  const store = new KanbanStore(context);
  const task = await taskFrom(data, store);
  const role = oneOf(data.role, 'role', ['host', 'member'] as const) satisfies KanbanMemberRole;
  const templateId = string(data.templateId, 'templateId');
  const existingMembers = await context.projectMembers.listSessionMembers(task.sessionId);
  const existing = existingMembers.find((candidate) => candidate.member.profileId === templateId);
  if (role === 'host' && task.hostMemberId && task.hostMemberId !== existing?.member.id) {
    throw new Error('Kanban task already has a host');
  }
  const invited = existing ?? (await context.projectMembers.inviteSessionMember(task.sessionId, templateId));
  let next = task;
  if (role === 'host' && task.hostMemberId !== invited.member.id) {
    next = assignTaskHostProjection(task, task.version, invited.member.id, new Date().toISOString());
    await store.saveTask(next, task.version, {
      type: 'task.host_assigned',
      taskId: task.id,
      memberId: invited.member.id
    });
  }
  return json({ task: await composeCard(context, next, await sessionState(context, next)) });
});

const removeTaskMember = route(async (request, context) => {
  const data = await body(request);
  const task = await taskFrom(data, new KanbanStore(context));
  const memberId = string(data.memberId, 'memberId');
  const members = await context.projectMembers.listSessionMembers(task.sessionId);
  const member = members.find((candidate) => candidate.member.id === memberId);
  if (!member) throw new Error(`member does not belong to Kanban task: ${memberId}`);
  const confirmation = await context.requestInteraction({
    type: 'confirm',
    title: 'Remove member?',
    description: `Remove ${member.member.displayName} from ${task.title}?`,
    confirmLabel: 'Remove'
  });
  if (confirmation.status !== 'submitted') return json({ deleted: false });
  const currentMembers = await context.projectMembers.listSessionMembers(task.sessionId);
  if (!currentMembers.some((candidate) => candidate.member.id === memberId)) {
    throw new Error(`session member not found: ${memberId}`);
  }
  await context.projectMembers.removeSessionMember(task.sessionId, memberId);
  let next = task;
  if (task.hostMemberId === memberId) {
    next = clearTaskHostProjection(task, task.version, memberId, new Date().toISOString());
    await new KanbanStore(context).saveTask(next, task.version, {
      type: 'task.host_cleared',
      taskId: task.id,
      memberId
    });
  }
  return json({ deleted: true, task: await composeCard(context, next, await sessionState(context, next)) });
});

const startTask = route(async (request, context) => {
  const data = await body(request);
  const store = new KanbanStore(context);
  const current = await taskFrom(data, store);
  const expectedVersion = number(data.expectedVersion, 'expectedVersion');
  const card = await composeCard(context, current, await sessionState(context, current));
  if (!card.host) throw new Error('task requires a host');
  if (!card.availableActions.start) throw new Error(`task cannot start from ${card.displayState}`);
  const run = await context.projectSessions.runTurn(current.sessionId, {
    text: stageDirective(current, card.host, card.members),
    idempotencyKey: `kanban:${current.id}:${current.stage}:${expectedVersion}`
  });
  const next = startTaskProjection(current, expectedVersion, run.runId, new Date().toISOString());
  await store.saveTask(next, current.version, { type: 'task.stage_started', taskId: current.id, runId: run.runId });
  return json({ task: await composeCard(context, next, await sessionState(context, next)) });
});

const moveTask = route(async (request, context) => {
  const data = await body(request);
  const store = new KanbanStore(context);
  const current = await taskFrom(data, store);
  const expectedVersion = number(data.expectedVersion, 'expectedVersion');
  const destination = oneOf(data.destination, 'destination', KANBAN_STAGES);
  const card = await composeCard(context, current, await sessionState(context, current));
  if (current.stage in KANBAN_DOCUMENTS && !card.documents[current.stage as KanbanDocumentStage]) {
    throw new Error(
      `stage requires host-maintained Markdown document: ${KANBAN_DOCUMENTS[current.stage as KanbanDocumentStage].name}`
    );
  }
  if (!card.availableActions.moveNext) throw new Error(`task cannot move from ${card.displayState}`);
  const next = moveTaskProjection(current, expectedVersion, destination, new Date().toISOString());
  await store.saveTask(next, current.version, { type: 'task.stage_moved', taskId: current.id, destination });
  return json({ task: await composeCard(context, next, await sessionState(context, next)) });
});

const getTaskPanel = route(async (request, context) => {
  const query = new URL(request.url).searchParams;
  const projectId = string(query.get('projectId'), 'projectId');
  const task = await new KanbanStore(context).findTask(string(query.get('taskId'), 'taskId'), projectId);
  const cursor = query.get('cursor') ?? undefined;
  const [messages, observations, approvals] = await Promise.all([
    context.projectSessions.listMessages(task.sessionId, cursor),
    context.projectSessions.listObservations(task.sessionId, cursor),
    context.projectSessions.listPendingApprovals(projectId, task.sessionId)
  ]);
  return json({
    messages: messages.items,
    observations: observations.items,
    approvals,
    nextCursor: messages.nextCursor ?? observations.nextCursor
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

const controlExecution = route(async (request, context) => {
  const data = await body(request);
  const action = oneOf(data.action, 'action', ['resolve-approval', 'pause', 'cancel'] as const);
  const task = await taskFrom(data, new KanbanStore(context));
  if (action === 'resolve-approval') {
    const approvalId = string(data.approvalId, 'approvalId');
    const pending = await context.projectSessions.listPendingApprovals(task.projectId, task.sessionId);
    if (!pending.some((approval) => approval.id === approvalId)) {
      throw new Error(`approval does not belong to Kanban task: ${approvalId}`);
    }
    const decision = oneOf(data.decision, 'decision', ['approved', 'denied'] as const);
    await context.projectSessions.resolveApproval(approvalId, decision);
  } else if (action === 'pause') {
    await context.projectSessions.pause(task.sessionId);
  } else {
    await context.projectSessions.cancel(task.sessionId);
  }
  return json({ ok: true });
});

export const kanbanApi: WorkplaceExperienceApi = {
  experienceId: 'kanban',
  routes: [
    { method: 'GET', path: '/tasks', handle: listTasks },
    { method: 'GET', path: '/member-templates', handle: listMemberTemplates },
    { method: 'POST', path: '/tasks/create', handle: createTask },
    { method: 'POST', path: '/tasks/members', handle: addTaskMember },
    { method: 'POST', path: '/tasks/members/remove', handle: removeTaskMember },
    { method: 'POST', path: '/tasks/start', handle: startTask },
    { method: 'POST', path: '/tasks/move', handle: moveTask },
    { method: 'GET', path: '/tasks/panel', handle: getTaskPanel },
    { method: 'POST', path: '/messages/send', handle: sendTaskMessage },
    { method: 'POST', path: '/execution/control', handle: controlExecution }
  ]
};
