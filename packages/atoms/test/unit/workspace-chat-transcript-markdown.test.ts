import type { Message } from '../../src/workplace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';

import { markdownTextWithMentionCapsules } from '../../src/workplace-experiences/chat-room/components/message-row.tsx';
import { resolveLocalFileReference } from '../../src/workplace-experiences/chat-room/utils/local-file-reference.ts';

const attachment = {
  id: 'att_100000000000',
  path: '/workspace/report.ts',
  name: 'report.ts',
  mime: 'application/typescript',
  bytes: 42,
  createdAt: '2026-07-18T00:00:00.000Z'
} as const;

const message = (text: string, overrides: Partial<Message> = {}): Message => ({
  id: 'msg_100000000000',
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
      message('Please sync with @[name="A" id="mesh-agent:pmem_codex_b8b9123ddd3d"] before shipping.').text
    )
  ).toBe('Please sync with [@A](#monad-mention-mesh-agent%3Apmem_codex_b8b9123ddd3d) before shipping.');
});

test('local file references resolve absolute paths, file URLs, encoding, and line fragments', () => {
  expect(resolveLocalFileReference('/workspace/report.ts#L12', [attachment])).toEqual({
    attachment,
    line: 12,
    path: '/workspace/report.ts'
  });
  expect(resolveLocalFileReference('file:///workspace/report.ts', [attachment])?.attachment).toEqual(attachment);
  expect(resolveLocalFileReference('file:///workspace/report%2Ets#not-a-line', [attachment])).toEqual({
    attachment,
    path: '/workspace/report.ts'
  });
});
