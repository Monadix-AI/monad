import { expect, test } from 'bun:test';

import { messageAttachmentPresentations } from '#/handlers/session/handlers/messaging-attachments.ts';

test('message attachment presentations retain display metadata and discard inline payloads', () => {
  const attachments = messageAttachmentPresentations(
    [
      {
        kind: 'image',
        name: 'diagram.png',
        mediaType: 'image/png',
        size: 4321,
        dataBase64: 'sensitive-image-payload'
      },
      {
        kind: 'text',
        name: 'notes.md',
        mediaType: 'text/markdown',
        size: 42,
        text: 'sensitive inline notes'
      },
      { kind: 'file-meta', name: 'archive.zip', mediaType: 'application/zip', size: 9000 }
    ],
    {
      createdAt: '2026-07-19T00:00:00.000Z',
      newAttachmentId: (index) => `att_TEST0000000${index}` as `att_${string}`
    }
  );

  expect(attachments).toEqual([
    {
      id: 'att_TEST00000000',
      name: 'diagram.png',
      mime: 'image/png',
      bytes: 4321,
      createdAt: '2026-07-19T00:00:00.000Z'
    },
    {
      id: 'att_TEST00000001',
      name: 'notes.md',
      mime: 'text/markdown',
      bytes: 42,
      createdAt: '2026-07-19T00:00:00.000Z'
    },
    {
      id: 'att_TEST00000002',
      name: 'archive.zip',
      mime: 'application/zip',
      bytes: 9000,
      createdAt: '2026-07-19T00:00:00.000Z'
    }
  ]);
});
