import type { WorkplaceExperienceApiContext } from '@monad/sdk-atom';

import { createHash } from 'node:crypto';

import { type KanbanTaskProjection, makeKanbanTaskProjection, normalizeTaskProjection } from './domain.ts';

interface ProvisionRecord {
  taskId: string;
  title: string;
  idempotencyKey: string;
  sessionId: string | null;
  complete: boolean;
}

function taskIdFor(projectId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${projectId}\0${idempotencyKey}`).digest('hex');
  return `task_${digest.slice(0, 20)}`;
}

export class KanbanStore {
  constructor(readonly context: WorkplaceExperienceApiContext) {}

  async getTask(projectId: string, taskId: string): Promise<KanbanTaskProjection | null> {
    const key = `task/${taskId}`;
    const record = await this.context.experienceState.get<unknown>(projectId, key);
    if (!record) return null;
    const task = normalizeTaskProjection(record.value);
    if (task.projectId !== projectId || task.id !== taskId || task.version !== record.version) {
      throw new Error(`corrupt Kanban task record: ${taskId}`);
    }
    if ((record.value as { schemaVersion?: unknown }).schemaVersion === 3) return task;
    const migrated = { ...task, version: task.version + 1 };
    const saved = await this.context.experienceState.compareAndSwap({
      projectId,
      key,
      expectedVersion: task.version,
      value: migrated,
      event: { type: 'task.projection_migrated', taskId }
    });
    if (!saved) throw new Error(`version conflict: expected ${task.version}`);
    return migrated;
  }

  async findTask(taskId: string, projectId: string): Promise<KanbanTaskProjection> {
    const task = await this.getTask(projectId, taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);
    return task;
  }

  async listTasks(projectId: string): Promise<KanbanTaskProjection[]> {
    const records = await this.context.experienceState.list<unknown>(projectId, 'task/');
    const tasks = await Promise.all(records.map((record) => this.getTask(projectId, record.key.slice('task/'.length))));
    return tasks
      .filter((task): task is KanbanTaskProjection => Boolean(task))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async createTask(input: { projectId: string; title: string; idempotencyKey: string }): Promise<KanbanTaskProjection> {
    const taskId = taskIdFor(input.projectId, input.idempotencyKey);
    const existing = await this.getTask(input.projectId, taskId);
    if (existing) return existing;

    const provisionKey = `provision/${taskId}`;
    let provision = await this.context.experienceState.get<ProvisionRecord>(input.projectId, provisionKey);
    if (!provision) {
      const value: ProvisionRecord = {
        taskId,
        title: input.title,
        idempotencyKey: input.idempotencyKey,
        sessionId: null,
        complete: false
      };
      await this.context.experienceState.compareAndSwap({
        projectId: input.projectId,
        key: provisionKey,
        expectedVersion: null,
        value,
        event: { type: 'task.provisioning_started', taskId }
      });
      provision = await this.context.experienceState.get<ProvisionRecord>(input.projectId, provisionKey);
    }
    if (!provision) throw new Error(`failed to create Kanban provisioning record: ${taskId}`);

    let { sessionId } = provision.value;
    if (!sessionId) {
      const created = await this.context.projectSessions.create(input.projectId, {
        title: input.title,
        idempotencyKey: `kanban:create:${taskId}`,
        memberPolicy: 'empty'
      });
      const bound: ProvisionRecord = { ...provision.value, sessionId: created.id };
      await this.context.experienceState.compareAndSwap({
        projectId: input.projectId,
        key: provisionKey,
        expectedVersion: provision.version,
        value: bound,
        event: { type: 'task.session_bound', taskId, sessionId: created.id }
      });
      provision = await this.context.experienceState.get<ProvisionRecord>(input.projectId, provisionKey);
      sessionId = provision?.value.sessionId ?? created.id;
    }

    const now = new Date().toISOString();
    const task = makeKanbanTaskProjection({
      id: taskId,
      projectId: input.projectId,
      sessionId,
      title: input.title,
      createdAt: now,
      updatedAt: now
    });
    const createdTask = await this.context.experienceState.compareAndSwap({
      projectId: input.projectId,
      key: `task/${taskId}`,
      expectedVersion: null,
      value: task,
      event: { type: 'task.created', taskId, sessionId }
    });
    const persisted = createdTask ? task : await this.getTask(input.projectId, taskId);
    if (!persisted) throw new Error(`failed to persist Kanban task: ${taskId}`);

    const latestProvision = await this.context.experienceState.get<ProvisionRecord>(input.projectId, provisionKey);
    if (latestProvision && !latestProvision.value.complete) {
      await this.context.experienceState.compareAndSwap({
        projectId: input.projectId,
        key: provisionKey,
        expectedVersion: latestProvision.version,
        value: { ...latestProvision.value, complete: true },
        event: { type: 'task.provisioning_completed', taskId }
      });
    }
    return persisted;
  }

  async recoverProvisioning(projectId: string): Promise<KanbanTaskProjection[]> {
    const provisions = await this.context.experienceState.list<ProvisionRecord>(projectId, 'provision/');
    const recovered: KanbanTaskProjection[] = [];
    for (const provision of provisions) {
      if (provision.value.complete) continue;
      recovered.push(
        await this.createTask({
          projectId,
          title: provision.value.title,
          idempotencyKey: provision.value.idempotencyKey
        })
      );
    }
    return recovered;
  }

  async removeTasksForSession(projectId: string, sessionId: string): Promise<void> {
    const [tasks, provisions] = await Promise.all([
      this.listTasks(projectId),
      this.context.experienceState.list<ProvisionRecord>(projectId, 'provision/')
    ]);
    await Promise.all([
      ...tasks
        .filter((task) => task.sessionId === sessionId)
        .map((task) =>
          this.context.experienceState.compareAndDelete({
            projectId,
            key: `task/${task.id}`,
            expectedVersion: task.version,
            event: { type: 'task.session_deleted', taskId: task.id, sessionId }
          })
        ),
      ...provisions
        .filter((provision) => provision.value.sessionId === sessionId)
        .map((provision) =>
          this.context.experienceState.compareAndDelete({
            projectId,
            key: provision.key,
            expectedVersion: provision.version,
            event: { type: 'task.provision_removed', taskId: provision.value.taskId, sessionId }
          })
        )
    ]);
  }

  async reconcileTasks(projectId: string, sessions: readonly { id: string }[]): Promise<KanbanTaskProjection[]> {
    const tasks = await this.listTasks(projectId);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const orphanSessionIds = new Set(
      tasks.filter((task) => !sessionIds.has(task.sessionId)).map((task) => task.sessionId)
    );
    await Promise.all([...orphanSessionIds].map((sessionId) => this.removeTasksForSession(projectId, sessionId)));
    return tasks.filter((task) => sessionIds.has(task.sessionId));
  }

  async saveTask(
    task: KanbanTaskProjection,
    expectedVersion: number,
    event: Record<string, unknown>
  ): Promise<KanbanTaskProjection> {
    if (task.version !== expectedVersion + 1) {
      throw new Error(`version conflict: expected next ${expectedVersion + 1}, received ${task.version}`);
    }
    const current = await this.context.experienceState.get<KanbanTaskProjection>(task.projectId, `task/${task.id}`);
    if (!current || current.version !== expectedVersion || current.value.version !== expectedVersion) {
      throw new Error(`version conflict: expected ${expectedVersion}`);
    }
    const saved = await this.context.experienceState.compareAndSwap({
      projectId: task.projectId,
      key: `task/${task.id}`,
      expectedVersion,
      value: task,
      event
    });
    if (!saved) throw new Error(`version conflict: expected ${expectedVersion}`);
    return task;
  }
}
