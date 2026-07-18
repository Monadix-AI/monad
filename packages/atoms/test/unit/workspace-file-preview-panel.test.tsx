import type { MessageAttachmentRef } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FilePreviewContent,
  inferPreviewLanguage
} from '../../src/workspace-experiences/chat-room/components/file-preview-panel.tsx';

const attachment = {
  id: 'att_100000000000',
  path: '/workspace/report.ts',
  name: 'report.ts',
  mime: 'application/typescript',
  bytes: 42,
  createdAt: '2026-07-18T00:00:00.000Z'
} as MessageAttachmentRef;

test('file preview infers syntax languages from filenames', () => {
  expect([
    inferPreviewLanguage('/workspace/report.ts'),
    inferPreviewLanguage('/workspace/config.yaml'),
    inferPreviewLanguage('/workspace/README.unknown')
  ]).toEqual(['typescript', 'yaml', 'text']);
});

test('file preview renders numbered source, focused line, and truncation status', () => {
  const markup = renderToStaticMarkup(
    createElement(FilePreviewContent, {
      attachment,
      content: 'const answer = 42;\nexport { answer };',
      focusLine: 2,
      truncated: true,
      truncatedLabel: 'Preview truncated'
    })
  );

  expect(markup).toContain('data-language="typescript"');
  expect(markup).toContain('data-preview-line="1"');
  expect(markup).toContain('data-preview-line="2"');
  expect(markup).toContain('data-focus-line="true"');
  expect(markup).toContain('Preview truncated');
});
