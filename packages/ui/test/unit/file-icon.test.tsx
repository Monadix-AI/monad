import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileIcon } from '../../src/components/FileIcon.tsx';

test('FileIcon selects semantic code and image icons from extension and MIME', () => {
  const code = renderToStaticMarkup(createElement(FileIcon, { fileName: 'index.ts' }));
  const image = renderToStaticMarkup(createElement(FileIcon, { contentType: 'image/png', fileName: 'asset.bin' }));

  expect(code).toContain('data-file-icon="code"');
  expect(image).toContain('data-file-icon="image"');
});

test('FileIcon falls back to a generic file icon', () => {
  const markup = renderToStaticMarkup(createElement(FileIcon, { fileName: 'artifact.unknown' }));

  expect(markup).toContain('data-file-icon="file"');
  expect(markup).toContain('aria-hidden="true"');
});
