import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CompactFilePath } from '../../src/components/CompactFilePath.tsx';

test('compact file paths truncate only the directory across path formats', () => {
  const render = (path: string) => renderToStaticMarkup(<CompactFilePath path={path} />);
  const unix = render('/workspace/very/long/source/research-desk-final.md');
  const windows = render('C:\\workspace\\very\\long\\source\\research-desk-final.md');
  const layout = (markup: string) => {
    const directoryTag = /<span[^>]*data-slot="compact-file-path-directory"[^>]*>/.exec(markup)?.[0];
    const fileNameTag = /<span[^>]*data-slot="compact-file-path-filename"[^>]*>/.exec(markup)?.[0];
    return {
      directoryCanShrink: directoryTag?.includes('min-w-0 truncate'),
      fileName: /data-slot="compact-file-path-filename"[^>]*>([^<]+)</.exec(markup)?.[1],
      fileNameDoesNotShrink: fileNameTag?.includes('shrink-0')
    };
  };

  // behavior-ok: rendering either path format applies truncation to its directory and preserves the complete filename.
  expect([layout(unix), layout(windows)]).toEqual([
    { directoryCanShrink: true, fileName: 'research-desk-final.md', fileNameDoesNotShrink: true },
    { directoryCanShrink: true, fileName: 'research-desk-final.md', fileNameDoesNotShrink: true }
  ]);
});
