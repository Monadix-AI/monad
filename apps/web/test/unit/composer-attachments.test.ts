import type { DraftMessageAttachment } from '@monad/sdk-experience/react';

import { expect, test } from 'bun:test';

import {
  composerAttachmentState,
  composerAttachmentView,
  messageAttachmentsFromSend,
  reduceComposerAttachments
} from '../../src/features/session/use-composer-attachments.ts';

const textAttachment = (localId: string, name: string): DraftMessageAttachment => ({
  kind: 'text',
  localId,
  mediaType: 'text/plain',
  name,
  size: 5,
  text: 'hello'
});

test('composer attachment state adds, removes, and resets exact draft items', () => {
  const first = textAttachment('first', 'first.txt');
  const second = textAttachment('second', 'second.txt');
  const added = reduceComposerAttachments(composerAttachmentState('ses_a'), {
    type: 'add',
    attachments: [first, second]
  });
  const removed = reduceComposerAttachments(added, { type: 'remove', localId: 'first' });

  expect({
    added: added.attachments.map((item) => item.localId),
    removed: removed.attachments.map((item) => item.localId),
    reset: reduceComposerAttachments(removed, { type: 'scope', scopeKey: 'ses_b' })
  }).toEqual({
    added: ['first', 'second'],
    removed: ['second'],
    reset: { attachments: [], error: null, scopeKey: 'ses_b' }
  });
});

test('composer attachment view exposes local image preview and openability', () => {
  const image: DraftMessageAttachment = {
    kind: 'image',
    dataBase64: 'cG5n',
    localId: 'image',
    mediaType: 'image/png',
    name: 'shot.png',
    size: 3
  };

  expect(composerAttachmentView(image)).toEqual({
    contentType: 'image/png',
    id: 'image',
    imageSrc: 'data:image/png;base64,cG5n',
    name: 'shot.png',
    openable: true,
    size: 3
  });
});

test('send attachments project to exact optimistic message metadata', () => {
  expect(
    messageAttachmentsFromSend(
      [
        {
          dataBase64: 'cG5n',
          kind: 'image',
          mediaType: 'image/png',
          name: 'shot.png',
          size: 3
        },
        {
          kind: 'file-meta',
          mediaType: 'application/zip',
          name: 'bundle.zip',
          size: 2048
        }
      ],
      {
        createdAt: '2026-07-28T09:00:00.000Z',
        newAttachmentId: (index) => (index === 0 ? 'att_123456789012' : 'att_210987654321')
      }
    )
  ).toEqual([
    {
      id: 'att_123456789012',
      bytes: 3,
      createdAt: '2026-07-28T09:00:00.000Z',
      imageSrc: 'data:image/png;base64,cG5n',
      mime: 'image/png',
      name: 'shot.png'
    },
    {
      id: 'att_210987654321',
      bytes: 2048,
      createdAt: '2026-07-28T09:00:00.000Z',
      mime: 'application/zip',
      name: 'bundle.zip'
    }
  ]);
});
