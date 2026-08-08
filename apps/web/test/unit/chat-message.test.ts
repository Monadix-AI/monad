import type { MessageSentFrom } from '../../src/features/session/ChatMessage.tsx';

import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  Message,
  rewindEditorReducer,
  shouldRenderDirectiveAsMarkdown
} from '../../src/features/session/ChatMessage.tsx';
import { MessageBody, userMessageTokens } from '../../src/features/session/MessageBody.tsx';
import { MessageReplyPreview } from '../../src/features/session/MessageReplyPreview.tsx';
import { nextReasoningFollowState } from '../../src/features/session/reasoning-follow.ts';
import { sessionReplyHandler } from '../../src/features/session/SessionTranscript.tsx';
import { resolveSessionComposerReplyTarget } from '../../src/features/session/session-route-contract.ts';

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

  expect(markup).not.toContain('Internal reasoning details');
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

  expect(markup).toContain('agent-name-shimmer');
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

test('user message attachments render exact file metadata below the message body', () => {
  const markup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: {
        attachments: [
          {
            id: 'att_123456789012',
            name: 'bundle.zip',
            mime: 'application/zip',
            bytes: 2048,
            createdAt: '2026-07-28T09:00:00.000Z'
          }
        ],
        id: 'msg_user_attachment',
        role: 'user',
        text: 'Shared build output'
      }
    })
  );

  expect({
    composerCard: markup.includes('h-14 w-[168px]'),
    fileKind: markup.includes('data-file-icon="bundle.zip"'),
    name: markup.includes('bundle.zip'),
    size: markup.includes('2.0 KB'),
    text: markup.includes('Shared build output')
  }).toEqual({ composerCard: true, fileKind: true, name: true, size: true, text: true });
});

test('user image attachments keep the composer thumbnail treatment after sending', () => {
  const markup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: {
        attachments: [
          {
            bytes: 3,
            createdAt: '2026-07-28T09:00:00.000Z',
            id: 'att_123456789012',
            imageSrc: 'data:image/png;base64,cG5n',
            mime: 'image/png',
            name: 'shot.png'
          }
        ],
        id: 'msg_user_image',
        role: 'user',
        text: 'Use this image'
      }
    })
  );

  expect({
    image: markup.includes('src="data:image/png;base64,cG5n"'),
    name: markup.includes('shot.png'),
    removeAction: markup.includes('Remove shot.png'),
    text: markup.includes('Use this image')
  }).toEqual({ image: true, name: true, removeAction: false, text: true });
});

test('regular session messages render favicons before human and assistant URLs', () => {
  const user = renderToStaticMarkup(
    createElement(MessageBody, {
      isUser: true,
      text: 'Open https://example.com/docs.'
    })
  );
  const assistant = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: { id: 'msg_link', role: 'assistant', text: '[Example](https://example.com/docs)' }
    })
  );

  expect(user).toContain('src="https://example.com/favicon.ico"');
  expect(user).toContain('href="https://example.com/docs"');
  expect(assistant).toContain('src="https://example.com/favicon.ico"');
  expect(assistant).toContain('Example');
});

test('rewind is available only on settled user messages', () => {
  const userMarkup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: { id: 'msg_user_rewind', role: 'user', text: 'Try again' },
      onRestore: async () => true
    })
  );
  const assistantMarkup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: { id: 'msg_assistant_rewind', role: 'assistant', text: 'Response' },
      onRestore: async () => true
    })
  );

  expect(userMarkup).toContain('Rewind to here');
  expect(assistantMarkup).not.toContain('Rewind to here');
});

test('reply is available only on terminal canonical replyable messages', () => {
  const render = (msg: Parameters<typeof Message>[0]['msg']) =>
    renderToStaticMarkup(
      createElement(Message, {
        assistantLabel: 'Assistant',
        msg,
        onReply: () => {}
      })
    );

  expect(render({ id: 'msg_replyable', replyable: true, role: 'assistant', text: 'Done' })).toContain('Reply');
  expect(
    render({ id: 'msg_streaming', replyable: true, role: 'assistant', streaming: true, text: 'Writing' })
  ).not.toContain('Reply');
  expect(render({ id: 'local-pending', pending: true, replyable: true, role: 'assistant', text: '' })).not.toContain(
    'Reply'
  );
  expect(render({ id: 'msg_not_replyable', replyable: false, role: 'assistant', text: 'Event' })).not.toContain(
    'Reply'
  );
});

