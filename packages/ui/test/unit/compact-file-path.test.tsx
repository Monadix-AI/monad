import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CompactFilePath } from '../../src/components/CompactFilePath.tsx';

test('compact file paths split the directory from the complete filename across path formats', () => {
  const render = (path: string) => renderToStaticMarkup(<CompactFilePath path={path} />);
  const unix = render('/workspace/very/long/source/research-desk-final.md');
  const windows = render('C:\\workspace\\very\\long\\source\\research-desk-final.md');
  const parts = (markup: string) => ({
    directory: /data-slot="compact-file-path-directory"[^>]*>([^<]+)</.exec(markup)?.[1],
    fileName: /data-slot="compact-file-path-filename"[^>]*>([^<]+)</.exec(markup)?.[1]
  });

  expect([parts(unix), parts(windows)]).toEqual([
    {
      directory: '/workspace/very/long/source/',
      fileName: 'research-desk-final.md'
    },
    {
      directory: 'C:\\workspace\\very\\long\\source\\',
      fileName: 'research-desk-final.md'
    }
  ]);
});
