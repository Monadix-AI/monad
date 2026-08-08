import { expect, test } from 'bun:test';

import { workdirLabel } from '../../src/features/workplace/project-shell/project-header-utils';

test('workdir label uses the last path segment', () => {
  expect(workdirLabel('/Users/test/Projects/monad/', 'Set folder')).toBe('monad');
  expect(workdirLabel('C:\\Users\\test\\monad', 'Set folder')).toBe('monad');
  expect(workdirLabel(undefined, 'Set folder')).toBe('Set folder');
});
