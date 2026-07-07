import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AttachmentPreviewStrip,
  type DraftAttachment
} from '../../src/workspace-experiences/chat-room/components/composer/attachments.tsx';

test('AttachmentPreviewStrip renders image draft attachments as inline image previews', () => {
  const attachment: DraftAttachment = {
    dataBase64: 'iVBORw0KGgo=',
    kind: 'image',
    localId: 'draft-image-1',
    mediaType: 'image/png',
    name: 'mockup.png',
    size: 12
  };

  const html = renderToStaticMarkup(
    createElement(AttachmentPreviewStrip, {
      attachments: [attachment],
      onOpen: () => {},
      onRemove: () => {}
    })
  );

  expect(html).toContain('<img');
  expect(html).toContain('data-rmiz');
  expect(html).toContain('alt="Preview of mockup.png"');
  expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
});
