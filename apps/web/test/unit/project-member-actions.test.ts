import { expect, test } from 'bun:test';

import {
  defaultMeshAgentMemberDisplayName,
  projectApprovalResolution
} from '../../src/features/workplace/use-project-actions';

test('discovered MeshAgent member defaults to its raw display name', () => {
  expect(
    defaultMeshAgentMemberDisplayName({
      name: 'openclaw--test',
      displayName: 'test',
      provider: 'openclaw',
      productIcon: 'openclaw'
    })
  ).toBe('test');
});

test('Monad Agent member defaults to its configured Agent name', () => {
  expect(
    defaultMeshAgentMemberDisplayName({
      name: 'monad--agt_000000000000',
      displayName: 'Reviewer',
      provider: 'monad',
      productIcon: 'monad'
    })
  ).toBe('Reviewer');
});

test('project approvals preserve the selected approval scope through resolution', () => {
  expect([
    projectApprovalResolution('approve-once'),
    projectApprovalResolution('approve-session'),
    projectApprovalResolution('approve-always'),
    projectApprovalResolution('reject')
  ]).toEqual([
    { allow: true, scope: 'once' },
    { allow: true, scope: 'session' },
    { allow: true, scope: 'global' },
    { allow: false, scope: 'once', reason: 'denied by operator' }
  ]);
});
