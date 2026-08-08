import { expect, test } from 'bun:test';

import { projectApprovalResolution } from '../../src/features/workplace/use-project-actions';

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
