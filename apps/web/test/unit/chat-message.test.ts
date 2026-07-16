import { expect, test } from 'bun:test';
import { renderComposerInlineChip } from '@monad/ui/components/ComposerInlineChip';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import * as ChatMessageModule from '../../src/features/session/ChatMessage.tsx';
import { Message, shouldRenderDirectiveAsMarkdown } from '../../src/features/session/ChatMessage.tsx';
import { MessageBody, userMessageTokens } from '../../src/features/session/MessageBody.tsx';

test('help directive replies render through markdown instead of the compact directive divider', () => {
  expect(
    shouldRenderDirectiveAsMarkdown({
      role: 'assistant',
      type: 'directive',
      data: { effect: { type: 'help', commands: [] } }
    })
  ).toBe(true);

  expect(
    shouldRenderDirectiveAsMarkdown({
      role: 'assistant',
      type: 'directive',
      data: { effect: { type: 'history-reset' } }
    })
  ).toBe(false);

  expect(
    shouldRenderDirectiveAsMarkdown({
      role: 'user',
      type: 'directive',
      data: { effect: { type: 'help', commands: [] } }
    })
  ).toBe(false);
});

test('reasoning is collapsed by default while the assistant message is streaming', () => {
  const markup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: {
        id: 'msg_reasoning',
        reasoning: 'Internal reasoning details',
        role: 'assistant',
        streaming: true,
        text: ''
      }
    })
  );

  expect(markup).toContain('data-state="closed"');
  expect(markup).not.toContain('Internal reasoning details');
});

test('reasoning trigger marks itself as the viewport anchor for user toggles', () => {
  const markup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: {
        id: 'msg_reasoning_anchor',
        reasoning: 'Internal reasoning details',
        role: 'assistant',
        streaming: false,
        text: ''
      }
    })
  );

  expect(markup).toContain('data-virtual-list-anchor="true"');
});

test('pending assistant activity renders the agent label with shimmer state', () => {
  const markup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Default Dev Agent',
      msg: {
        id: 'local-assistant-pending',
        pending: true,
        role: 'assistant',
        text: ''
      }
    })
  );

  expect(markup).toContain('Default Dev Agent');
  expect(markup).toContain('agent-name-shimmer');
  expect(markup).toContain('data-pending="true"');
  expect(markup).toContain('aria-live="polite"');
});

test('user message bubble does not render a username label', () => {
  const markup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: {
        id: 'msg_user',
        role: 'user',
        text: 'Hello'
      }
    })
  );

  expect(markup).not.toContain('label-mono');
  expect(markup).toContain('Hello');
});

test('rewind is available only on settled user messages', () => {
  const userMarkup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: { id: 'msg_user_rewind', role: 'user', text: 'Try again' },
      onRestore: () => {}
    })
  );
  const assistantMarkup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: { id: 'msg_assistant_rewind', role: 'assistant', text: 'Response' },
      onRestore: () => {}
    })
  );

  expect(userMarkup).toContain('Rewind to here');
  expect(assistantMarkup).not.toContain('Rewind to here');
});

test('reasoning follows appended content until the user scrolls', () => {
  const nextState = (
    ChatMessageModule as typeof ChatMessageModule & {
      nextReasoningFollowState?: (following: boolean, event: 'content-appended' | 'user-scroll') => boolean;
    }
  ).nextReasoningFollowState;

  expect(nextState?.(true, 'content-appended')).toBe(true);
  expect(nextState?.(true, 'user-scroll')).toBe(false);
  expect(nextState?.(false, 'content-appended')).toBe(false);
  expect(nextState?.(false, 'user-scroll')).toBe(false);
});

test('user message skill and command chips reuse the composer chip rendering', () => {
  const markup = renderToStaticMarkup(
    createElement(MessageBody, {
      commands: [
        {
          aliases: [],
          description: 'Show help',
          enabled: true,
          id: 'help',
          name: 'Help',
          source: 'builtin',
          type: 'action'
        },
        {
          aliases: [],
          description: 'Deploy',
          enabled: true,
          id: 'global:deploy',
          name: 'Deploy',
          source: 'custom',
          type: 'skill'
        }
      ],
      isUser: true,
      onSkillPreview: () => {},
      text: '/help with /global:deploy'
    })
  );
  const expectedClass = String(renderComposerInlineChip({ kind: 'command', label: 'Help' })[1].class);
  const commandChip = /<(?:button|span)[^>]*data-composer-chip="command"[^>]*>/.exec(markup)?.[0];
  const skillChip = /<(?:button|span)[^>]*data-composer-chip="skill"[^>]*>/.exec(markup)?.[0];

  expect(commandChip).toContain(`class="${expectedClass}"`);
  expect(skillChip).toContain(`class="${expectedClass}"`);
  expect(markup).toContain('data-composer-chip-icon="command"');
  expect(markup).toContain('data-composer-chip-icon="skill"');
  expect(
    userMessageTokens('/help with /global:deploy', [
      {
        aliases: [],
        description: 'Show help',
        enabled: true,
        id: 'help',
        name: 'Help',
        source: 'builtin',
        type: 'action'
      },
      {
        aliases: [],
        description: 'Deploy',
        enabled: true,
        id: 'global:deploy',
        name: 'Deploy',
        source: 'custom',
        type: 'skill'
      }
    ]).map(({ id, kind, label }) => ({ id, kind, label }))
  ).toEqual([
    { id: 'help', kind: 'command', label: 'Help' },
    { id: 'global:deploy', kind: 'skill', label: 'Deploy' }
  ]);
  expect(markup).not.toContain('Global');
});
