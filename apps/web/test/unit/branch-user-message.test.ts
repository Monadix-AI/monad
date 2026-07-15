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
    onBranched: (sessionId) => calls.push(`navigate:${sessionId}`),
    role: 'user'
  });

  expect(calls).toEqual([`navigate:${childId}`, `continue:${childId}`]);
});

test('branching from an assistant message only navigates', async () => {
  const calls: string[] = [];
  const childId = 'ses_child0000000' as SessionId;

  await branchFromMessage({
    branch: async () => ({ sessionId: childId }),
    continueFromHistory: async () => {
      calls.push('continue');
    },
    messageId: 'msg_assistant0000',
    onBranched: (sessionId) => calls.push(`navigate:${sessionId}`),
    role: 'assistant'
  });

  expect(calls).toEqual([`navigate:${childId}`]);
});
