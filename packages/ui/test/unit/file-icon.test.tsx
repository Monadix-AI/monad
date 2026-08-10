import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { fileNameFromHref } from '../../src/components/FaviconLink.tsx';
import { FileIcon, fileBaseName, fileIconName } from '../../src/components/FileIcon.tsx';

test('file icon inputs preserve specific names and use MIME fallbacks only when needed', () => {
  expect([
    fileIconName({ fileName: '/workspace/src/App.tsx' }),
    fileIconName({ fileName: 'package.json', contentType: 'application/json' }),
    fileIconName({ fileName: 'preview', contentType: 'image/png' }),
    fileIconName({ fileName: '', contentType: 'text/plain; charset=utf-8' })
  ]).toEqual(['App.tsx', 'package.json', 'file.png', 'file.txt']);
});

test('file link targets resolve a filename for icon matching', () => {
  expect([
    fileNameFromHref('file:///workspace/src/App.tsx#L42'),
    fileNameFromHref('/workspace/docs/My%20File.md'),
    fileNameFromHref(undefined)
  ]).toEqual(['App.tsx', 'My File.md', 'file']);
});

test('file paths resolve their final segment across platforms', () => {
  expect([fileBaseName('/workspace/src/App.tsx'), fileBaseName('C:\\workspace\\src\\App.tsx')]).toEqual([
    'App.tsx',
    'App.tsx'
  ]);
});

test('specific source file types render distinct symbols', () => {
  const renderIcon = (fileName: string) =>
    renderToStaticMarkup(<FileIcon fileName={fileName} />).replace(/ data-file-icon="[^"]+"/, '');
  const [typescript, react, markdown] = ['index.ts', 'App.tsx', 'README.md'].map(renderIcon);

  expect([typescript === react, typescript === markdown, react === markdown]).toEqual([false, false, false]);
});
