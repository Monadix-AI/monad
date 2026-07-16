import type { SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { branchFromMessage } from '../../src/features/session/branch-from-message.ts';
import { Message } from '../../src/features/session/ChatMessage.tsx';

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

test('branch action is rendered only for settled user messages', () => {
  const userMarkup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: { id: 'msg_user_branch', role: 'user', text: 'Try a different direction' },
      onBranch: () => {}
    })
  );
  const assistantMarkup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: { id: 'msg_assistant_branch', role: 'assistant', text: 'Response' },
      onBranch: () => {}
    })
  );

  expect(userMarkup).toContain('Branch from here');
  expect(assistantMarkup).not.toContain('Branch from here');
});
