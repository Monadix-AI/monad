import { expect, test } from 'bun:test';

import { parseUnifiedDiff } from '../../src/components/unified-diff-model.ts';

const diff = [
  '@@ -3,2 +3,2 @@',
  '-This directory ships prebuilt binaries.',
  '-Each is built from monad source.',
  "+This directory holds the VM backend's prebuilt binaries.",
  '+Each is built from a pinned source.'
].join('\n');

test('unified diff parsing produces line numbers and word-level change ranges', () => {
  const rows = parseUnifiedDiff(diff);
  const changedText = rows
    .filter((row) => row.changedRanges)
    .map((row) => ({
      kind: row.kind,
      line: row.newLine ?? row.oldLine,
      ranges: row.changedRanges?.map((range) => row.code.slice(range.start, range.end))
    }));

  expect(changedText).toEqual([
    { kind: 'deletion', line: 3, ranges: ['ships'] },
    { kind: 'deletion', line: 4, ranges: ['monad'] },
    { kind: 'addition', line: 3, ranges: ["holds the VM backend's"] },
    { kind: 'addition', line: 4, ranges: ['a pinned'] }
  ]);
});
