import type { SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { branchFromMessage } from '../../src/features/session/branch-from-message.ts';

test('branching from a user message navigates before continuing generation', async () => {
  const calls: string[] = [];
  const childId = 'ses_child0000000' as SessionId;

  await branchFromMessage({
    branch: async () => ({ sessionId: childId }),
    continueFromHistory: async (sessionId) => {
      calls.push(`continue:${sessionId}`);
    },
    messageId: 'msg_user00000000',
    onBranched: (sessionId) => calls.push(`navigate:${sessionId}`)
  });

  expect(calls).toEqual([`navigate:${childId}`, `continue:${childId}`]);
});
