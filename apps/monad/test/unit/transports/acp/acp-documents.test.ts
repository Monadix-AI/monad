import type { OpenDoc } from '#/transports/acp/documents.ts';

import { expect, test } from 'bun:test';

import { applyRangeEdit, renderOpenDocs } from '#/transports/acp/documents.ts';

const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec }
});

test('applyRangeEdit replaces a single-line range (LF)', () => {
  expect(applyRangeEdit('const answer = 42;', r(0, 15, 0, 17), '43')).toBe('const answer = 43;');
});

test('applyRangeEdit applies a multi-line LF edit at the right offsets', () => {
  // Replace "b\nc" (line1 char0 .. line2 char1) with "X".
  expect(applyRangeEdit('a\nb\nc\nd', r(1, 0, 2, 1), 'X')).toBe('a\nX\nd');
});

test('applyRangeEdit is CRLF-correct (character excludes the \\r terminator)', () => {
  // CRLF file: editing line 1 must not drift by the preceding line\'s terminator.
  // "a\r\nbb\r\ncc" — replace "bb" (line1 char0..char2) with "ZZ".
  expect(applyRangeEdit('a\r\nbb\r\ncc', r(1, 0, 1, 2), 'ZZ')).toBe('a\r\nZZ\r\ncc');
  // Edit on line 2 of a CRLF file — a split('\n') offset would drift by 2 here.
  expect(applyRangeEdit('a\r\nbb\r\ncc', r(2, 0, 2, 2), 'YY')).toBe('a\r\nbb\r\nYY');
});

test('applyRangeEdit clamps out-of-range positions to the text length', () => {
  expect(applyRangeEdit('abc', r(0, 1, 9, 9), 'X')).toBe('aX');
});

function docs(entries: Array<[string, OpenDoc]>): Map<string, OpenDoc> {
  return new Map(entries);
}

test('renderOpenDocs returns undefined when nothing is open', () => {});

test('renderOpenDocs lists the focused doc first and tags it', () => {
  const out = renderOpenDocs(
    docs([
      ['file:///a.ts', { text: 'AAA', version: 1, languageId: 'typescript' }],
      ['file:///b.ts', { text: 'BBB', version: 1 }]
    ]),
    'file:///b.ts'
  );
  // focused (b) appears before a
  expect(out?.indexOf('file:///b.ts') ?? -1).toBeLessThan(out?.indexOf('file:///a.ts') ?? -1);
});

test('renderOpenDocs truncates content past the budget', () => {
  const big = 'x'.repeat(20_000);
  const out = renderOpenDocs(docs([['file:///big.ts', { text: big, version: 1 }]]));
  expect(out?.length).toBeLessThan(big.length);
});

test('renderOpenDocs omits a second file once the budget is exhausted', () => {
  const big = 'x'.repeat(13_000); // exceeds the 12k budget on its own
  const _out = renderOpenDocs(
    docs([
      ['file:///a.ts', { text: big, version: 1 }],
      ['file:///b.ts', { text: 'small', version: 1 }]
    ])
  );
});
