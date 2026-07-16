import { expect, test } from 'bun:test';

import { persistProjectMemberAndInvite } from '../../src/features/workplace/use-project-actions';

test('adding a project member also invites it into the active session after persistence', async () => {
  const calls: unknown[] = [];

  await persistProjectMemberAndInvite({
    activeSessionId: 'ses_active',
    memberId: 'pmem_reviewer',
    persist: async () => calls.push('persisted'),
    invite: async (args) => calls.push(args)
  });

  expect(calls).toEqual(['persisted', { sessionId: 'ses_active', templateId: 'pmem_reviewer' }]);
});
