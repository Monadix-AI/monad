import { expect, test } from 'bun:test';

import { SESSION_TRANSCRIPT_STORY_CASES } from '../../stories/session-transcript-story-cases';

test('Chat Session story catalog covers every transcript card kind', () => {
  expect(SESSION_TRANSCRIPT_STORY_CASES).toEqual([
    'user-message',
    'assistant-message',
    'reasoning',
    'directive',
    'single-tool',
    'parallel-tools',
    'skill-tool',
    'external-agent-login',
    'memory-summary',
    'compact',
    'branch-restore',
    'summary-turn',
    'generic-approval',
    'resource-approval',
    'clarification',
    'complete-chat-session'
  ]);
});
