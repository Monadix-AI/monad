import { expect, test } from 'bun:test';

import {
  approveProposal,
  makeProjectTask,
  returnForRevision,
  submitProposal
} from '../../src/experiences/kanban/domain.ts';

test('proposal approval queues execution', () => {
  const task = submitProposal(
    makeProjectTask({ id: 'task-a', projectId: 'prj_a', sessionId: 'ses_a', title: 'A' }),
    0,
    { summary: 'Ship A', acceptanceCriteria: ['tests pass'] },
    '2026-07-14T00:00:00.000Z'
  );

  expect(approveProposal(task, 1, '2026-07-14T00:01:00.000Z')).toMatchObject({
    stage: 'execution',
    executionState: 'queued',
    proposalRevision: 1,
    version: 2
  });
});

test('acceptance return keeps evidence and requeues execution', () => {
  const task = makeProjectTask({
    id: 'task-a',
    projectId: 'prj_a',
    sessionId: 'ses_a',
    title: 'A',
    stage: 'acceptance',
    executionState: 'succeeded',
    version: 4,
    runs: [
      {
        iteration: 1,
        runId: 'run-a',
        hostEventIds: ['evt-a'],
        status: 'succeeded',
        artifactRefs: [{ kind: 'file', uri: 'file:///tmp/a', label: 'A' }]
      }
    ]
  });

  const returned = returnForRevision(task, 4, 'missing regression case', '2026-07-14T00:02:00.000Z');

  expect(returned).toMatchObject({
    stage: 'execution',
    executionState: 'queued',
    returnReason: 'missing regression case',
    version: 5
  });
  expect(returned.runs).toEqual(task.runs);
});

test('stale expected versions are rejected', () => {
  const task = makeProjectTask({ id: 'task-a', projectId: 'prj_a', sessionId: 'ses_a', title: 'A', version: 3 });

  expect(() =>
    submitProposal(task, 2, { summary: 'stale', acceptanceCriteria: [] }, '2026-07-14T00:00:00.000Z')
  ).toThrow('version conflict');
});
