import type { DraftMessageAttachment } from '@monad/sdk-experience/react';

import { expect, test } from 'bun:test';

import { attachmentMediaType } from '../../src/workplace-experiences/chat-room/components/composer/attachments.tsx';

test('composer attachment previews preserve media types for every send attachment kind', () => {
  const attachments: DraftMessageAttachment[] = [
    {
      kind: 'image',
      dataBase64: 'cG5n',
      localId: 'image',
      mediaType: 'image/png',
      name: 'shot.png',
      size: 3
    },
    {
      kind: 'text',
      localId: 'text',
      mediaType: 'text/plain',
      name: 'notes.txt',
      size: 5,
      text: 'hello'
    },
    {
      kind: 'file-meta',
      localId: 'meta',
      mediaType: 'application/zip',
      name: 'bundle.zip',
      size: 100
    }
  ];

  expect(attachments.map(attachmentMediaType)).toEqual(['image/png', 'text/plain', 'application/zip']);
});
