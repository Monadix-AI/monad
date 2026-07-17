import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { CHAT_EXPERIENCE_STORY_CASES } from '../../stories/chat-card-story-cases';

test('Chat Experience story catalog covers every transcript card kind', () => {
  expect(CHAT_EXPERIENCE_STORY_CASES).toEqual([
    'human-message',
    'agent-message',
    'system-event',
    'developer-event',
    'attachment',
    'observation-user',
    'observation-agent',
    'observation-tool',
    'observation-system',
    'command',
    'file-read',
    'generic-tool-pair',
    'readonly-approval',
    'raw-jsonl',
    'complete-chat-experience'
  ]);
});

test('Chat Experience stories map every card kind exactly once', () => {
  const source = readFileSync(new URL('../../stories/chat-cards.stories.tsx', import.meta.url), 'utf8');
  const ids = [...source.matchAll(/data-story-case="([^"]+)"/g)].map((match) => match[1]);

  expect(ids).toEqual([...CHAT_EXPERIENCE_STORY_CASES]);
});
