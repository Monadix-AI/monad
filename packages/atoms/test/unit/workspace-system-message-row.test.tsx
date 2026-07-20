import type { Message } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageRow } from '../../src/workspace-experiences/chat-room/components/message-row.tsx';

test('direct-message system rows localize the event and never expose the message body', () => {
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
      toAgentName: 'Steve'
    }
  };

  const markup = renderToStaticMarkup(
    <MessageRow
      labels={{
        directMessageSent: (from, to) => `${from} sent ${to} a DM.`
      }}
      msg={message}
    />
  );

  // presence-ok: the localized event sentence is the user-visible DM event contract.
  expect(markup).toContain('Lily sent Steve a DM.');
  // A DM's content is participant-only — the room's transcript must never carry it, in a
  // tooltip, title, or otherwise.
  expect(markup).not.toContain('Please review');
  expect(markup).not.toContain('title=');
});
