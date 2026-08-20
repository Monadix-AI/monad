import { z } from 'zod';

import { definedOnly } from './defaults.ts';

export const RESEARCH_ASSIGNMENT_ROLES = ['researcher', 'evidence-engineer'] as const;
export const RESEARCH_ASSIGNMENT_STATES = ['queued', 'running', 'blocked', 'completed', 'failed'] as const;

const researchAssignmentRoleSchema = z.enum(RESEARCH_ASSIGNMENT_ROLES);
const researchAssignmentStateSchema = z.enum(RESEARCH_ASSIGNMENT_STATES);

export const researchContextReceiptSchema = z.object({
  brief: z.string().min(1),
  sourceIds: z.array(z.string().min(1)),
  claimIds: z.array(z.string().min(1)),
  blockIds: z.array(z.string().min(1))
});

export const researchAssignmentSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  role: researchAssignmentRoleSchema,
  state: researchAssignmentStateSchema,
  targetClaimId: z.string().min(1).nullable(),
  targetBlockId: z.string().min(1).nullable(),
  sessionId: z.string().min(1),
  memberId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  objective: z.string().min(1),
  contextReceipt: researchContextReceiptSchema,
  version: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  completedAt: z.string().min(1).nullable(),
  errorReason: z.string().min(1).nullable()
});

export type ResearchAssignmentRole = z.infer<typeof researchAssignmentRoleSchema>;
export type ResearchAssignmentState = z.infer<typeof researchAssignmentStateSchema>;
export type ResearchContextReceipt = z.infer<typeof researchContextReceiptSchema>;
export type ResearchAssignment = z.infer<typeof researchAssignmentSchema>;

export function makeResearchAssignment(
  input: Pick<
    ResearchAssignment,
    'id' | 'projectId' | 'role' | 'sessionId' | 'memberId' | 'objective' | 'contextReceipt'
  > &
    Partial<
      Omit<
        ResearchAssignment,
        'schemaVersion' | 'id' | 'projectId' | 'role' | 'sessionId' | 'memberId' | 'objective' | 'contextReceipt'
      >
    >
): ResearchAssignment {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return researchAssignmentSchema.parse({
    schemaVersion: 1,
    state: 'queued',
    targetClaimId: null,
    targetBlockId: null,
    runId: null,
    version: 0,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    completedAt: null,
    errorReason: null,
    ...definedOnly(input)
  });
}

export function normalizeResearchAssignment(value: unknown): ResearchAssignment {
  return researchAssignmentSchema.parse(value);
}

export function transitionResearchAssignment(
  assignment: ResearchAssignment,
  expectedVersion: number,
  state: ResearchAssignmentState,
  now: string,
  patch: { runId?: string; errorReason?: string } = {}
): ResearchAssignment {
  if (assignment.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${assignment.version}`);
  }
  if (assignment.state === state) return assignment;
  if (assignment.state === 'completed' || assignment.state === 'failed') {
    throw new Error(`a ${assignment.state} assignment is terminal`);
  }
  const runId = patch.runId?.trim() || assignment.runId;
  if (state === 'running' && !runId) throw new Error('a running assignment requires a run id');
  const errorReason = patch.errorReason?.trim() || null;
  if (state === 'failed' && !errorReason) throw new Error('a failed assignment requires an error reason');
  return {
    ...assignment,
    state,
    runId,
    version: assignment.version + 1,
    updatedAt: now,
    completedAt: state === 'completed' ? now : null,
    errorReason: state === 'failed' ? errorReason : null
  };
}
