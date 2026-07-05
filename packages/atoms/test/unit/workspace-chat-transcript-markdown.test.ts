import type { Message } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';

import { markdownTextWithMentionCapsules } from '../../src/workspace-experiences/chat-room/components/message-row.tsx';

const message = (text: string, overrides: Partial<Message> = {}): Message => ({
  id: 'msg_1',
  authorId: 'agent_1',
  authorName: 'Agent',
  av: 'AG',
  kind: 'agent',
  tag: 'AI',
  time: '',
  text,
  ...overrides
});

test('agent message bubbles pass markdown source through unchanged when no strict mentions are present', () => {
  expect(markdownTextWithMentionCapsules(message('Ship **markdown** and `code`.').text)).toBe(
    'Ship **markdown** and `code`.'
  );
});

test('agent message bubbles rewrite strict mention tokens before markdown rendering', () => {
  expect(
    markdownTextWithMentionCapsules(
      message('Please sync with @[name="A" id="native-cli:pmem_codex_b8b9123ddd3d"] before shipping.').text
    )
  ).toBe('Please sync with [@A](#monad-mention-native-cli%3Apmem_codex_b8b9123ddd3d) before shipping.');
});