test('read-only session messages omit Reply while writable sessions dispatch only the message id', () => {
  const selected: string[] = [];
  const message = { id: 'msg_replyable', replyable: true, role: 'assistant' as const, text: 'Done' };
  const writableHandler = sessionReplyHandler(false, (messageId) => selected.push(messageId));
  const readOnlyHandler = sessionReplyHandler(true, (messageId) => selected.push(messageId));
  const render = (onReply: typeof writableHandler) =>
    renderToStaticMarkup(createElement(Message, { assistantLabel: 'Assistant', msg: message, onReply }));

  writableHandler?.(message);

  expect({
    readOnlyHasReply: render(readOnlyHandler).includes('Reply'),
    selected,
    writableHasReply: render(writableHandler).includes('Reply')
  }).toEqual({ readOnlyHasReply: false, selected: ['msg_replyable'], writableHasReply: true });
});

test('selected reply preview derives current content and becomes a tombstone after deletion', () => {
  const original = { id: 'msg_target', replyable: true, role: 'assistant' as const, text: 'Original target body' };
  const updated = { ...original, text: 'Current target body' };
  const resolve = (viewMessages: (typeof original)[]) =>
    resolveSessionComposerReplyTarget({
      assistantLabel: 'Assistant',
      replyTargetId: 'msg_target',
      viewMessages,
      youLabel: 'You'
    });
  const current = resolve([updated]);
  const deleted = resolve([]);
  const deletedMarkup = renderToStaticMarkup(
    createElement(MessageReplyPreview, {
      onOpen: () => {},
      target: deleted,
      unavailableLabel: 'Message unavailable'
    })
  );

  expect({
    current,
    deleted,
    hasOldBody: deletedMarkup.includes('Original target body'),
    unavailable: deletedMarkup.includes('Message unavailable')
  }).toEqual({
    current: { ...updated, label: 'Assistant' },
    deleted: null,
    hasOldBody: false,
    unavailable: true
  });
});

test('message reply preview invokes navigation only for a resolved target', () => {
  let opened = 0;
  const resolved = MessageReplyPreview({
    onOpen: () => {
      opened += 1;
    },
    target: { id: 'msg_target', label: 'Current author', role: 'assistant', text: 'Current text' },
    unavailableLabel: 'Message unavailable'
  });
  const unavailable = MessageReplyPreview({
    onOpen: () => {
      opened += 1;
    },
    target: null,
    unavailableLabel: 'Message unavailable'
  });

  resolved.props.onClick();

  expect({ opened, unavailableDisabled: unavailable.props.disabled }).toEqual({ opened: 1, unavailableDisabled: true });
});

test('rewind editor keeps the transcript unchanged until an edited message is submitted', () => {
  const editing = rewindEditorReducer({ draft: '', mode: 'idle' }, { type: 'open', text: 'Original prompt' });
  const changed = rewindEditorReducer(editing, { type: 'change', text: 'Edited prompt' });
  const cancelled = rewindEditorReducer(changed, { type: 'cancel' });
  const submitting = rewindEditorReducer(changed, { type: 'submit' });
  const retrying = rewindEditorReducer(submitting, { type: 'failed' });

  expect({ cancelled, editing, retrying, submitting }).toEqual({
    cancelled: { draft: 'Edited prompt', mode: 'idle' },
    editing: { draft: 'Original prompt', mode: 'editing' },
    retrying: { draft: 'Edited prompt', mode: 'editing' },
    submitting: { draft: 'Edited prompt', mode: 'submitting' }
  });
});

test('reasoning follows appended content until the user scrolls', () => {
  expect(nextReasoningFollowState(true, 'content-appended')).toBe(true);
  expect(nextReasoningFollowState(true, 'user-scroll')).toBe(false);
  expect(nextReasoningFollowState(false, 'content-appended')).toBe(false);
  expect(nextReasoningFollowState(false, 'user-scroll')).toBe(false);
});

test('user message tokens distinguish skill and command behavior', () => {
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
});

test('a settled user message shows its date-aware timestamp in the hover actions', () => {
  const now = new Date();
  const seq = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30).toISOString();
  const markup = renderToStaticMarkup(
    createElement(Message, {
      assistantLabel: 'Assistant',
      msg: { id: 'msg_time', role: 'user', seq, text: 'hello' }
    })
  );
  const expected = new Date(seq).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  expect(markup).toContain(expected);
});

test('a user message renders the sent-from channel badge only when the session origin provides one', () => {
  const render = (sentFrom?: MessageSentFrom) =>
    renderToStaticMarkup(
      createElement(Message, {
        assistantLabel: 'Assistant',
        msg: { id: 'msg_badge', role: 'user', text: 'hi from telegram' },
        sentFrom
      })
    );

  const withBadge = render({
    label: 'Telegram',
    details: [{ label: 'Conversation', value: 'Dev Team' }]
  });
  // The badge itself is the channel mark; its accessible name carries the source.
  expect(withBadge).toContain('Sent from Telegram');
  // behavior-ok: rendering without a resolved origin omits the badge entirely
  expect(render()).not.toContain('Sent from');
});
