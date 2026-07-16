import { expect, test } from 'bun:test';

import { groupFailedCases, parseFailedCases } from '../../lib/test-failure-rerun.ts';

test('groups unique failed JUnit cases by file and matches nested test names by suffix', () => {
  const xml = `
    <testsuite>
      <testcase file="test/a.test.ts" name="works (tcp)"><failure /></testcase>
      <testcase file="test/a.test.ts" name="works (tcp)"><failure /></testcase>
      <testcase file="test/a.test.ts" name="works [unix]"><error /></testcase>
      <testcase file="test/b.test.ts" name="passes" />
      <testcase file="test/b.test.ts" name="fails &amp; reports"><failure /></testcase>
    </testsuite>`;

  const grouped = groupFailedCases(parseFailedCases(xml));

  expect(grouped).toEqual([
    {
      file: 'test/a.test.ts',
      names: ['works (tcp)', 'works [unix]'],
      pattern: '(?:works \\(tcp\\)|works \\[unix\\])$'
    },
    {
      file: 'test/b.test.ts',
      names: ['fails & reports'],
      pattern: '(?:fails & reports)$'
    }
  ]);
  expect('network settings > works (tcp)').toMatch(new RegExp(grouped[0]?.pattern ?? ''));
});

test('falls back to a whole-file rerun when JUnit does not expose a test name', () => {
  expect(
    groupFailedCases([
      { file: 'test/a.test.ts', name: 'named failure' },
      { file: 'test/a.test.ts', name: '(unnamed)' }
    ])
  ).toEqual([{ file: 'test/a.test.ts', names: ['named failure', '(unnamed)'] }]);
});
