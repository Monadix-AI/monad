import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AttachmentCard } from '../../src/components/AttachmentCard.tsx';

test('image attachment renders preview and download actions without an inline thumbnail', () => {
  const markup = renderToStaticMarkup(
    createElement(AttachmentCard, {
      downloadLabel: 'Download',
      mime: 'image/png',
      name: 'research-desk.png',
      onDownload: () => {},
      onPreview: () => {},
      previewLabel: 'View',
      previewable: true,
      sizeLabel: '24 KB'
    })
  );

  // behavior-ok: image attachments expose explicit actions without expanding the transcript with a thumbnail.
  expect({
    actionsOutside: markup.indexOf('data-attachment-row="actions"') > markup.indexOf('data-attachment-row="identity"'),
    capsuleIsPreviewButton:
      markup.includes('<button') && markup.indexOf('<button') < markup.indexOf('data-attachment-row="actions"'),
    agentTone: markup.includes('data-attachment-tone="agent"'),
    metadata: markup.includes('research-desk.png') && markup.includes('24 KB'),
    noThumbnail: !markup.includes('<img'),
    noShadow: !markup.includes('shadow-'),
    actions: markup.includes('View') && markup.includes('Download')
  }).toEqual({
    actions: true,
    actionsOutside: true,
    agentTone: true,
    capsuleIsPreviewButton: true,
    metadata: true,
    noShadow: true,
    noThumbnail: true
  });
});

test('human attachment renders as one pill preview target without separate actions', () => {
  const markup = renderToStaticMarkup(
    createElement(AttachmentCard, {
      downloadLabel: 'Download',
      mime: 'application/pdf',
      name: 'Monad-Build-Attention.pdf',
      onDownload: () => {},
      onPreview: () => {},
      previewLabel: 'View',
      previewable: true,
      sizeLabel: '42 KB',
      tone: 'human'
    })
  );

  // behavior-ok: the human attachment exposes the whole pill as its preview target instead of nested actions.
  expect({
    actionRows: markup.match(/data-attachment-row=/g)?.length ?? 0,
    cardElement: markup.startsWith('<button'),
    humanTone: markup.includes('data-attachment-tone="human"'),
    label: markup.includes('Monad-Build-Attention.pdf')
  }).toEqual({ actionRows: 0, cardElement: true, humanTone: true, label: true });
});
