import type { Message } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageRow } from '../../src/workspace-experiences/chat-room/components/message-row.tsx';

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
  // presence-ok: the icon must be keyboard discoverable by its localized accessible name.
  expect(markup).toContain('aria-label="View direct message"');
  // presence-ok: the icon's hover fallback exposes exactly the text body, including its line break.
  expect(markup).toContain('title="Please review the plan.\nKeep this private."');
});
