import type { ExperienceWorker, ProjectExperienceEvent, WorkspaceExperienceApiContext } from '@monad/sdk-atom';
import type { ExecutionRun, ProjectTask } from './domain.ts';

import { parseEventPayload } from '@monad/protocol';

import { KanbanStore } from './store.ts';

const DEFAULT_CONCURRENCY = 3;
const EVENT_HISTORY_LIMIT = 200;

function withEvent(task: ProjectTask, eventId: string): string[] {
  return [...task.processedEventIds, eventId].slice(-EVENT_HISTORY_LIMIT);
}

function directive(task: ProjectTask): string {
  const proposal = task.proposals.at(-1);
  const criteria =
    proposal?.acceptanceCriteria.map((item) => `- ${item}`).join('\n') ?? '- Complete the requested work';
  return [
    `Execute Kanban task: ${task.title}`,
    proposal?.summary ?? task.title,
    'Acceptance criteria:',
    criteria,
    task.returnReason ? `Revision requested: ${task.returnReason}` : '',
    'Work autonomously: plan, implement, verify, and revise until the criteria are met.'
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function savePatch(
  store: KanbanStore,
  current: ProjectTask,
  patch: Partial<ProjectTask>,
  event: Record<string, unknown>
): Promise<ProjectTask> {
  const next = { ...current, ...patch, version: current.version + 1 };
  return store.saveTask(next, current.version, event);
}

export async function dispatchRunnableTasks(
  context: WorkspaceExperienceApiContext,
  projectId: string,
  options: { limit?: number; workerId?: string; now?: string } = {}
): Promise<ProjectTask[]> {
  const store = new KanbanStore(context);
  const now = options.now ?? new Date().toISOString();
  const workerId = options.workerId ?? `worker:${context.atomPackId}`;
  const limit = options.limit ?? DEFAULT_CONCURRENCY;
  const tasks = await store.listTasks(projectId);
  const active = tasks.filter(
    (task) => task.stage === 'execution' && ['running', 'waiting_approval'].includes(task.executionState)
  ).length;
  const capacity = Math.max(0, limit - active);
  const queued = tasks
    .filter((task) => task.stage === 'execution' && task.executionState === 'queued')
    .slice(0, capacity);
  const started: ProjectTask[] = [];

  for (const task of queued) {
    let leased: ProjectTask;
    try {
      leased = await savePatch(
        store,
        task,
        {
          executionState: 'running',
          lease: { workerId, expiresAt: new Date(new Date(now).getTime() + 60_000).toISOString() }
        },
        { type: 'execution.lease_acquired', taskId: task.id, workerId }
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('version conflict')) continue;
      throw error;
    }
    try {
      const iteration = leased.executionIteration + 1;
      const run = await context.projectSessions.runTurn(leased.sessionId, {
        text: directive(leased),
        idempotencyKey: `kanban:${leased.id}:${iteration}`
      });
      const running: ExecutionRun = {
        iteration,
        runId: run.runId,
        hostEventIds: [],
        status: 'running',
        artifactRefs: []
      };
      const persisted = await savePatch(
        store,
        leased,
        {
          executionIteration: iteration,
          runs: [...leased.runs, running],
          lease: undefined
        },
        { type: 'execution.started', taskId: leased.id, runId: run.runId, iteration }
      );
      started.push(persisted);
    } catch (error) {
      await savePatch(
        store,
        leased,
        { executionState: 'queued', lease: undefined },
        {
          type: 'execution.start_failed',
          taskId: leased.id,
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }
  return started;
}

async function taskForEvent(store: KanbanStore, event: ProjectExperienceEvent): Promise<ProjectTask | null> {
  return (await store.listTasks(event.projectId)).find((task) => task.sessionId === event.sessionId) ?? null;
}

async function recoverProject(context: WorkspaceExperienceApiContext, projectId: string): Promise<void> {
  const store = new KanbanStore(context);
  for (const task of await store.listTasks(projectId)) {
    if (task.stage !== 'execution') continue;
    if (task.executionState === 'running' || task.executionState === 'waiting_approval' || task.lease) {
      await savePatch(
        store,
        task,
        { executionState: 'queued', lease: undefined },
        { type: 'execution.recovered', taskId: task.id }
      );
    }
  }
}

export const kanbanWorker: ExperienceWorker = {
  experienceId: 'kanban',
  async onProjectStart(projectId, context) {
    await new KanbanStore(context).recoverProvisioning(projectId);
    await recoverProject(context, projectId);
    await dispatchRunnableTasks(context, projectId);
  },
  async onWake({ projectId }, context) {
    await dispatchRunnableTasks(context, projectId);
  },
  async onEvent(event, context) {
    const store = new KanbanStore(context);
    const current = await taskForEvent(store, event);
    if (!current || current.processedEventIds.includes(event.id)) return;

    if (event.type === 'tool.approval_requested' && current.stage === 'execution') {
      const runs = current.runs.map((run, index) =>
        index === current.runs.length - 1
          ? { ...run, status: 'waiting_approval' as const, hostEventIds: [...run.hostEventIds, event.id] }
          : run
      );
      await savePatch(
        store,
        current,
        { executionState: 'waiting_approval', runs, processedEventIds: withEvent(current, event.id) },
        { type: 'execution.waiting_approval', taskId: current.id, hostEventId: event.id }
      );
      return;
    }

    if (event.type === 'tool.approval_resolved' && current.stage === 'execution') {
      const pending = await context.projectSessions.listPendingApprovals(current.projectId, current.sessionId);
      const executionState = pending.length === 0 ? 'running' : 'waiting_approval';
      await savePatch(
        store,
        current,
        { executionState, processedEventIds: withEvent(current, event.id) },
        { type: 'execution.approval_resolved', taskId: current.id, hostEventId: event.id }
      );
      return;
    }

    if (event.type === 'session.message.failed' && current.stage === 'execution') {
      parseEventPayload('session.message.failed', event.payload);
      const runs = current.runs.map((run, index) =>
        index === current.runs.length - 1
          ? { ...run, status: 'failed' as const, hostEventIds: [...run.hostEventIds, event.id] }
          : run
      );
      await savePatch(
        store,
        current,
        { executionState: 'failed', runs, processedEventIds: withEvent(current, event.id) },
        { type: 'execution.failed', taskId: current.id, hostEventId: event.id }
      );
      return;
    }

    if (
      event.type === 'session.run.completed' &&
      current.stage === 'execution' &&
      (current.executionState === 'running' || current.executionState === 'waiting_approval')
    ) {
      const pending = await context.projectSessions.listPendingApprovals(current.projectId, current.sessionId);
      if (pending.length > 0) return;
      const fallback: ExecutionRun = {
        iteration: Math.max(1, current.executionIteration),
        runId: `event:${event.id}`,
        hostEventIds: [event.id],
        status: 'succeeded',
        artifactRefs: []
      };
      const runs = current.runs.length
        ? current.runs.map((run, index) =>
            index === current.runs.length - 1
              ? { ...run, status: 'succeeded' as const, hostEventIds: [...run.hostEventIds, event.id] }
              : run
          )
        : [fallback];
      const completedRun = runs.at(-1);
      if (!completedRun) throw new Error('completed execution requires a run');
      await savePatch(
        store,
        current,
        {
          stage: 'acceptance',
          executionState: 'succeeded',
          runs,
          acceptance: { runId: completedRun.runId, decision: 'pending', checklist: [] },
          processedEventIds: withEvent(current, event.id)
        },
        { type: 'execution.completed', taskId: current.id, hostEventId: event.id }
      );
      await context.workerScheduler.schedule(current.projectId, { key: 'dispatch', runAt: event.createdAt });
    }
  }
};
