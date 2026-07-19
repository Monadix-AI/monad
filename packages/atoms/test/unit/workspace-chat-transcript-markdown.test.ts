import type { Message } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createMessageMarkdownComponents,
  markdownTextWithMentionCapsules,
  messageMarkdownComponents
} from '../../src/workspace-experiences/chat-room/components/message-row.tsx';
import { resolveLocalFileReference } from '../../src/workspace-experiences/chat-room/utils/local-file-reference.ts';

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

function renderWorkspaceMarkdownAnchor(href: string, label: string): string {
  const Anchor = messageMarkdownComponents.a;
  if (!Anchor) throw new Error('Expected workspace message anchor renderer');
  return renderToStaticMarkup(createElement(Anchor, { href }, label));
}

test('workspace Markdown keeps mention capsules and adds favicons to web links', () => {
  const mention = renderWorkspaceMarkdownAnchor('#monad-mention-mesh-agent%3Acodex', '@codex');
  const web = renderWorkspaceMarkdownAnchor('https://example.com/docs', 'Example');

  expect(mention).toContain('data-composer-chip="mention"');
  expect(mention).not.toContain('favicon.ico');
  expect(web).toContain('src="https://example.com/favicon.ico"');
  expect(web).toContain('href="https://example.com/docs"');
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

test('monad:file Markdown renders a non-navigating file control', () => {
  const opened: Array<{ id: string; line?: number }> = [];
  const Anchor = createMessageMarkdownComponents({
    attachments: [attachment],
    onOpenAttachment: (matched, line) => opened.push({ id: matched.id, line })
  }).a;
  if (!Anchor) throw new Error('Expected workspace message anchor renderer');

  const markup = renderToStaticMarkup(
    createElement(Anchor, { href: '/workspace/report.ts#L12', title: 'monad:file' }, 'report.ts')
  );

  expect(markup).toContain('data-inline-link="file"');
  expect(markup).toContain('data-file-icon="code"');
  expect(markup).toContain('type="button"');
  expect(markup).not.toContain('href=');
  expect(opened).toEqual([]);
});

test('unmatched monad:file Markdown is disabled and cannot navigate', () => {
  const Anchor = createMessageMarkdownComponents({ attachments: [], onOpenAttachment: () => {} }).a;
  if (!Anchor) throw new Error('Expected workspace message anchor renderer');

  const markup = renderToStaticMarkup(
    createElement(Anchor, { href: '/workspace/missing.ts', title: 'monad:file' }, 'missing.ts')
  );

  expect(markup).toContain('aria-disabled="true"');
  expect(markup).toContain('disabled=""');
  expect(markup).toContain('data-inline-link="file"');
  expect(markup).not.toContain('href=');
  expect(markup).toContain('type="button"');
});
