export type KanbanStage = 'requirements' | 'execution' | 'acceptance' | 'completed' | 'cancelled' | 'failed';
export type RequirementsState = 'discussing' | 'proposal_awaiting_approval' | 'proposal_approved';
export type ExecutionState = 'idle' | 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed';

export interface ProposalRevision {
  revision: number;
  summary: string;
  acceptanceCriteria: string[];
  createdAt: string;
}

export interface ExecutionRun {
  iteration: number;
  runId: string;
  hostEventIds: string[];
  status: 'running' | 'waiting_approval' | 'succeeded' | 'failed';
  artifactRefs: Array<{ kind: string; uri: string; label: string }>;
}

export interface AcceptanceReview {
  runId: string;
  decision: 'pending' | 'accepted' | 'returned';
  checklist: Array<{ criterion: string; passed: boolean; evidenceRef?: string }>;
  reason?: string;
  reviewedAt?: string;
}

export interface ProjectTask {
  schemaVersion: 1;
  id: string;
  projectId: string;
  sessionId: string;
  title: string;
  stage: KanbanStage;
  requirementsState: RequirementsState;
  executionState: ExecutionState;
  version: number;
  proposalRevision: number;
  executionIteration: number;
  proposals: ProposalRevision[];
  runs: ExecutionRun[];
  acceptance: AcceptanceReview | null;
  processedEventIds: string[];
  returnReason?: string;
  lease?: { workerId: string; expiresAt: string };
  createdAt: string;
  updatedAt: string;
}

export function makeProjectTask(
  input: Pick<ProjectTask, 'id' | 'projectId' | 'sessionId' | 'title'> & Partial<ProjectTask>
): ProjectTask {
  const now = input.createdAt ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    stage: 'requirements',
    requirementsState: 'discussing',
    executionState: 'idle',
    version: 0,
    proposalRevision: 0,
    executionIteration: 0,
    proposals: [],
    runs: [],
    acceptance: null,
    processedEventIds: [],
    createdAt: now,
    updatedAt: input.updatedAt ?? now,
    ...input
  };
}

function expectVersion(task: ProjectTask, expectedVersion: number): void {
  if (task.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${task.version}`);
  }
}

export function submitProposal(
  task: ProjectTask,
  expectedVersion: number,
  proposal: { summary: string; acceptanceCriteria: string[] },
  now: string
): ProjectTask {
  expectVersion(task, expectedVersion);
  if (task.stage !== 'requirements') throw new Error(`proposal cannot be submitted from ${task.stage}`);
  const revision = task.proposalRevision + 1;
  return {
    ...task,
    requirementsState: 'proposal_awaiting_approval',
    proposalRevision: revision,
    proposals: [...task.proposals, { revision, ...proposal, createdAt: now }],
    version: task.version + 1,
    updatedAt: now
  };
}

export function approveProposal(task: ProjectTask, expectedVersion: number, now: string): ProjectTask {
  expectVersion(task, expectedVersion);
  if (task.stage !== 'requirements' || task.requirementsState !== 'proposal_awaiting_approval') {
    throw new Error('proposal is not awaiting approval');
  }
  return {
    ...task,
    stage: 'execution',
    requirementsState: 'proposal_approved',
    executionState: 'queued',
    version: task.version + 1,
    updatedAt: now
  };
}

export function rejectProposal(task: ProjectTask, expectedVersion: number, now: string): ProjectTask {
  expectVersion(task, expectedVersion);
  if (task.stage !== 'requirements') throw new Error(`proposal cannot be rejected from ${task.stage}`);
  return {
    ...task,
    requirementsState: 'discussing',
    version: task.version + 1,
    updatedAt: now
  };
}

export function returnForRevision(
  task: ProjectTask,
  expectedVersion: number,
  reason: string,
  now: string
): ProjectTask {
  expectVersion(task, expectedVersion);
  if (task.stage !== 'acceptance') throw new Error('task is not awaiting acceptance');
  const run = task.runs.at(-1);
  return {
    ...task,
    stage: 'execution',
    executionState: 'queued',
    acceptance: run
      ? { runId: run.runId, decision: 'returned', checklist: [], reason, reviewedAt: now }
      : task.acceptance,
    returnReason: reason,
    version: task.version + 1,
    updatedAt: now
  };
}

export function acceptTask(task: ProjectTask, expectedVersion: number, now: string): ProjectTask {
  expectVersion(task, expectedVersion);
  if (task.stage !== 'acceptance') throw new Error('task is not awaiting acceptance');
  const run = task.runs.at(-1);
  if (!run) throw new Error('acceptance requires an execution run');
  return {
    ...task,
    stage: 'completed',
    acceptance: { runId: run.runId, decision: 'accepted', checklist: [], reviewedAt: now },
    version: task.version + 1,
    updatedAt: now
  };
}
