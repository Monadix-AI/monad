import { expect, test } from 'bun:test';

import { findWeakAssertions } from '../../lib/weak-assertions.ts';

test('flags each weak matcher with its line and hint', () => {
  const source = [
    'expect(user).toBeDefined();',
    'expect(flag).toBeTruthy();',
    'expect(flag).toBeFalsy();',
    'expect(row).not.toBeNull();',
    "expect(screen.getByRole('button')).toBeInTheDocument();"
  ].join('\n');

  expect(findWeakAssertions(source).map((v) => ({ line: v.line, match: v.match }))).toEqual([
    { line: 1, match: '.toBeDefined()' },
    { line: 2, match: '.toBeTruthy()' },
    { line: 3, match: '.toBeFalsy()' },
    { line: 4, match: '.not.toBeNull()' },
    { line: 5, match: '.toBeInTheDocument()' }
  ]);
});

test('negated toBeInTheDocument is the RTL absence contract and passes', () => {
  const source = "expect(screen.queryByRole('dialog')).not.toBeInTheDocument();";
  expect(findWeakAssertions(source)).toEqual([]);
});

test('flags discarded underscore assignments and empty test bodies', () => {
  const source = ['const _unused = build();', "test('does nothing', () => {});"].join('\n');
  expect(findWeakAssertions(source).map((v) => v.line)).toEqual([1, 2]);
});

test('presence-ok marker with a reason waives the line, same-line or preceding', () => {
  const source = [
    'expect(record).toBeDefined(); // presence-ok: hard delete asserts the row was there first',
    '// presence-ok: redaction strips the field',
    'expect(masked.token).not.toBeUndefined();'
  ].join('\n');
  expect(findWeakAssertions(source)).toEqual([]);
});

test('presence-ok without a reason does not waive', () => {
  const source = 'expect(user).toBeDefined(); // presence-ok:';
  expect(findWeakAssertions(source).map((v) => v.match)).toEqual(['.toBeDefined()']);
});
