import type { ComponentProps, CSSProperties, ReactElement, ReactNode } from 'react';
import type { Message } from '../../src/workplace-experiences/experience/types.ts';
import type { WorkplaceExperienceHostAction } from '../../src/workplace-experiences/host-context.tsx';

import { expect, test } from 'bun:test';
import { Children, isValidElement } from 'react';

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
  className?: string;
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

  expect(repliedTo).toEqual(message);
});
