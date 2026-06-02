import { z } from 'zod';

export const KANBAN_STAGES = ['product_design', 'tech_design', 'implementation', 'verify', 'completed'] as const;

const kanbanStageSchema = z.enum(KANBAN_STAGES);
export type KanbanStage = z.infer<typeof kanbanStageSchema>;

const kanbanTaskProjectionSchema = z.object({
  schemaVersion: z.literal(3),
  id: z.string().min(1),
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string().min(1),
  stage: kanbanStageSchema,
  hostMemberId: z.string().min(1).nullable(),
  stageRunId: z.string().min(1).nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type KanbanTaskProjection = z.infer<typeof kanbanTaskProjectionSchema>;

const storedProjectionBaseSchema = z.object({
  schemaVersion: z.number().int(),
  id: z.string().min(1),
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string().min(1),
  stage: z.string().min(1),
  stageRunId: z.string().min(1).nullable().optional(),
  version: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

const LEGACY_STAGE_MAP: Record<string, KanbanStage> = {
  requirements: 'product_design',
  execution: 'implementation',
  acceptance: 'verify',
  completed: 'completed'
};

function normalizeStage(stage: string): KanbanStage {
  const current = kanbanStageSchema.safeParse(stage);
  if (current.success) return current.data;
  const legacy = LEGACY_STAGE_MAP[stage];
  if (!legacy) throw new Error(`unknown legacy Kanban stage: ${stage}`);
  return legacy;
}

export function makeKanbanTaskProjection(
  input: Pick<KanbanTaskProjection, 'id' | 'projectId' | 'sessionId' | 'title'> &
    Partial<Pick<KanbanTaskProjection, 'stage' | 'hostMemberId' | 'stageRunId' | 'version' | 'createdAt' | 'updatedAt'>>
): KanbanTaskProjection {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return kanbanTaskProjectionSchema.parse({
    schemaVersion: 3,
    stage: 'product_design',
    hostMemberId: null,
    stageRunId: null,
    version: 0,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    ...input
  });
}

export function normalizeTaskProjection(value: unknown): KanbanTaskProjection {
  const current = kanbanTaskProjectionSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = storedProjectionBaseSchema.parse(value);
  return kanbanTaskProjectionSchema.parse({
    ...legacy,
    schemaVersion: 3,
    stage: normalizeStage(legacy.stage),
    hostMemberId: null,
    stageRunId: legacy.stageRunId ?? null
  });
}

export function nextKanbanStage(stage: KanbanStage): KanbanStage | null {
  const index = KANBAN_STAGES.indexOf(stage);
  return KANBAN_STAGES[index + 1] ?? null;
}

export function moveTaskProjection(
  task: KanbanTaskProjection,
  expectedVersion: number,
  destination: KanbanStage,
  now: string
): KanbanTaskProjection {
  if (task.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${task.version}`);
  }
  const next = nextKanbanStage(task.stage);
  if (!next) throw new Error('Completed is terminal');
  if (destination !== next) throw new Error(`only move to the next Kanban stage: ${next}`);
  return { ...task, stage: destination, stageRunId: null, version: task.version + 1, updatedAt: now };
}

export function startTaskProjection(
  task: KanbanTaskProjection,
  expectedVersion: number,
  runId: string,
  now: string
): KanbanTaskProjection {
  if (task.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${task.version}`);
  }
  if (task.stage === 'completed') throw new Error('Completed is terminal');
  return { ...task, stageRunId: runId, version: task.version + 1, updatedAt: now };
}

export function assignTaskHostProjection(
  task: KanbanTaskProjection,
  expectedVersion: number,
  hostMemberId: string,
  now: string
): KanbanTaskProjection {
  if (task.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${task.version}`);
  }
  if (task.hostMemberId && task.hostMemberId !== hostMemberId) throw new Error('Kanban task already has a host');
  if (task.hostMemberId === hostMemberId) return task;
  return { ...task, hostMemberId, version: task.version + 1, updatedAt: now };
}

export function clearTaskHostProjection(
  task: KanbanTaskProjection,
  expectedVersion: number,
  memberId: string,
  now: string
): KanbanTaskProjection {
  if (task.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${task.version}`);
  }
  if (task.hostMemberId !== memberId) return task;
  return { ...task, hostMemberId: null, version: task.version + 1, updatedAt: now };
}
