import { expect, test } from 'bun:test';

import {
  buildFileReadRows,
  inferFileLanguage,
  parseUnifiedDiff
} from '../../src/features/session/file-tool-preview-model.ts';

test('file read rows use built-in line prefixes and keep status notes outside the source gutter', () => {
  expect(buildFileReadRows('41\tconst one = 1;\n42\tconst two = 2;\n(partial read)', 41)).toEqual([
    { content: 'const one = 1;', kind: 'source', lineNumber: 41 },
    { content: 'const two = 2;', kind: 'source', lineNumber: 42 },
    { content: '(partial read)', kind: 'meta', lineNumber: null }
  ]);
  expect(buildFileReadRows('', undefined)).toEqual([]);
  expect(buildFileReadRows('first\nsecond', 8)).toEqual([
    { content: 'first', kind: 'source', lineNumber: 8 },
    { content: 'second', kind: 'source', lineNumber: 9 }
  ]);
  expect(buildFileReadRows('123\tliteral content\nsecond', 3)).toEqual([
    { content: '123\tliteral content', kind: 'source', lineNumber: 3 },
    { content: 'second', kind: 'source', lineNumber: 4 }
  ]);
  expect(buildFileReadRows('first', -1)).toEqual([{ content: 'first', kind: 'source', lineNumber: 1 }]);
});

test('file language inference uses the filename and falls back to plain text', () => {
  expect(inferFileLanguage('/workspace/src/view.tsx')).toBe('tsx');
  expect(inferFileLanguage('/workspace/config.yaml')).toBe('yaml');
  expect(inferFileLanguage('/workspace/Dockerfile')).toBe('dockerfile');
  expect(inferFileLanguage('/workspace/NOTICE')).toBe('text');
});

test('unified diff rows track independent old and new line numbers across hunks', () => {
  const rows = parseUnifiedDiff(
    [
      '--- a/src/view.ts',
      '+++ b/src/view.ts',
      '@@ -10,3 +10,4 @@',
      ' const stable = true;',
      '-const oldName = 1;',
      '+const newName = 1;',
      '+const added = 2;',
      ' return stable;',
      '\\ No newline at end of file',
      '@@ -30 +31 @@',
      '-oldTail();',
      '+newTail();'
    ].join('\n')
  );

  expect(rows.map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine }))).toEqual([
    { kind: 'meta', oldLine: null, newLine: null },
    { kind: 'meta', oldLine: null, newLine: null },
    { kind: 'hunk', oldLine: null, newLine: null },
    { kind: 'context', oldLine: 10, newLine: 10 },
    { kind: 'deletion', oldLine: 11, newLine: null },
    { kind: 'addition', oldLine: null, newLine: 11 },
    { kind: 'addition', oldLine: null, newLine: 12 },
    { kind: 'context', oldLine: 12, newLine: 13 },
    { kind: 'meta', oldLine: null, newLine: null },
    { kind: 'hunk', oldLine: null, newLine: null },
    { kind: 'deletion', oldLine: 30, newLine: null },
    { kind: 'addition', oldLine: null, newLine: 31 }
  ]);
});
