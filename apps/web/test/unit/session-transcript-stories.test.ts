import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

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
    'mesh-agent-login',
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

test('Chat Session stories map every transcript card kind exactly once', () => {
  const source = readFileSync(new URL('../../stories/session-transcript.stories.tsx', import.meta.url), 'utf8');
  const ids = [...source.matchAll(/data-story-case="([^"]+)"/g)].map((match) => match[1]);

  expect(ids).toEqual([...SESSION_TRANSCRIPT_STORY_CASES]);
});
