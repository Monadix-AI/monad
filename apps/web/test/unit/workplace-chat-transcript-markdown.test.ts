import type { Message } from '../../features/workplace/types.ts';

import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageBubbleContent } from '../../features/workplace/activity/ChatTranscript.tsx';

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

test('agent message bubbles render markdown content', () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageBubbleContent, {
      agent: true,
      hasText: true,
      msg: message('Ship **markdown** and `code`.')
    })
  );

  expect(html).toContain('data-streamdown="strong">markdown</span>');
  expect(html).toContain('data-streamdown="inline-code">code</code>');
});

test('agent message bubbles render strict mention tokens as capsules', () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageBubbleContent, {
      agent: true,
      hasText: true,
      msg: message('Please sync with @[name="A" id="native-cli:pmem_codex_b8b9123ddd3d"] before shipping.')
    })
  );

  expect(html).toContain('title="native-cli:pmem_codex_b8b9123ddd3d"');
  expect(html).toContain('@A</span>');
  expect(html).not.toContain('@[name=&quot;A&quot;');
  expect(html).not.toContain('data-streamdown="paragraph"');
});
