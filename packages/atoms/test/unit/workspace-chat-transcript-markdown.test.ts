import type { Message } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  markdownTextWithMentionCapsules,
  messageMarkdownComponents
} from '../../src/workspace-experiences/chat-room/components/message-row.tsx';

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
      message('Please sync with @[name="A" id="external-agent:pmem_codex_b8b9123ddd3d"] before shipping.').text
    )
  ).toBe('Please sync with [@A](#monad-mention-external-agent%3Apmem_codex_b8b9123ddd3d) before shipping.');
});

function renderWorkspaceMarkdownAnchor(href: string, label: string): string {
  const Anchor = messageMarkdownComponents.a;
  if (!Anchor) throw new Error('Expected workspace message anchor renderer');
  return renderToStaticMarkup(createElement(Anchor, { href }, label));
}

test('workspace Markdown keeps mention capsules and adds favicons to web links', () => {
  const mention = renderWorkspaceMarkdownAnchor('#monad-mention-external-agent%3Acodex', '@codex');
  const web = renderWorkspaceMarkdownAnchor('https://example.com/docs', 'Example');

  expect(mention).toContain('data-composer-chip="mention"');
  expect(mention).not.toContain('favicon.ico');
  expect(web).toContain('src="https://example.com/favicon.ico"');
  expect(web).toContain('href="https://example.com/docs"');
});
