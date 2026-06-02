import { expect, test } from 'bun:test';
import { MESSAGE_ATTACHMENT_BINARY_MAX_BYTES } from '@monad/protocol';

import {
  draftAttachmentBase64,
  fileToDraftAttachment,
  pastedTextDraftAttachment,
  sendableDraftAttachments
} from '../src/react/draft-attachments.ts';

test('draft attachments serialize to the exact send contract', async () => {
  const imageFile = new File(['png'], 'shot.png', { type: 'image/png' });
  const textFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  const image = await fileToDraftAttachment(imageFile);
  const text = await fileToDraftAttachment(textFile);

  expect(sendableDraftAttachments([image, text])).toEqual([
    {
      kind: 'image',
      name: 'shot.png',
      mediaType: 'image/png',
      size: 3,
      dataBase64: 'cG5n'
    },
    {
      kind: 'text',
      name: 'notes.txt',
      mediaType: textFile.type,
      size: 5,
      text: 'hello'
    }
  ]);
});

test('oversized inline text files upload their contents as binary files', async () => {
  const file = new File([new Uint8Array(512_001)], 'large.txt', { type: 'text/plain' });

  expect(sendableDraftAttachments([await fileToDraftAttachment(file)])).toEqual([
    {
      kind: 'file',
      name: 'large.txt',
      mediaType: file.type,
      size: 512_001,
      dataBase64: expect.any(String)
    }
  ]);
});

test('binary files are uploaded instead of degrading to metadata', async () => {
  const file = new File(['mp4'], '2.mp4', { type: 'video/mp4' });

  expect(sendableDraftAttachments([await fileToDraftAttachment(file)])).toEqual([
    {
      kind: 'file',
      name: '2.mp4',
      mediaType: 'video/mp4',
      size: 3,
      dataBase64: 'bXA0'
    }
  ]);
});

test('files beyond the upload limit fail instead of appearing as metadata-only attachments', async () => {
  const file = new File([new Uint8Array(MESSAGE_ATTACHMENT_BINARY_MAX_BYTES + 1)], 'too-large.mp4', {
    type: 'video/mp4'
  });

  expect(fileToDraftAttachment(file)).rejects.toThrow(
    `attachment exceeds ${MESSAGE_ATTACHMENT_BINARY_MAX_BYTES} bytes`
  );
});

test('pasted text is capped to the attachment byte limit with an explicit notice', () => {
  const attachment = pastedTextDraftAttachment('x'.repeat(512_001));
  const payload = sendableDraftAttachments([attachment]);

  expect({
    hasTruncationNotice:
      payload[0]?.kind === 'text' && payload[0].text.endsWith('[truncated: pasted text exceeded 512000 bytes]'),
    kind: payload[0]?.kind,
    name: payload[0]?.name,
    size: payload[0]?.size
  }).toEqual({
    hasTruncationNotice: true,
    kind: 'text',
    name: 'Pasted',
    size: 512_000
  });
});

test('draft preview bytes preserve text, image, and metadata-only local files', async () => {
  const text = await fileToDraftAttachment(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
  const image = await fileToDraftAttachment(new File(['png'], 'shot.png', { type: 'image/png' }));
  const metadata = await fileToDraftAttachment(new File(['zip'], 'bundle.zip', { type: 'application/zip' }));

  expect(
    await Promise.all([draftAttachmentBase64(text), draftAttachmentBase64(image), draftAttachmentBase64(metadata)])
  ).toEqual(['aGVsbG8=', 'cG5n', 'emlw']);
});
