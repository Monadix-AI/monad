import type { ComponentProps, CSSProperties, ReactElement, ReactNode } from 'react';
import type { Message } from '../../src/workplace-experiences/experience/types.ts';
import type { WorkplaceExperienceHostAction } from '../../src/workplace-experiences/host-context.tsx';

import { expect, test } from 'bun:test';
import { Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageRow } from '../../src/workplace-experiences/chat-room/components/message-row.tsx';
import { SystemMessageRow } from '../../src/workplace-experiences/chat-room/components/system-message-row.tsx';

const loginPayload = {
  agentName: 'claude-code',
  projectMemberId: 'pmem_claude-code_f2654d392ff2',
  provider: 'claude-code'
};

const loginMessage: Message = {
  id: 'mesh-agent-login-required:pmem_claude-code_f2654d392ff2',
  authorId: 'pmem_claude-code_f2654d392ff2',
  authorName: 'Opus',
  av: 'OP',
  kind: 'system',
  tag: 'Claude',
  time: '',
  text: 'request sign in.',
  systemActions: [
    {
      actionId: 'mesh-agent.sign-in',
      inlineText: 'sign in',
      payload: loginPayload
    }
  ]
};

type ButtonElement = ReactElement<{
  'aria-label'?: string;
  onClick?: () => void;
  style?: CSSProperties;
  title?: string;
}>;

function findButton(node: ReactNode): ButtonElement | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    if (child.type === 'button') return child as ButtonElement;
    const nested = findButton((child.props as { children?: ReactNode }).children);
    if (nested) return nested;
  }
  return null;
}

function renderMessageRow(props: ComponentProps<typeof MessageRow>): ReactElement {
  return (MessageRow as unknown as { type: (rowProps: ComponentProps<typeof MessageRow>) => ReactElement }).type(props);
}

test('the inline sign-in action runs the existing host action with its projected payload', () => {
  let received: unknown;
  const action: WorkplaceExperienceHostAction = {
    id: 'mesh-agent.sign-in',
    label: 'Sign in',
    run: (payload) => {
      received = payload;
    }
  };
  const card = SystemMessageRow({ actions: [action], msg: loginMessage });
  const button = findButton((card.props as { body?: ReactNode }).body);
  if (!button?.props.onClick) throw new Error('expected an inline sign-in button');

  button.props.onClick();

  expect(received).toEqual(loginPayload);
});

test('the lifecycle actor avatar opens the projected agent', () => {
  let openedAgentId: string | undefined;
  const card = SystemMessageRow({
    msg: {
      ...loginMessage,
      id: 'mesh-agent-idle-suspended:pmem_claude-code_f2654d392ff2',
      text: 'fell asleep.',
      agentChip: {
        id: 'pmem_claude-code_f2654d392ff2',
        name: 'Opus',
        avatarUrl: '/avatars/opus.svg',
        tag: 'Claude'
      }
    },
    onAgentClick: (id) => {
      openedAgentId = id;
    }
  });
  const actorButton = findButton((card.props as { actor?: ReactNode }).actor);
  if (!actorButton?.props.onClick) throw new Error('expected an interactive lifecycle actor');

  actorButton.props.onClick();

  expect(openedAgentId).toBe('pmem_claude-code_f2654d392ff2');
});

test('reply actions flow below the message card and align with its content', () => {
  const message: Message = {
    id: 'msg_AGENT_REPLYABLE0000',
    authorId: 'agent_codex',
    authorName: 'Codex',
    av: 'CO',
    kind: 'agent',
    replyable: true,
    tag: 'Codex',
    time: '10:31',
    text: 'Ready for review.'
  };
  let repliedTo: Message | undefined;
  const row = renderMessageRow({
    labels: { reply: 'Reply' },
    msg: message,
    onReply: (target) => {
      repliedTo = target;
    }
  });
  const replyButton = findButton(row);
  if (!replyButton?.props.onClick) throw new Error('expected an interactive reply action');

  replyButton.props.onClick();
  const markup = renderToStaticMarkup(row);

  expect({
    actionBeforeAgentTime: markup.indexOf('Reply') < markup.indexOf('10:31'),
    repliedTo,
    timeAfterMessage: markup.indexOf('10:31') > markup.indexOf('Ready for review.')
  }).toEqual({
    actionBeforeAgentTime: true,
    repliedTo: message,
    timeAfterMessage: true
  });
});

test('human message timestamps appear before hover actions', () => {
  const row = renderMessageRow({
    labels: { reply: 'Reply' },
    msg: {
      id: 'msg_HUMAN_TIME_ORDER',
      authorId: 'user',
      authorName: 'User',
      av: 'US',
      kind: 'human',
      replyable: true,
      tag: 'User',
      time: '10:32',
      text: 'Please review.'
    },
    onReply: () => {}
  });
  const markup = renderToStaticMarkup(row);

  expect(markup.indexOf('10:32')).toBeLessThan(markup.indexOf('Reply'));
});
