import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CHAT_EXPERIENCE_STORY_CASES } from '../../stories/chat-card-story-cases';
import { ShellExample } from '../../stories/chat-card-story-fixtures.tsx';

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
    'shell',
    'file-read',
    'generic-tool-pair',
    'readonly-approval',
    'raw-jsonl',
    'complete-chat-experience'
  ]);
});

test('Shell card stories render running, completed, and failed outcomes', () => {
  expect(
    (['running', 'completed', 'failed'] as const).map((status) => {
      const markup = renderToStaticMarkup(createElement(ShellExample, { status }));
      return {
        completedOutput: markup.includes('2 pass') && markup.includes('0 fail'),
        failedOutput: markup.includes('1 fail') && markup.includes('AssertionError'),
        failedSurface: markup.includes('border-destructive/45'),
        running: markup.includes('running') && !markup.includes('data-shell-copy-target="output"'),
        shellCard: markup.includes('data-slot="shell-tool-card"')
      };
    })
  ).toEqual([
    {
      completedOutput: false,
      failedOutput: false,
      failedSurface: false,
      running: true,
      shellCard: true
    },
    {
      completedOutput: true,
      failedOutput: false,
      failedSurface: false,
      running: false,
      shellCard: true
    },
    {
      completedOutput: false,
      failedOutput: true,
      failedSurface: true,
      running: false,
      shellCard: true
    }
  ]);
});
