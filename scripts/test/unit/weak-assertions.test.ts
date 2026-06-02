import { expect, test } from 'bun:test';

import { findWeakAssertions } from '../../lib/weak-assertions.ts';

test('flags an exact layout snapshot stored before the assertion', () => {
  const source = [
    'const geometry = await item.evaluate((node) => ({',
    '  radius: getComputedStyle(node).borderTopRightRadius,',
    '  rightDelta: node.getBoundingClientRect().right',
    '}));',
    "expect(geometry).toEqual({ radius: '0px', rightDelta: 9 });"
  ].join('\n');

  expect(findWeakAssertions(source).map((violation) => violation.line)).toEqual([5]);
});
