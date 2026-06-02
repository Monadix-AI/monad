import { expect, test } from 'bun:test';

import { composerAttachmentRows } from '../../src/components/ComposerAttachmentStrip.tsx';

test('composer attachment rows preserve identity, actions, and formatted size', () => {
  expect(
    composerAttachmentRows([
      {
        contentType: 'text/plain',
        id: 'local-1',
        name: 'notes.txt',
        openable: true,
        size: 5
      },
      {
        contentType: 'application/zip',
        id: 'local-2',
        name: 'bundle.zip',
        openable: false,
        size: 2_048
      }
    ])
  ).toEqual([
    {
      contentType: 'text/plain',
      id: 'local-1',
      imageSrc: undefined,
      name: 'notes.txt',
      openable: true,
      sizeLabel: '5 B'
    },
    {
      contentType: 'application/zip',
      id: 'local-2',
      imageSrc: undefined,
      name: 'bundle.zip',
      openable: false,
      sizeLabel: '2.0 KB'
    }
  ]);
});
