import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AttachmentCard } from '../../src/components/AttachmentCard.tsx';

test('metadata-only attachment cards do not offer unavailable actions', () => {
  const markup = renderToStaticMarkup(
    <AttachmentCard
      mime="application/zip"
      name="archive.zip"
      previewable={false}
      sizeLabel="8.8 KB"
    />
  );

  // presence-ok: metadata-only browser uploads have no daemon file reference to preview or download.
  expect(markup.match(/<button/g) ?? []).toHaveLength(0);
});
