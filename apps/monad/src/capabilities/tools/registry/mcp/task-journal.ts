import { chmod, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '@monad/logger';
import { z } from 'zod';

const log = createLogger('mcp-task-journal');
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_TASKS = 512;
const taskStateSchema = z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']);

const persistedMcpTaskSchema = z.object({
  server: z.string(),
  taskId: z.string(),
  toolName: z.string(),
  sessionId: z.string().optional(),
  toolCallId: z.string().optional(),
  status: taskStateSchema,
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  observedAt: z.string(),
  ttlMs: z.number().int().nonnegative().nullable().optional(),
  expiresAt: z.string().optional(),
  inputRequests: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  recoveredAt: z.string().optional(),
  deliveryPending: z.boolean().optional(),
  cancelRequestedAt: z.string().optional()
});

const journalSchema = z.object({
  version: z.literal(1),
  tasks: z.array(persistedMcpTaskSchema)
});

export type PersistedMcpTask = z.infer<typeof persistedMcpTaskSchema>;

export class McpTaskJournal {
  private operation = Promise.resolve();

  constructor(private readonly path: string) {}

  list(): Promise<PersistedMcpTask[]> {
    return this.enqueue(async () => {
      const journal = await this.read();
      const tasks = retainedTasks(journal.tasks);
      if (tasks.length !== journal.tasks.length) await this.write({ ...journal, tasks });
      return tasks;
    });
  }

  upsert(task: PersistedMcpTask): Promise<void> {
    return this.enqueue(async () => {
      const journal = await this.read();
      const index = journal.tasks.findIndex((existing) => existing.taskId === task.taskId);
      if (index >= 0) journal.tasks[index] = task;
      else journal.tasks.push(task);
      journal.tasks = retainedTasks(journal.tasks);
      await this.write(journal);
    });
  }

  markCancelRequested(taskId: string): Promise<void> {
    return this.enqueue(async () => {
      const journal = await this.read();
      const task = journal.tasks.find((entry) => entry.taskId === taskId);
      if (!task) return;
      task.cancelRequestedAt = new Date().toISOString();
      task.observedAt = task.cancelRequestedAt;
      await this.write(journal);
    });
  }

  pendingDeliveries(): Promise<PersistedMcpTask[]> {
    return this.list().then((tasks) => tasks.filter((task) => task.deliveryPending));
  }

  acknowledgeDelivery(taskId: string, recoveredAt: string): Promise<boolean> {
    return this.enqueue(async () => {
      const journal = await this.read();
      const task = journal.tasks.find((entry) => entry.taskId === taskId);
      if (!task?.deliveryPending || task.recoveredAt !== recoveredAt) return false;
      task.deliveryPending = false;
      task.observedAt = new Date().toISOString();
      await this.write(journal);
      return true;
    });
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.operation.then(run, run);
    this.operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async read(): Promise<z.infer<typeof journalSchema>> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return { version: 1, tasks: [] };
    try {
      if (file.size > MAX_JOURNAL_BYTES) throw new Error(`journal exceeds ${MAX_JOURNAL_BYTES} bytes`);
      return journalSchema.parse(await file.json());
    } catch (error) {
      const quarantine = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, quarantine).catch(() => {});
      log.warn(
        { err: error instanceof Error ? error.message : String(error), path: this.path, quarantine },
        'invalid MCP task journal quarantined'
      );
      return { version: 1, tasks: [] };
    }
  }

  private async write(journal: z.infer<typeof journalSchema>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    const bounded = boundedJournal({ ...journal, tasks: retainedTasks(journal.tasks) });
    await Bun.write(temporary, `${JSON.stringify(bounded)}\n`);
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

function boundedJournal(journal: z.infer<typeof journalSchema>): z.infer<typeof journalSchema> {
  const tasks = [...journal.tasks]
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .slice(0, MAX_JOURNAL_TASKS);
  while (tasks.length > 1 && Buffer.byteLength(JSON.stringify({ ...journal, tasks })) > MAX_JOURNAL_BYTES) {
    const terminal = tasks.findLastIndex((task) => ['completed', 'failed', 'cancelled'].includes(task.status));
    tasks.splice(terminal >= 0 ? terminal : tasks.length - 1, 1);
  }
  return { ...journal, tasks };
}

function retainedTasks(tasks: PersistedMcpTask[]): PersistedMcpTask[] {
  const now = Date.now();
  const retentionCutoff = now - 7 * 24 * 60 * 60_000;
  return tasks.filter((entry) => {
    const terminal = ['completed', 'failed', 'cancelled'].includes(entry.status);
    if (terminal && Date.parse(entry.observedAt) < retentionCutoff) return false;
    return true;
  });
}
