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

test('direct-message system rows localize the event and expose text from an accessible detail icon', () => {
  const message: Message = {
    id: 'msg_DM_EVENT0000',
    authorId: 'monad',
    authorName: 'Monad',
    av: 'MO',
    kind: 'system',
    tag: 'SYS',
    time: '10:30',
    text: 'codex sent claude a DM.',
    directMessage: {
      fromAgentName: 'Lily',
      toAgentName: 'Steve',
      text: 'Please review the plan.\nKeep this private.'
    }
  };

  const markup = renderToStaticMarkup(
    <MessageRow
      labels={{
        directMessageContent: 'View direct message',
        directMessageSent: (from, to) => `${from} sent ${to} a DM.`
      }}
      msg={message}
    />
  );

  // presence-ok: the localized event sentence is the user-visible DM event contract.
  expect(markup).toContain('Lily sent Steve a DM.');
  // presence-ok: rendering the event exposes an accessible, localized hover trigger.
  expect(markup).toContain('aria-label="View direct message"');
  expect(markup).toContain('title="Please review the plan.\nKeep this private."');
});

test('collapsed system messages render a placeholder with an accessible detail trigger', () => {
  const message: Message = {
    id: 'msg_COMMAND_REPLY',
    authorId: 'command',
    authorName: 'Command',
    av: 'CMD',
    kind: 'system',
    tag: 'SYS',
    time: '',
    text: '',
    systemDetail: 'Sessions:\n1. Project session',
    systemPresentation: 'detail-tooltip'
  };
  const card = SystemMessageRow({
    labels: { systemMessage: 'System message', systemMessageDetails: 'View system message' },
    msg: message
  });
  const body = (card.props as { body?: ReactNode }).body;
  if (!isValidElement(body)) throw new Error('expected a system message detail placeholder');
  const button = findButton(body);

  expect({
    ariaLabel: button?.props['aria-label'],
    markup: renderToStaticMarkup(body),
    title: button?.props.title
  }).toEqual({
    ariaLabel: 'View system message',
    markup: expect.stringContaining(
      'data-slot="system-message-detail-placeholder"><span aria-hidden="true" class="h-px w-8 bg-border"></span><span class="text-muted-foreground text-xs">System message</span>'
    ),
    title: 'Sessions:\n1. Project session'
  });
});

test('login-required system rows render the sign-in action inside the sentence as ghost text', () => {
  const markup = renderToStaticMarkup(
    <MessageRow
      actions={[{ id: 'mesh-agent.sign-in', label: 'Sign in', run: () => {} }]}
      msg={loginMessage}
    />
  );

  // biome-ignore lint/plugin: rendering the login-required event produces the exact interactive sentence
  expect(markup).toMatch(/request <button[^>]*>sign in<\/button>\./);
  expect(markup).not.toContain('border border-border bg-card');
});

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
