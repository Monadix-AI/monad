import { expect, test } from 'bun:test';

import { inferPreviewLanguage } from '../../src/workplace-experiences/chat-room/components/file-preview-panel.tsx';

test('file preview infers syntax languages from filenames', () => {
  expect([
    inferPreviewLanguage('/workspace/report.ts'),
    inferPreviewLanguage('/workspace/config.yaml'),
    inferPreviewLanguage('/workspace/README.unknown')
  ]).toEqual(['typescript', 'yaml', 'text']);
});
