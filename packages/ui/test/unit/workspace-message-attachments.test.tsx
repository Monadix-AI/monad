import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { WorkspaceMessageCard } from '../../src/components/WorkspaceMessageCard.tsx';

function renderMessage(tone: 'agent' | 'human'): string {
  return renderToStaticMarkup(
    createElement(WorkspaceMessageCard, {
      align: tone === 'agent' ? 'start' : 'end',
      attachments: createElement('span', null, 'attachment-marker'),
      avatar: createElement('span', null, 'avatar'),
      body: createElement('span', null, 'body-marker'),
      header: createElement('span', null, 'header'),
      tone
    })
  );
}

test('message attachments follow the role-specific bubble order', () => {
  const agent = renderMessage('agent');
  const human = renderMessage('human');

  // behavior-ok: rendering each message role places its attachment on the requested side of the body bubble.
  expect({
    agentAttachmentAfterBody: agent.indexOf('attachment-marker') > agent.indexOf('body-marker'),
    agentAlignment: agent.includes('data-message-attachments="agent"') && agent.includes('items-start'),
    humanAttachmentBeforeBody: human.indexOf('attachment-marker') < human.indexOf('body-marker'),
    humanAlignment: human.includes('data-message-attachments="human"') && human.includes('items-end')
  }).toEqual({
    agentAttachmentAfterBody: true,
    agentAlignment: true,
    humanAttachmentBeforeBody: true,
    humanAlignment: true
  });
});
