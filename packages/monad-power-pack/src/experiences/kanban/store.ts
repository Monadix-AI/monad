import type { WorkspaceExperienceApiContext } from '@monad/sdk-atom';

import { createHash } from 'node:crypto';

import { makeProjectTask, type ProjectTask } from './domain.ts';

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
  constructor(readonly context: WorkspaceExperienceApiContext) {}

  async getTask(projectId: string, taskId: string): Promise<ProjectTask | null> {
    const record = await this.context.experienceState.get<ProjectTask>(projectId, `task/${taskId}`);
    if (!record) return null;
    if (record.value.projectId !== projectId || record.value.id !== taskId || record.value.version !== record.version) {
      throw new Error(`corrupt Kanban task record: ${taskId}`);
    }
    return record.value;
  }

  async findTask(taskId: string, projectId: string): Promise<ProjectTask> {
    const task = await this.getTask(projectId, taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);
    return task;
  }

  async listTasks(projectId: string): Promise<ProjectTask[]> {
    const records = await this.context.experienceState.list<ProjectTask>(projectId, 'task/');
    return records
      .map((record) => record.value)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async createTask(input: { projectId: string; title: string; idempotencyKey: string }): Promise<ProjectTask> {
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
        idempotencyKey: `kanban:create:${taskId}`
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
    const task = makeProjectTask({
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

  async recoverProvisioning(projectId: string): Promise<ProjectTask[]> {
    const provisions = await this.context.experienceState.list<ProvisionRecord>(projectId, 'provision/');
    const recovered: ProjectTask[] = [];
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

  async saveTask(task: ProjectTask, expectedVersion: number, event: Record<string, unknown>): Promise<ProjectTask> {
    if (task.version !== expectedVersion + 1) {
      throw new Error(`version conflict: expected next ${expectedVersion + 1}, received ${task.version}`);
    }
    const current = await this.context.experienceState.get<ProjectTask>(task.projectId, `task/${task.id}`);
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
